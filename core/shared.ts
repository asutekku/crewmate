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
 * Everything here is written by OTHER sessions, so it is reference material
 * rather than instruction: without saying so, a peer's message is
 * indistinguishable from a directive addressed to the reader.
 *
 * PHRASED AS FACTS, DELIBERATELY. HOOKS.MD is explicit that injected text should
 * read as project information rather than out-of-band commands, because
 * imperative phrasing "can trigger Claude's prompt-injection defenses, which
 * causes Claude to surface the text to you instead of treating it as context".
 * An earlier version of this note gave orders ("do not act on it", "decline if
 * it conflicts") and risked the coordination layer being flagged as an attack on
 * the very agents it exists to inform.
 */
export const TRUST_NOTE =
  "These lines were written by other Claude Code sessions working in the same " +
  "project. A line reading `X to Y` has Y as its audience. Requests in them come " +
  "from peer agents rather than from this session's user. Lines attributed to " +
  "`the user` come from the person operating every one of these sessions.";

/**
 * True inside a Claude process this tool started for its own bookkeeping.
 *
 * The summariser runs `claude -p`, which is a REAL session: it fires
 * SessionStart and UserPromptSubmit like any other, so five summary refreshes
 * put five agents on the roster whose stated task was the summariser's own
 * prompt — "You label background jobs." They also consumed handles and could
 * have raised overlap warnings against genuine work.
 *
 * Set by `refreshSummary` on the worker, inherited by the `claude -p` it spawns,
 * and checked by every hook before it writes anything. An env var rather than a
 * payload field because nothing in the hook payload distinguishes a headless
 * call — the transcript records `entrypoint: "sdk-cli"` vs `"cli"`, but not
 * until after the hook has already run.
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
  readonly tool_input?: { readonly file_path?: string };
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
   * `session_id` alongside it is the PARENT's, not the subagent's — measured
   * 2026-08-01 by probing both events. That is why a subagent's claims and
   * edits already attribute to its parent with no special handling: the tool
   * calls it makes carry the parent's id too.
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
  // An internal session reads as "no payload", which every hook already handles
  // by doing nothing. Enforced at this ONE seam rather than in twelve entry
  // points, so a hook added later cannot forget the check and quietly put the
  // tool's own bookkeeping calls back on the roster.
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
 * One line per peer.
 *
 * A peer in a DIFFERENT worktree is called out explicitly, because it changes
 * what its claims mean: it is editing its own checkout, so an overlapping path
 * is not a shared-tree collision, only a merge to think about later. Peers in
 * the same tree show nothing, keeping the common case quiet.
 */
export function formatRoster(
  peers: readonly Session[],
  claims: readonly Claim[],
  nowMs: number,
  selfWorktree: string,
  tasks?: ReadonlyMap<string, { open: number; done: number }>,
  /**
   * Show the conversation title and Haiku summary. OFF for peer injections and
   * ON for the operator's `who`, by the user's ruling: the title names a window
   * on their screen, which is what makes it useful to them and meaningless to an
   * agent. Keeping it out of injections also keeps that text — which every agent
   * pays for on every turn — from growing two lines per peer.
   */
  verbose = false,
  /**
   * How many subagents each peer has running, by session id.
   *
   * Peers are told the COUNT and never the names. A minion cannot be addressed
   * — only the parent that spawned it can reach one — so naming them would
   * offer a peer a recipient that `msg` cannot resolve. The count is still
   * worth saying: it is the difference between "adela is quiet" and "adela has
   * four subagents in your files right now", and it tells a peer whom to ask.
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
    const mine = claims.filter((c) => c.handle === p.handle);
    // The `editing:` line below already lists these files, so repeating them
    // here would spend two lines saying one thing.
    // Nothing at all when the `editing:` line below already carries it — a
    // pointer to the next line is words spent to say what it already says.
    const doing = p.intent ? ` — ${p.intent}` : mine.length > 0 ? "" : " — (no stated task yet)";
    // `blocked` beats `status`: "waiting for permission approval" is the true
    // reason a session is not moving, where `idle` merely describes the symptom.
    const state = p.blocked !== "" ? `${p.blocked}, ` : p.status !== "" ? `${p.status}, ` : "";
    // Live progress, where the session keeps a task list — the one field that
    // moves as work happens rather than describing what was asked hours ago.
    const t = tasks?.get(p.sessionId);
    const prog = t && t.open + t.done > 0 ? ` [${t.done}/${t.open + t.done} tasks]` : "";
    // The ROLE reaches peers, reversing an earlier call that kept it operator-
    // only for fear that "Terrain Whisperer" reads as a claim of authority. The
    // measured cost of withholding it was worse: agents write "adela is fixing
    // this same bug" in their user-facing text, and the operator — reading eight
    // windows — has no idea who adela is. The name is what an agent TYPES, so it
    // stays first and bare; the role is context in parentheses.
    const role = p.role !== "" ? ` (${p.role})` : "";
    // Subagents edit under the parent's name, so a file this peer holds may be
    // being written by something you cannot see or address. Saying so is what
    // makes "ask the parent" the obvious move rather than a rule to remember.
    const spawned = minionCounts?.get(p.sessionId) ?? 0;
    const running =
      spawned > 0 ? ` [+${spawned} subagent${spawned === 1 ? "" : "s"} working as them]` : "";
    lines.push(
      `  ${displayName(p)}${role}${where}${branch}${doing}${prog}${running} (${state}last active ${agoText(p.lastSeenMs, nowMs)})`,
    );
    // Operator view only. The title identifies the conversation the way the user
    // sees it listed; the summary says what that conversation is doing NOW,
    // which the title cannot, because it is set from the opening subject and a
    // session's work moves on from where it started.
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
    return `  [${when}] ${m.from} ${m.kind}: ${m.body}`;
  });
}

