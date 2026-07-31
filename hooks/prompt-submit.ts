/**
 * UserPromptSubmit: heartbeat, deliver unread peer messages, and record what
 * this session was asked to do.
 *
 * This is the hook that makes the whole thing work without polling. Peer news
 * arrives as ordinary context at the top of a turn, so an agent reads it the way
 * it reads anything else — no tool call, no inference cost when idle.
 *
 * THE UNAVOIDABLE LIMIT: this fires on a prompt boundary. A session in the
 * middle of a long autonomous run does not see a peer's message until its next
 * turn. There is no supported way to inject into a running turn today, so the
 * design leans on the Stop hook to catch news at the end of a turn instead.
 */

import { withStore } from "../core/store.ts";
import { emit, formatMessages, formatRoster, readPayload, TRUST_NOTE } from "../core/shared.ts";
import { currentBranch, resolveProject, worktreeRoot } from "../core/repo.ts";
import { topicOf } from "../core/topic.ts";
import { readTranscript } from "../core/transcript.ts";


async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const project = resolveProject(cwd);
  const tree = worktreeRoot(cwd);

  const report = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);

    // Re-registers if the row was reaped: this hook firing proves the session
    // is alive, and a pruned session that cannot come back is invisible to
    // every peer for the rest of its life.
    const handle = store.handleForOrRegister(sessionId, tree, currentBranch(cwd), now);
    if (!handle) return null;
    const self = store.liveSessions(now).find((s) => s.sessionId === sessionId);

    // THE MOST RECENT prompt that names a topic is the session's stated task —
    // not the first. The first-prompt rule made the column describe what a
    // session was asked once rather than what it is doing: measured across four
    // live sessions on 2026-07-31 it produced one agent frozen on its opening
    // question, one frozen on an ANSWER it had given, and two blank. A stale
    // label is worse than a moving one, because a peer reads the roster to
    // decide whether to interrupt.
    //
    // The roster gets a SHORT, NON-VERBATIM label and nothing is posted to the
    // log. Publishing prompts word-for-word sent whatever the user typed —
    // credentials, client names, a pasted stack trace — to every peer in the
    // repo, and produced lines like `turing was asked by its user: "go"` that
    // carried no information at all. A peer needs to know roughly what a session
    // is for; it does not need the transcript.
    //
    // Written only when `topicOf` found something: it returns "" for filler and
    // for pasted output, and clearing a good label because the latest prompt was
    // "yes" would lose the last true thing the column had.
    const topic = payload.prompt !== undefined ? topicOf(payload.prompt) : "";
    if (self && topic !== "") store.setIntent(sessionId, topic);

    // Claude Code's own conversation name, which it rewrites every turn. Read
    // rather than inferred: it is a model-written summary of the whole
    // conversation and costs 0.4 ms, where `topicOf` above can only ever see the
    // single prompt in front of it. Recorded for the OPERATOR's roster — a peer
    // never sees it (see the Session type).
    //
    // The transcript path is also stored, so the summary refresh can find this
    // session's transcript later without reconstructing a path from its id.
    if (payload.transcript_path) {
      store.setTranscript(sessionId, payload.transcript_path);
      const { title } = readTranscript(payload.transcript_path);
      // Only when non-empty: transcripts predating the feature have no title at
      // all, and blanking a good one because today's read came up empty would
      // lose the only description some sessions have.
      if (title !== "") store.setTitle(sessionId, title);
    }

    const unread = store.drainUnread(sessionId);
    if (unread.length === 0) return null;

    // A message is only actionable next to the roster it refers to, so the two
    // are always delivered together.
    const peers = store.liveSessions(now).filter((s) => s.sessionId !== sessionId);
    const claims = store.allClaims(now);
    const lines = [`${unread.length} update(s) from other agents in ${project.name}:`];
    lines.push(...formatMessages(unread, now));
    if (peers.length > 0) {
      lines.push("", "Currently active:");
      lines.push(...formatRoster(peers, claims, now, tree));
    }
    lines.push("", TRUST_NOTE);
    return { text: lines.join("\n"), count: unread.length };
  });

  if (!report) return;
  emit("UserPromptSubmit", report.text, `presence: ${report.count} peer update(s)`);
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A silent catch turns a programmer error into a
  // hook that exits 0 having done nothing, which is indistinguishable from
  // "nothing to report" and is exactly how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
  // Fail open.
}
