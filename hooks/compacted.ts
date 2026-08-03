/**
 * PostCompact: refresh this session's roster line from the compaction summary.
 *
 * A BETTER INTENT THAN A PROMPT. The stated task is distilled from whatever the
 * user last typed, which describes what a session was ASKED — and a long run on
 * one instruction keeps that line for hours. `compact_summary` is a freshly
 * written description of what the session is ACTUALLY doing, produced by the
 * model that has been doing it, and it arrives for free at exactly the moment a
 * long run has drifted furthest from its opening request.
 *
 * SIDE-EFFECT ONLY. HOOKS.MD lists PostCompact under "No decision control", so
 * this writes and says nothing. The session's own re-orientation after
 * compaction is handled by SessionStart, which re-fires with source="compact".
 *
 * The summary goes through the same lossy, credential-rejecting distillation as
 * a prompt: it is model-written, but it summarises a conversation that may have
 * contained anything.
 */

import { withStore } from "../core/store.ts";
import { readPayload } from "../core/shared.ts";
import { resolveProject } from "../core/repo.ts";
import { topicOf } from "../core/topic.ts";
import { runHook } from "../core/hook.ts";

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

await runHook(import.meta.file, main);
