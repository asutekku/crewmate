/**
 * SessionEnd: announce departure and drop this session's row and claims.
 *
 * A clean exit is the minority case — terminals get closed — so the roster does
 * not depend on this running. It is the fast path; `STALE_MS` is the fallback.
 *
 * This event cannot inject context (the session is already going away), so it is
 * side-effect only.
 */

import { withStore } from "./store.ts";
import { readPayload } from "./shared.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  if (!sessionId) return;

  // `clear` and `resume` end a session without the agent leaving the repo, and
  // deregistering there would drop a still-live agent off the roster.
  const reason = payload.reason ?? "other";
  if (reason === "clear" || reason === "resume") return;

  withStore((store) => {
    const now = Date.now();
    const handle = store.handleFor(sessionId);
    if (handle) store.post(handle, "status", "session ended", now);
    store.unregister(sessionId);
  });
}

try {
  await main();
} catch {
  // Fail open.
}
