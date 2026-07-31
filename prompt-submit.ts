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

import { withStore } from "./store.ts";
import { emit, formatMessages, formatRoster, readPayload, TRUST_NOTE } from "./shared.ts";
import { resolveProject, worktreeRoot } from "./repo.ts";
import { topicOf } from "./topic.ts";


/**
 * The MOST RECENT prompt that names a topic is the session's stated task.
 *
 * This used to be the FIRST such prompt, on the reasoning that a mid-session
 * follow-up ("now fix the test") reads as nonsense to a peer. That guard is no
 * longer needed — `topicOf` rejects contentless text directly — and keeping it
 * made the field describe what a session was asked once rather than what it is
 * doing. Measured across four live sessions on 2026-07-31, the first-prompt rule
 * produced: one session frozen on its opening question while working on
 * something else entirely, one frozen on an ANSWER it had given ("Yes, byte
 * identical generation is not needed…"), and two blank. Nothing in the column
 * was current.
 *
 * A stale label is worse than a moving one: a peer reads the roster to decide
 * whether to interrupt, and deciding against yesterday's topic is the failure.
 */
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

    const self = store.liveSessions(now).find((s) => s.sessionId === sessionId);
    const handle = self?.handle ?? store.handleFor(sessionId);
    if (!handle) return null;

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
} catch {
  // Fail open.
}
