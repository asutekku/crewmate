/**
 * TaskCreated / TaskCompleted: mirror a session's private task list onto a
 * board every agent can see.
 *
 * WHY A MIRROR AND NOT THE REAL THING: Claude Code's task list is PER-SESSION —
 * `~/.claude/tasks/` holds one directory per session id, so `TaskList` in one
 * session cannot see another's (verified by creating a task and finding it only
 * under this session's own id). Agent teams share a list, but teammates must be
 * spawned by a lead, which independently launched sessions are not. So the only
 * shared board possible is one we keep.
 *
 * WHAT IT ADDS: progress, which no other field carries. A stated task says what
 * a session was ASKED — it updates on each topic-bearing prompt, but a long run
 * on one instruction still shows the same line for hours. A count that moves as
 * work completes is the only signal that says how far along it is.
 *
 * SIDE-EFFECT ONLY BY CHOICE. These hooks CAN block task creation with exit 2;
 * doing so would be enforcement, which this system does not do.
 */

import { withStore } from "../core/store.ts";
import { readPayload } from "../core/shared.ts";
import { resolveProject } from "../core/repo.ts";
import { topicOf } from "../core/topic.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  const taskId = payload?.task_id;
  if (!sessionId || !cwd || !taskId) return;

  const completing = payload.hook_event_name === "TaskCompleted";

  withStore(resolveProject(cwd).dbPath, (store) => {
    const now = Date.now();
    if (!store.handleFor(sessionId)) return;
    if (completing) {
      store.completeTask(sessionId, taskId, now);
      return;
    }
    // Subjects are agent-written, but they can quote a user's words, so they go
    // through the same distillation as any other republished text.
    const subject = topicOf(payload.task_subject ?? "");
    if (subject === "") return;
    store.upsertTask(sessionId, taskId, subject, now);
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
