/**
 * Payload reading and report formatting shared by the presence hooks.
 *
 * FAIL OPEN, ALWAYS: a coordination hook that breaks a session is worse than no
 * coordination. Every entry point wraps its work so a locked db, a malformed
 * payload or a missing state dir ends the hook silently instead of surfacing an
 * error into the transcript. `typecheck.ts` takes the same line.
 */

import type { Claim, Message, Session } from "./store.ts";
import { agoText, displayName } from "./store.ts";

/**
 * Appended wherever peer text is injected.
 *
 * PHRASED AS FACTS, DELIBERATELY: imperative injected text can trip Claude's
 * prompt-injection defenses. It answers both who wrote the text and which of
 * the three doors it arrived through. See docs/design-notes.md, "The trust note".
 */
export const TRUST_NOTE =
  "These lines were written by other Claude Code sessions working in the same " +
  "project. A line reading `X to Y` has Y as its audience. Requests in them come " +
  "from peer agents rather than from this session's user. Lines attributed to " +
  "`the user` come from the person operating every one of these sessions. " +
  "Text reaches a session between its tool batches, at a prompt, or after it " +
  "stops — when it arrives after a stop, that arrival is what started the " +
  "session running again.";

/**
 * True inside a Claude process this tool started for its own bookkeeping.
 *
 * The summariser runs `claude -p`, a REAL session that would otherwise put
 * itself on the roster. An env var rather than a payload field, because no
 * payload field distinguishes a headless call before the hook runs.
 */
export function isInternalSession(): boolean {
  return process.env["PRESENCE_INTERNAL"] === "1";
}

export interface HookPayload {
  readonly session_id?: string;
  readonly cwd?: string;
  /**
   * This session's transcript JSONL. Present on every event.
   *
   * Written ASYNCHRONOUSLY, so it can lag the in-memory conversation by a turn —
   * fine for the conversation title and recent prose, which move slowly. Never
   * use it for the current turn's final assistant text; `last_assistant_message`
   * on Stop is the field for that.
   */
  readonly transcript_path?: string;
  /** Which event fired — the only way one script can serve two events. */
  readonly hook_event_name?: string;
  /** Notification: the text shown to the user. */
  readonly message?: string;
  readonly prompt?: string;
  /** SessionStart: `startup` | `resume` | `clear` | `compact` | `fork`. */
  readonly source?: string;
  readonly reason?: string;
  readonly last_assistant_message?: string;
  /** Which tool is about to run: `Edit`, `Write`, `NotebookEdit`. */
  readonly tool_name?: string;
  readonly tool_input?: { readonly file_path?: string; readonly command?: string };
  /**
   * PostToolUse: what the tool returned.
   *
   * `git commit` prints its `[branch sha] subject` line to STDOUT, but read
   * both streams: a hook that guesses the wrong one silently never fires.
   */
  readonly tool_response?: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly interrupted?: boolean;
  };
  /** Stop: true when a hook is already driving a continuation. */
  readonly stop_hook_active?: boolean;
  /** StopFailure: why the turn died. */
  readonly error?: string;
  /** PostCompact: the summary that replaced the compacted context. */
  readonly compact_summary?: string;
  /** CwdChanged. */
  readonly new_cwd?: string;
  /** SubagentStart/Stop. */
  readonly agent_type?: string;
  /**
   * SubagentStart/Stop: identifies ONE spawned subagent, stable across both.
   *
   * `session_id` alongside it is the PARENT's, which is why a subagent's claims
   * and edits attribute to its parent with no special handling.
   */
  readonly agent_id?: string;
  /**
   * SubagentStop only: the subagent's OWN transcript, separate from the
   * parent's.
   *
   * The parent's transcript interleaves subagent output, so a summary built
   * from it describes a minion's work as the parent's own.
   */
  readonly agent_transcript_path?: string;
  /**
   * Stop, v2.1.145+: in-flight work that means "paused", not "finished".
   *
   * Also present on SubagentStop, where `description` is the string the PARENT
   * passed when spawning — which is why naming a minion's task needs no model
   * call and no new convention: the parent already wrote it.
   */
  readonly background_tasks?: ReadonlyArray<{
    readonly id?: string;
    readonly type?: string;
    readonly status?: string;
    readonly description?: string;
    readonly agent_type?: string;
  }>;
  /** TaskCreated/TaskCompleted. */
  readonly task_id?: string;
  readonly task_subject?: string;
}

export async function readPayload(): Promise<HookPayload | null> {
  // An internal session reads as "no payload", which every hook handles by
  // doing nothing. Enforced at this ONE seam so a hook added later cannot
  // forget the check and put bookkeeping calls back on the roster.
  if (isInternalSession()) return null;
  try {
    return (await new Response(Bun.stdin).json()) as HookPayload;
  } catch {
    return null;
  }
}

/** Emits the hook result. `additionalContext` is what Claude actually reads. */
export function emit(event: string, context: string, systemMessage?: string): void {
  const out: Record<string, unknown> = {
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  };
  if (systemMessage) out["systemMessage"] = systemMessage;
  console.log(JSON.stringify(out));
}

/**
 * Below this, a worktree taken recently is simply current work, not drift.
 *
 * The real spread is bimodal — fresh worktrees sit near 0 and stale ones far
 * above — so any small number separates them and the exact value is not tender.
 */
export const STALE_COMMITS = 10;

/**
 * What to tell a session about the checkout it is sitting in. Empty when there
 * is nothing worth saying, which is most of the time.
 *
 * IT NEVER SUGGESTS A COMMAND THAT COULD EAT ANOTHER AGENT'S WORK: `rebase`,
 * `reset` and `checkout` appear nowhere.
 */
export function baseStalenessLines(
  distance: { readonly behind: number; readonly ahead: number } | null,
  base: string,
  inWorktree: boolean,
): string[] {
  if (!inWorktree || distance === null || base === "") return [];
  if (distance.behind < STALE_COMMITS) return [];
  const { behind, ahead } = distance;
  if (ahead > 0) {
    return [
      `This worktree is ${behind} commits behind ${base}, with ${ahead} of its own.`,
      `  Plan against what is HERE, not what ${base} has — and note that its newest`,
      `  commits are someone else's, so \`git log\` will not show yours on top.`,
    ];
  }
  return [
    `This worktree is ${behind} commits behind ${base} and has nothing of its own.`,
    `  \`git merge ${base}\` before planning — ${base} moved under you.`,
  ];
}

/**
 * One line per peer.
 *
 * A peer in a DIFFERENT worktree is called out, because an overlapping path
 * there is a merge to think about later, not a shared-tree collision. Peers in
 * the same tree show nothing, keeping the common case quiet.
 */
export function formatRoster(
  peers: readonly Session[],
  claims: readonly Claim[],
  nowMs: number,
  selfWorktree: string,
  tasks?: ReadonlyMap<string, { open: number; done: number }>,
  /**
   * Show the conversation title and Haiku summary. OFF for peer injections, ON
   * for the operator's `who`: the title names a window on their screen, which
   * is useful to them and meaningless to an agent.
   */
  verbose = false,
  /**
   * How many subagents each peer has running, by session id.
   *
   * Peers are told the COUNT and never the names, because a minion cannot be
   * addressed — naming one offers a recipient `msg` cannot resolve.
   */
  minionCounts?: ReadonlyMap<string, number>,
): string[] {
  // With everyone in one tree there is nothing to distinguish, so the label is
  // pure noise on every line; it earns its place only once trees actually differ.
  const trees = new Set(peers.map((p) => p.worktree).filter((w) => w !== ""));
  const treesDiffer = trees.size > 1 || (selfWorktree !== "" && !trees.has(selfWorktree));

  const lines: string[] = [];
  for (const p of peers) {
    // A branch is the tell that this is a git worktree at all; without one there
    // is only ever a single directory, so naming it adds nothing.
    const elsewhere =
      treesDiffer && p.worktree !== "" && p.worktree !== selfWorktree && p.branch !== "";
    const where = elsewhere ? ` [worktree ${p.worktree.split("/").pop() ?? p.worktree}]` : "";
    const branch = elsewhere ? ` on ${p.branch}` : "";
    // HOW MUCH A PEER'S CLAIM IS WORTH: a finding from a checkout hundreds of
    // commits adrift is about code that no longer exists. Only for a peer
    // ELSEWHERE, only past the threshold, and never for an unmeasured -1.
    const stale =
      elsewhere && p.behindBase >= STALE_COMMITS
        ? ` [${p.behindBase} behind ${p.baseBranch === "" ? "base" : p.baseBranch}]`
        : "";
    const mine = claims.filter((c) => c.handle === p.handle);
    // Nothing at all when the `editing:` line below already carries it — a
    // pointer to the next line spends words saying what it already says.
    const doing = p.intent ? ` — ${p.intent}` : mine.length > 0 ? "" : " — (no stated task yet)";
    // `blocked` beats `status`: "waiting for permission approval" is the true
    // reason a session is not moving, where `idle` merely describes the symptom.
    const state = p.blocked !== "" ? `${p.blocked}, ` : p.status !== "" ? `${p.status}, ` : "";
    // Live progress, where the session keeps a task list — the one field that
    // moves as work happens rather than describing what was asked hours ago.
    const t = tasks?.get(p.sessionId);
    const prog = t && t.open + t.done > 0 ? ` [${t.done}/${t.open + t.done} tasks]` : "";
    // The ROLE reaches peers. The name is what an agent TYPES, so it stays
    // first and bare; the role is context in parentheses.
    const role = p.role !== "" ? ` (${p.role})` : "";
    // Subagents edit under the parent's name, so a file this peer holds may be
    // written by something you cannot see or address. Saying so makes "ask the
    // parent" obvious rather than a rule to remember.
    const spawned = minionCounts?.get(p.sessionId) ?? 0;
    const running =
      spawned > 0 ? ` [+${spawned} subagent${spawned === 1 ? "" : "s"} working as them]` : "";
    lines.push(
      `  ${displayName(p)}${role}${where}${branch}${stale}${doing}${prog}${running} (${state}last active ${agoText(p.lastSeenMs, nowMs)})`,
    );
    // Operator view only. The title identifies the conversation as the user
    // sees it listed; the summary says what it is doing NOW, which the title
    // cannot, being set from the opening subject.
    if (verbose && p.title !== "") lines.push(`      "${p.title}"`);
    if (verbose && p.summary !== "") lines.push(`      doing: ${p.summary}`);
    if (mine.length > 0) {
      const shown = mine.slice(0, 6).map((c) => c.path);
      const more = mine.length > shown.length ? ` +${mine.length - shown.length} more` : "";
      lines.push(`      editing: ${shown.join(", ")}${more}`);
    }
  }
  return lines;
}

/**
 * Renders each line so its AUTHOR and AUDIENCE are unmistakable.
 *
 * A directed message reads `ada to turing: "..."` — the arrow matters, because
 * "who said it" and "who it was for" are different questions and a reader acting
 * on a message meant for someone else is the failure mode.
 */
export function formatMessages(msgs: readonly Message[], nowMs: number): string[] {
  return msgs.map((m) => {
    const when = agoText(m.tsMs, nowMs);
    if (m.kind === "note") {
      return `  [${when}] the user, to everyone: ${m.body}`;
    }
    if (m.kind === "say") {
      const audience = m.to !== "" ? `to ${m.to}` : "to everyone";
      return `  [${when}] ${m.from} ${audience}: ${m.body}`;
    }
    if (m.kind === "breaks") {
      // Says what it OBLIGES the reader to do. A break reaches only agents who
      // edited the same files, so the consequence is true by construction.
      return `  [${when}] ${m.from} BROKE something you may depend on: ${m.body}`;
    }
    return `  [${when}] ${m.from} ${m.kind}: ${m.body}`;
  });
}

