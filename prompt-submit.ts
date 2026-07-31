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
import { emit, formatMessages, formatRoster, readPayload, summarize } from "./shared.ts";
import { resolveProject, worktreeRoot } from "./repo.ts";

/** Intent is a roster label, not a description; one short line is the point. */
const INTENT_MAX = 120;

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
      const intent = summarize(payload.prompt, INTENT_MAX);
      store.setIntent(sessionId, intent);
      store.post(handle, "status", `started: ${intent}`, now);
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
