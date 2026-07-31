/**
 * PostCompact: refresh this session's roster line from the compaction summary.
 *
 * THE ROSTER'S STALEST FIELD. A session's stated task is derived from its FIRST
 * prompt and never updated, so an agent four hours into a long run still shows
 * peers what it was asked at breakfast. `compact_summary` is the opposite: a
 * freshly written description of what this session is actually doing, produced
 * by the model that has been doing it. It is the best intent update available,
 * and it arrives for free.
 *
 * SIDE-EFFECT ONLY. HOOKS.MD lists PostCompact under "No decision control", so
 * this writes and says nothing. The session's own re-orientation after
 * compaction is handled by SessionStart, which re-fires with source="compact".
 *
 * The summary goes through the same lossy, credential-rejecting distillation as
 * a prompt: it is model-written, but it summarises a conversation that may have
 * contained anything.
 */

import { withStore } from "./store.ts";
import { readPayload } from "./shared.ts";
import { resolveProject } from "./repo.ts";
import { topicOf } from "./topic.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const summary = payload.compact_summary ?? "";
  if (summary.trim() === "") return;
  const topic = topicOf(summary);
  if (topic === "") return;

  withStore(resolveProject(cwd).dbPath, (store) => {
    if (!store.handleFor(sessionId)) return;
    store.setIntent(sessionId, topic);
  });
}

try {
  await main();
} catch {
  // Fail open.
}
