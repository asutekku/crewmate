/**
 * CwdChanged: keep the worktree and branch columns true when a session moves.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS: the worktree column decides which advice
 * `pre-edit.ts` gives for an overlapping file. A session that `cd`s into another
 * worktree mid-run keeps its old value, so an edit that really would collide on
 * disk gets told "there is no on-disk collision" — advice pointing the wrong way,
 * which is worse than none at all.
 *
 * SIDE-EFFECT ONLY (HOOKS.MD lists CwdChanged under "No decision control"), and
 * rare: a handful of firings per session at most.
 */

import { withStore } from "./store.ts";
import { readPayload } from "./shared.ts";
import { currentBranch, resolveProject, worktreeRoot } from "./repo.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const next = payload?.new_cwd ?? payload?.cwd;
  if (!sessionId || !next) return;

  const project = resolveProject(next);
  const tree = worktreeRoot(next);
  const branch = currentBranch(next);

  withStore(project.dbPath, (store) => {
    const now = Date.now();
    // `register` on a known session id refreshes worktree and branch rather than
    // creating a row, so this is the same path SessionStart uses.
    store.register(sessionId, tree, branch, now);
  });
}

try {
  await main();
} catch {
  // Fail open.
}
