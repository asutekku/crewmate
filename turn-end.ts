/**
 * Stop: publish that this session reached a stopping point, and hand over
 * anything a peer addressed to it directly.
 *
 * WHY THIS HOOK EXISTS AT ALL: "have they finished?" is the question the roster
 * alone cannot answer — an idle session and a working one look identical from the
 * outside. A turn ending is the only reliable "I am at a stopping point" signal
 * available, so it is the one published.
 *
 * INJECTING HERE CONTINUES THE TURN. HOOKS.MD is explicit that `Stop`'s
 * `additionalContext` keeps the conversation going, "through the same loop
 * protections as decision: block, namely the stop_hook_active input and the
 * 8-consecutive-continuation cap". So delivery here is deliberately narrow:
 *   - only messages addressed to THIS session, and human broadcasts
 *   - never while `stop_hook_active`, which means a hook is already continuing
 * Routine `done`/`claim` chatter waits for the next prompt or tool batch. With
 * several sessions in one tree, delivering it here would let every agent's
 * turn-end announcement extend every other agent's turn, and two agents could
 * bounce `done` lines off each other until the cap cut them off.
 *
 * NEVER BLOCKS. `decision: "block"` would trap a session in a loop the user did
 * not ask for.
 */

import { withStore } from "./store.ts";
import { emit, formatMessages, readPayload, TRUST_NOTE } from "./shared.ts";
import { resolveProject } from "./repo.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  // Already inside a hook-driven continuation: record the stop, deliver nothing.
  // Chaining another continuation here is how a turn stops ever ending.
  const continuing = payload.stop_hook_active === true;
  // Present from v2.1.145; absent on older versions, which read as "not paused".
  const background = payload.background_tasks ?? [];

  const report = withStore(resolveProject(cwd).dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);
    const handle = store.handleFor(sessionId);
    if (!handle) return null;

    // A session waiting on a background task has NOT finished, and saying it has
    // is the roster's most misleading possible claim about a peer.
    if (background.length > 0) {
      const kinds = [...new Set(background.map((t) => t.type ?? "task"))].join(", ");
      store.post(handle, "done", `paused, waiting on background work (${kinds})`, now);
    } else {
      // The assistant's own words are NOT republished: same leak class as user
      // prompts, and a peer needs the fact of a stop, not its content.
      store.post(handle, "done", "reached a stopping point", now);
    }

    if (continuing) return null;
    const unread = store.drainDirected(sessionId);
    if (unread.length === 0) return null;
    const lines = [`${unread.length} message(s) addressed to this session:`];
    lines.push(...formatMessages(unread, now));
    lines.push("", TRUST_NOTE);
    return { text: lines.join("\n"), count: unread.length };
  });

  if (!report) return;
  emit("Stop", report.text, `presence: ${report.count} message(s) for you`);
}

try {
  await main();
} catch {
  // Fail open.
}
