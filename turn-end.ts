/**
 * Stop: publish that this session finished a turn, and surface anything a peer
 * said while the turn was running.
 *
 * WHY THIS HOOK EXISTS AT ALL: "have they finished?" is the question the roster
 * alone cannot answer — an idle session and a working one look identical from the
 * outside. A turn ending is the only reliable "I am at a stopping point" signal
 * available, so it is the one published.
 *
 * It also closes part of the prompt-boundary gap. A long autonomous run misses
 * peer news until its next prompt; delivering unread messages here means the
 * agent at least sees them before it goes quiet, while it can still act.
 *
 * NEVER BLOCKS. A Stop hook can refuse to let a session finish, and using that
 * for peer messages would trap an agent in a loop the user did not ask for.
 */

import { withStore } from "./store.ts";
import { emit, formatMessages, readPayload, summarize } from "./shared.ts";
import { resolveProject } from "./repo.ts";

/** Long enough to say what happened, short enough that a roster stays readable. */
const SUMMARY_MAX = 160;

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const report = withStore(resolveProject(cwd).dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);
    const handle = store.handleFor(sessionId);
    if (!handle) return null;

    const last = payload.last_assistant_message ?? "";
    if (last.trim().length > 0) {
      store.post(handle, "done", `finished a turn: ${summarize(last, SUMMARY_MAX)}`, now);
    } else {
      store.post(handle, "done", "finished a turn", now);
    }

    const unread = store.drainUnread(sessionId);
    if (unread.length === 0) return null;
    const lines = [
      `${unread.length} update(s) arrived from other agents while you were working:`,
    ];
    lines.push(...formatMessages(unread, now));
    lines.push("", "Mention anything here that affects what you just did or plan to do next.");
    return { text: lines.join("\n"), count: unread.length };
  });

  if (!report) return;
  emit("Stop", report.text, `presence: ${report.count} peer update(s)`);
}

try {
  await main();
} catch {
  // Fail open.
}
