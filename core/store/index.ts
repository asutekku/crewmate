/**
 * Public facade and compatibility methods for the agent-presence stores: who
 * is working in this repo, what they are doing, and their shared message log.
 *
 * WHY SQLITE AND NOT A MARKDOWN FILE: 3-4 agents run concurrently here, and a
 * read-modify-write of one `.md` is a lost-update race — two sessions read the
 * same text and the second write erases the first's line. That is precisely the
 * failure this is meant to prevent, so the store has to serialise writes itself.
 * `bun:sqlite` ships with Bun (no dependency to add) and WAL mode lets every
 * reader proceed while one writer commits, so a hook never blocks on a peer.
 *
 * THE CURSOR IS THE DELIVERY MODEL: `messages.id` is monotonic and each session
 * stores the last id it has been shown. "Unread" is `id > last_read_id`, so
 * delivery is a range read followed by advancing one integer. No per-recipient
 * fan-out, no acknowledgements, and a session that never reads simply has a
 * stale cursor rather than a growing queue of its own.
 *
 * ADVISORY ONLY: nothing here can stop another agent from editing a file. A
 * claim is a published intention, which is what makes an overlap *visible*;
 * enforcement would mean blocking a tool call, and a wedged agent is worse than
 * a conflict someone can see and talk about.
 */

import { Database } from "bun:sqlite";

import { WorkStore } from "../work.ts";
import { DiaryStore } from "../diary.ts";
import { QuestionStore } from "../questions.ts";
import { ObligationStore } from "../obligations.ts";
import { collectStats } from "../stats.ts";
import type { Stats } from "../stats.ts";
import { openDb } from "./schema.ts";
import { liveConversations, OwnershipStore, projectTranscriptDir } from "./ownership.ts";
import { ActivityStore } from "./activity.ts";
import { hasUnreadMessages, MessageStore, type StoreDiagnostic } from "./messages.ts";
import { InjectionStore, type FeatureEventInput } from "./injection.ts";
import { SessionStore } from "./sessions.ts";
import {
  CLAIM_REANNOUNCE_MS,
  CLAIM_TTL_MS,
  EDIT_KEEP_MS,
  MAX_MESSAGES,
  MINION_KEEP_MS,
  MINION_STALE_MS,
  STALE_MS,
  displayName,
} from "./types.ts";
import type {
  Claim,
  InjectionLedgerRow,
  InjectionOmitted,
  InjectionShown,
  Message,
  MessageKind,
  Minion,
  Session,
} from "./types.ts";

export * from "./types.ts";
export { ActivityStore, InjectionStore, MessageStore, SessionStore };
export type { StoreDiagnostic };

/**
 * "Anything at all for this session?" on the PostToolBatch path, which fires
 * many times a turn: a read-only open and one indexed query, never a transaction.
 */
export function hasUnread(
  dbPath: string,
  sessionId: string,
  diagnostic?: (event: StoreDiagnostic) => void,
): boolean {
  return hasUnreadMessages(dbPath, sessionId, diagnostic);
}

/**
 * Every hook is a short-lived process: open, do one unit of work, close. The
 * `finally` matters because a leaked WAL handle stops -wal checkpointing.
 */
export function withStore<T>(
  dbPath: string,
  fn: (s: Store) => T,
  /** Repo root, for the transcript dir that decides name ownership. Omitted
   * by read-only callers, where the readdir would answer nothing. */
  projectRoot = "",
): T {
  const db = openDb(dbPath);
  try {
    const result = fn(new Store(db, projectRoot));
    if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result) {
      throw new TypeError("withStore callback must be synchronous");
    }
    return result;
  } finally {
    db.close();
  }
}

export class Store {
  readonly activity: ActivityStore;
  readonly injection: InjectionStore;
  readonly messages: MessageStore;
  readonly sessions: SessionStore;

  // Separate classes because each owns a different notion of "expired": work
  // outlives the STALE_MS sweep, the diary keeps entries for a year.
  readonly work: WorkStore;
  readonly diary: DiaryStore;
  readonly questions: QuestionStore;
  readonly obligations: ObligationStore;

  /** Which conversation owns which name. See `ownership.ts`. */
  readonly owners: OwnershipStore;
  private readonly transcriptDirPath: string;

  // Sub-stores are stateless wrappers over the one connection: built once, not
  // per access, so `store.work` is a field read rather than an allocation.
  constructor(private readonly db: Database, projectRoot = "") {
    this.activity = new ActivityStore(db, MINION_STALE_MS, STALE_MS);
    this.injection = new InjectionStore(db);
    this.messages = new MessageStore(db, MAX_MESSAGES, CLAIM_REANNOUNCE_MS);
    this.transcriptDirPath = projectRoot === "" ? "" : projectTranscriptDir(projectRoot);
    this.sessions = new SessionStore(db, STALE_MS, this.transcriptDirPath);
    this.owners = new OwnershipStore(db);
    this.work = new WorkStore(db);
    this.diary = new DiaryStore(db);
    this.questions = new QuestionStore(db);
    this.obligations = new ObligationStore(db, (input) => this.recordFeatureEvent(input));
  }

  /**
   * Records a work consequence and, for breaking changes, atomically notifies
   * live peers who edited at least one of the same paths during the window.
   */
  recordWorkFlag(input: {
    readonly workId: number;
    readonly kind: "breaks" | "needs";
    readonly text: string;
    readonly subject: string;
    readonly senderSessionId: string;
    readonly senderName: string;
    readonly sinceMs: number;
    readonly nowMs: number;
  }): readonly string[] {
    const run = this.db.transaction((): readonly string[] => {
      this.work.record(input.workId, input.kind, input.text, input.nowMs);
      if (input.kind !== "breaks") return [];
      const edits = this.db.query(`SELECT DISTINCT session_id, path FROM edits WHERE ts_ms > ?`).all(input.sinceMs) as Array<{
        session_id: string;
        path: string;
      }>;
      const ownPaths = new Set(edits.filter((edit) => edit.session_id === input.senderSessionId).map((edit) => edit.path));
      const affected = new Set(
        edits.filter((edit) => edit.session_id !== input.senderSessionId && ownPaths.has(edit.path)).map((edit) => edit.session_id),
      );
      const reached: string[] = [];
      for (const peer of this.liveSessions(input.nowMs)) {
        if (!affected.has(peer.sessionId)) continue;
        const name = displayName(peer);
        this.post(input.senderName, "breaks", `${input.text} (in "${input.subject}")`, input.nowMs, { sessionId: peer.sessionId, name });
        reached.push(name);
      }
      return reached;
    });
    return run.immediate();
  }

  /** Everything `crew stats` reports; its aggregates cut across every table here. */
  stats(memories: number, topAgents?: number): Stats {
    return collectStats(this.db, memories, topAgents);
  }

  /** Sessions seen recently enough to be plausibly alive, oldest first. */
  liveSessions(nowMs: number): Session[] {
    return this.sessions.live(nowMs);
  }
  register(sessionId: string, worktree: string, branch: string, nowMs: number): string {
    return this.sessions.register(sessionId, worktree, branch, nowMs);
  }
  touch(sessionId: string, nowMs: number): void {
    this.sessions.touch(sessionId, nowMs);
  }
  handleFor(sessionId: string): string | null {
    return this.sessions.handleFor(sessionId);
  }
  registerAndRestore(sessionId: string, worktree: string, branch: string, nowMs: number): string {
    const handle = this.register(sessionId, worktree, branch, nowMs);
    this.restoreAlias(sessionId, nowMs);
    return handle;
  }

  handleForOrRegister(sessionId: string, worktree: string, branch: string, nowMs: number): string {
    return this.handleFor(sessionId) ?? this.register(sessionId, worktree, branch, nowMs);
  }

  /**
   * Corrects the recorded working tree.
   *
   * Separate from `register` because it must NOT touch the handle or the read
   * cursor: this runs on a hot-ish path (every edit) purely to keep the tree
   * honest, and re-registering there would be a much bigger hammer.
   */
  setWorktree(sessionId: string, worktree: string, branch: string): void {
    this.sessions.setWorktree(sessionId, worktree, branch);
  }
  setBaseDistance(sessionId: string, behind: number, base: string): void {
    this.sessions.setBaseDistance(sessionId, behind, base);
  }
  setLineage(sessionId: string, from: string): void {
    this.sessions.setLineage(sessionId, from);
  }
  liveHolder(lineage: string, nowMs: number): Session | null {
    return this.sessions.liveHolder(lineage, nowMs);
  }
  setCodeVersion(
    sessionId: string,
    version: string,
    features: readonly string[] = [],
    nowMs: number,
    featureSetVersion = 0,
  ): void {
    this.injection.setCodeVersion(sessionId, version, features, nowMs, featureSetVersion);
  }
  recordFeatureEvent(input: FeatureEventInput): void {
    this.injection.recordFeatureEvent(input);
  }
  /** Session id → the build it loaded, for the roster's skew warning. */
  codeVersions(): Map<string, string> {
    return this.injection.codeVersions();
  }
  /** The tree currently recorded, so a caller can skip a no-op correction. */
  worktreeOf(sessionId: string): string | null {
    return this.sessions.worktreeOf(sessionId);
  }
  setIntent(sessionId: string, intent: string): void {
    this.sessions.setIntent(sessionId, intent);
  }
  setAlias(sessionId: string, alias: string, nowMs: number): string | null {
    return this.sessions.setAlias(sessionId, alias, nowMs);
  }
  setRole(sessionId: string, role: string): void {
    this.sessions.setRole(sessionId, role);
  }
  setTitle(sessionId: string, title: string): void {
    this.sessions.setTitle(sessionId, title);
  }
  restoreAlias(sessionId: string, nowMs: number): string | null {
    return this.sessions.restoreAlias(sessionId, nowMs);
  }
  setTranscript(sessionId: string, path: string): void {
    this.sessions.setTranscript(sessionId, path);
  }
  transcriptOf(sessionId: string): string {
    return this.sessions.transcriptOf(sessionId);
  }
  setSummary(sessionId: string, summary: string, nowMs: number): void {
    this.sessions.setSummary(sessionId, summary, nowMs);
  }
  staleSummarySessions(nowMs: number, ttlMs: number): Array<{ sessionId: string; path: string }> {
    return this.sessions.staleSummaries(nowMs, ttlMs);
  }
  setBlocked(sessionId: string, blocked: string): void {
    this.sessions.setBlocked(sessionId, blocked);
  }
  syncAgents(agents: ReadonlyArray<{ sessionId: string; name: string; status: string }>): void {
    this.sessions.syncAgents(agents);
  }
  findByName(query: string, nowMs: number): Session | null {
    return this.sessions.findByName(query, nowMs);
  }
  findBySession(sessionId: string): Session | null {
    return this.sessions.findBySession(sessionId);
  }
  unregister(sessionId: string, nowMs = Date.now()): void {
    const unregister = this.db.transaction(() => this.sessions.unregister(sessionId, nowMs));
    unregister.immediate();
  }
  departSession(sessionId: string, nowMs: number): boolean {
    const run = this.db.transaction(() => {
      const session = this.findBySession(sessionId);
      if (!session) return false;
      this.post(session.handle, "done", "left the roster", nowMs);
      this.sessions.unregister(sessionId, nowMs);
      return true;
    });
    return run.immediate();
  }

  /**
   * Appends a message. `to` scopes delivery to one session; omit it to
   * broadcast. Display names are captured now, not resolved later.
   */
  post(handle: string, kind: MessageKind, body: string, nowMs: number, to?: { readonly sessionId: string; readonly name: string }): void {
    // `alias` is selected here or a renamed agent's messages go out under its
    // old name — and `from_name` is FROZEN at send time, so the log would carry
    // the wrong sender forever rather than merely displaying it once.
    this.messages.post(handle, kind, body, nowMs, to);
  }

  /** Atomically establishes the caller identity when needed and posts as it. */
  postFromCaller(input: {
    readonly sessionId: string;
    readonly projectRoot: string;
    readonly kind: MessageKind;
    readonly body: string;
    readonly nowMs: number;
    readonly to?: { readonly sessionId: string; readonly name: string };
  }): { readonly handle: string; readonly label: string } {
    const run = this.db.transaction(() => {
      if (input.sessionId === "") {
        this.post("human", input.kind, input.body, input.nowMs, input.to);
        return { handle: "human", label: "you" };
      }
      const current = this.findBySession(input.sessionId);
      const handle = current?.handle ?? this.handleForOrRegister(input.sessionId, input.projectRoot, "", input.nowMs);
      const label = current ? displayName(current) : handle;
      this.post(handle, input.kind, input.body, input.nowMs, input.to);
      return { handle, label };
    });
    return run.immediate();
  }

  drainDirected(sessionId: string): Message[] {
    return this.messages.drainDirected(sessionId);
  }
  drainUnread(sessionId: string): Message[] {
    return this.messages.drainUnread(sessionId);
  }
  /** Last few log lines regardless of cursor — the joining-a-room summary. */
  recent(limit: number, forSession?: string): Message[] {
    return this.messages.recent(limit, forSession);
  }

  /** Mirrors a task from a session's private list onto the shared board. */
  upsertTask(sessionId: string, taskId: string, subject: string, nowMs: number): void {
    this.activity.upsertTask(sessionId, taskId, subject, nowMs);
  }

  completeTask(sessionId: string, taskId: string, nowMs: number): void {
    this.activity.completeTask(sessionId, taskId, nowMs);
  }

  taskCounts(): Map<string, { open: number; done: number }> {
    return this.activity.taskCounts();
  }

  lastDoneMs(handle: string, sinceMs = 0): number {
    return this.messages.lastDoneMs(handle, sinceMs);
  }

  /**
   * True when this session already announced an overlap on `path` recently.
   *
   * Matched on the path inside the body rather than a separate column: the
   * message log is the record of what was said, and "did I already say this"
   * is a question about that record.
   */
  announcedOverlapRecently(handle: string, path: string, nowMs: number): boolean {
    return this.messages.announcedOverlapRecently(handle, path, nowMs);
  }

  /**
   * Records an edit: the live claim, and the permanent history row.
   *
   * BOTH FROM ONE CALL, so the two cannot drift — a claim written without its
   * history row is an edit that blame will never see, and there is no way to
   * notice that afterwards.
   *
   * The `tool`/`worktree` arguments are optional so the older two-argument form
   * still works; a caller that omits them loses only detail, never the row.
   */
  claim(
    sessionId: string,
    path: string,
    nowMs: number,
    detail?: { readonly tool?: string; readonly worktree?: string; readonly branch?: string },
  ): void {
    this.activity.claim(sessionId, path, nowMs, detail);
  }

  editsBy(
    sessionId: string,
    sinceMs: number,
    limit = 200,
  ): Array<{ path: string; tsMs: number; worktree: string; tool: string; count: number }> {
    return this.activity.editsBy(sessionId, sinceMs, limit);
  }

  /**
   * Who has touched a path, most recent first — blame, at file granularity.
   *
   * NOT deduplicated: the whole question is the sequence, and two agents
   * alternating on one file is exactly the thing worth seeing.
   */
  editsOf(path: string, limit = 50): Array<{ agent: string; sessionId: string; tsMs: number; worktree: string; tool: string }> {
    return this.activity.editsOf(path, limit);
  }

  editAgents(sinceMs: number): Array<{ agent: string; sessionId: string; lastMs: number }> {
    return this.activity.editAgents(sinceMs);
  }

  startMinion(agentId: string, sessionId: string, nowMs: number, opts: { task?: string; agentType?: string } = {}): number {
    return this.activity.startMinion(agentId, sessionId, nowMs, opts);
  }

  endMinion(agentId: string, nowMs: number, task?: string): void {
    this.activity.endMinion(agentId, nowMs, task);
  }
  liveMinions(nowMs: number): Map<string, Minion[]> {
    return this.activity.liveMinions(nowMs);
  }

  /**
   * How many minions each parent has running.
   *
   * Counts only, for the peer-facing roster: a minion cannot be addressed, so
   * a peer given names would have recipients `msg` cannot resolve. `who` uses
   * `liveMinions` instead, because the operator CAN act on what they name.
   */
  minionCounts(nowMs: number): Map<string, number> {
    return this.activity.minionCounts(nowMs);
  }

  pruneMinions(nowMs: number): void {
    this.activity.pruneMinions(nowMs, MINION_KEEP_MS);
  }

  releaseClaim(sessionId: string, path: string): void {
    this.activity.releaseClaim(sessionId, path);
  }

  conflictingClaims(sessionId: string, path: string, nowMs: number): Claim[] {
    return this.activity.conflictingClaims(sessionId, path, nowMs, CLAIM_TTL_MS);
  }

  claimsSince(sessionId: string, sinceMs: number): string[] {
    return this.activity.claimsSince(sessionId, sinceMs);
  }

  injectionExposures(sessionId: string): Map<string, string> {
    return this.injection.exposures(sessionId);
  }

  /**
   * One packed block committed together: exposures landing without their
   * omissions marks a session as shown content its inbox cannot hand back.
   */
  recordInjectionResult(
    sessionId: string,
    result: {
      readonly shown: ReadonlyArray<InjectionShown>;
      readonly omitted: ReadonlyArray<InjectionOmitted>;
      readonly nowMs: number;
      readonly clearFirst?: boolean;
    },
  ): void {
    this.injection.record(sessionId, result);
  }

  /** What each delivery actually contained, newest first — not a re-derivation. */
  injectionHistory(sessionId: string, limit = 50): InjectionLedgerRow[] {
    return this.injection.history(sessionId, limit);
  }

  /** Called when SessionStart reports clear/compact/fork: the row survives, the context does not. */
  clearInjectionExposures(sessionId: string): void {
    this.injection.clearExposures(sessionId);
  }

  /**
   * `keepMs`, not `STALE_MS`: a session leaves the roster at 90 minutes but can
   * be resumed hours later, and resume is the one case suppression is correct.
   */
  pruneInjectionState(nowMs: number, keepMs: number): void {
    this.injection.prune(nowMs, keepMs);
  }

  /** Everything `inbox` should hand back, oldest first. */
  injectionOmissions(sessionId: string): Array<{ key: string; text: string; reason: string; stateVersion: string }> {
    return this.injection.omissions(sessionId);
  }

  allClaims(nowMs: number): Claim[] {
    return this.activity.allClaims(nowMs, CLAIM_TTL_MS);
  }

  pruneStale(nowMs: number): void {
    const cutoff = nowMs - STALE_MS;
    const editCutoff = nowMs - EDIT_KEEP_MS;
    // Names are released by DELETION, never by this sweep: reaping means "not
    // at the keyboard" (90 min), owning a name means "this conversation
    // exists". Conflating them is what renamed hopper to akari, 2026-08-05.
    if (this.transcriptDirPath !== "") {
      this.owners.release(liveConversations(this.transcriptDirPath));
    }
    const prune = this.db.transaction(() => {
      // `sessions` is deleted LAST so the subqueries above still see every dead
      // row; deleting it first strands the claims and tasks it just removed.
      const dead = `SELECT session_id FROM sessions WHERE last_seen_ms <= ?`;
      this.db.query(`DELETE FROM claims WHERE session_id IN (${dead})`).run(cutoff);
      this.db.query(`DELETE FROM tasks WHERE session_id IN (${dead})`).run(cutoff);
      this.db.query(`DELETE FROM sessions WHERE last_seen_ms <= ?`).run(cutoff);
      // Edit history outlives everything else here — it is the only table that
      // answers a question about the PAST, and its horizon is configurable
      // (`editKeepMs`) because thirty days is a guess and someone's audit is not.
      this.db.query(`DELETE FROM edits WHERE ts_ms <= ?`).run(editCutoff);
      // WORK RECORDS ARE NOT SWEPT WITH THE SESSION. They are keyed on the agent
      // precisely so they outlive the terminal that opened them — a record that
      // evaporated when a session went stale could not answer "who moved the
      // baselines?" a day later, which is the question it exists for. They expire
      // on their own, longer clock, and only once CLOSED.
      this.work.pruneWork(nowMs);
    });
    prune.immediate();
  }
}

/** The name a human should see for a claim; `claimRows` resolves the order. */
export function claimName(c: Claim): string {
  return c.name !== "" ? c.name : c.handle;
}

export function agoText(fromMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - fromMs) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}
