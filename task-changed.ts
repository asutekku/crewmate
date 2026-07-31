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
 * WHAT IT FIXES: the roster's stalest field. A session's stated task comes from
 * its first prompt and never changes, so an agent hours into a run still shows
 * peers what it was asked at the start. Task counts move as the work does.
 *
 * SIDE-EFFECT ONLY BY CHOICE. These hooks CAN block task creation with exit 2;
 * doing so would be enforcement, which this system does not do.
 */

import { withStore } from "./store.ts";
import { readPayload } from "./shared.ts";
import { resolveProject } from "./repo.ts";
import { topicOf } from "./topic.ts";

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
} catch {
  // Fail open.
}
