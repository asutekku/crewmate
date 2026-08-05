/**
 * SessionEnd: announce departure and drop this session's row and claims.
 *
 * A clean exit is the minority case — terminals get closed — so the roster does
 * not depend on this running. It is the fast path; `STALE_MS` is the fallback.
 *
 * This event cannot inject context (the session is already going away), so it is
 * side-effect only.
 */

import { withStore } from "../core/store.ts";
import { readPayload } from "../core/shared.ts";
import { resolveProject } from "../core/repo.ts";
import { runHook } from "../core/hook.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  // `clear` and `resume` end a session without the agent leaving the repo, and
  // deregistering there would drop a still-live agent off the roster.
  const reason = payload.reason ?? "other";
  if (reason === "clear" || reason === "resume") return;

  withStore(resolveProject(cwd).dbPath, (store) => {
    const now = Date.now();
    const handle = store.handleFor(sessionId);
    if (handle) store.post(handle, "done", "session ended", now);
    store.unregister(sessionId, now);
  });
}

await runHook(import.meta.file, main);
