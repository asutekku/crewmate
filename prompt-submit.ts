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
 * The first prompt of a session is treated as its stated task. Later prompts do
 * not overwrite it, because mid-session prompts are usually follow-ups ("now fix
 * the test") that read as nonsense to a peer without the preceding context.
 */
function shouldSetIntent(existing: string): boolean {
  return existing.trim().length === 0;
}

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

    if (self && shouldSetIntent(self.intent) && payload.prompt) {
      // The roster gets a SHORT, NON-VERBATIM label and nothing is posted to the
      // log. Publishing prompts word-for-word sent whatever the user typed —
      // credentials, client names, a pasted stack trace — to every peer in the
      // repo, and produced lines like `turing was asked by its user: "go"` that
      // carried no information at all. A peer needs to know roughly what a
      // session is for; it does not need the transcript.
      store.setIntent(sessionId, topicOf(payload.prompt));
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
} catch {
  // Fail open.
}
