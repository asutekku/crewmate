/**
 * StopFailure: record that a turn died on an API error.
 *
 * WHY THIS IS NOT OPTIONAL: `StopFailure` runs INSTEAD OF `Stop`, so when a turn
 * dies the ordinary turn-end hook never runs, nothing is posted, and peers keep
 * reading the session as busy until the 90-minute staleness window reaps it. The
 * roster's most damaging failure is not missing information — it is confidently
 * wrong information about who is still working.
 *
 * SIDE-EFFECT ONLY. HOOKS.MD lists StopFailure under "No decision control" and
 * says its "Output and exit code are ignored", so this writes to the store and
 * says nothing to its own session. Peers read it at their next delivery point.
 */

import { withStore } from "../core/store.ts";
import { readPayload } from "../core/shared.ts";
import { resolveProject } from "../core/repo.ts";
import { summarize } from "../core/topic.ts";
import { runHook } from "../core/hook.ts";

/** Enough to tell a rate limit from an auth failure; not a stack trace. */
const ERROR_MAX = 80;

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const err = summarize(payload.error ?? "", ERROR_MAX);
  withStore(resolveProject(cwd).dbPath, (store) => {
    const now = Date.now();
    const handle = store.handleFor(sessionId);
    if (!handle) return;
    const detail = err !== "" ? `turn failed: ${err}` : "turn failed (API error)";
    // Deliberately NOT `touch`ed: this session did not do something, it stopped
    // being able to. Touching would clear the very flag being set.
    store.setBlocked(sessionId, detail);
    store.post(handle, "done", detail, now);
  });
}

await runHook(import.meta.file, main);
