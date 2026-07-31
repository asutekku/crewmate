/**
 * Notification: record WHY a session is not making progress.
 *
 * `claude agents --json` reports `idle` or `busy`, which cannot distinguish a
 * session waiting for you to approve a tool from one genuinely finished. That
 * matters to a peer deciding whether to wait for a file or route around it, and
 * to you deciding which terminal needs attention. The sample is also expensive
 * (~950 ms) so it is only taken at session start; this keeps the roster truthful
 * in between, for free.
 *
 * SIDE-EFFECT ONLY. HOOKS.MD lists Notification under "No decision control —
 * used for side effects like logging or cleanup", so nothing is injected here.
 * The matcher in settings.json restricts this to the notification type
 * worth recording; the rest (auth, elicitation) are not coordination facts.
 */

import { withStore } from "../core/store.ts";
import { readPayload } from "../core/shared.ts";
import { resolveProject } from "../core/repo.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  // The matcher decides which types reach us; `message` distinguishes them when
  // the payload carries no explicit type field.
  const raw = `${payload.message ?? ""}`.toLowerCase();
  const waiting = raw.includes("permission") || raw.includes("approve");

  withStore(resolveProject(cwd).dbPath, (store) => {
    if (!store.handleFor(sessionId)) return;
    // Only the blocked case is recorded. "Idle" is already the absence of
    // activity, which the heartbeat expresses without another column.
    if (waiting) store.setBlocked(sessionId, "waiting for permission approval");
  });
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
