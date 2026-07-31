/**
 * PreToolUse on Edit/Write: claim the file being edited, and warn if a live peer
 * has already claimed it.
 *
 * ADVISORY BY CHOICE. This never blocks. Returning a block here would strand an
 * agent mid-task on a file a peer merely *touched* an hour ago, and the repo's
 * real overlap rule is a review question ("is this someone else's work?") that a
 * path match cannot answer. Surfacing the overlap is what lets an agent apply
 * CLAUDE.md's commit rules — stage explicit paths, never `git add .` — knowingly
 * rather than by luck.
 */

import { agoText, withStore } from "./store.ts";
import { emit, readPayload } from "./shared.ts";
import { relPath, resolveProject, worktreeRoot } from "./repo.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  const filePath = payload?.tool_input?.file_path;
  if (!sessionId || !cwd || !filePath) return;

  const project = resolveProject(cwd);
  const tree = worktreeRoot(cwd);
  // Relative to THIS session's worktree, so two checkouts of one repo name the
  // same file identically and their claims actually meet.
  const path = relPath(filePath, tree);

  const warning = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);
    const self = store.liveSessions(now).find((s) => s.sessionId === sessionId);
    const handle = self?.handle ?? store.handleFor(sessionId);
    if (!handle) return null;

    // Read peers' claims BEFORE recording our own, so this session's claim
    // cannot appear in its own conflict list.
    const others = store.conflictingClaims(sessionId, path, now);
    store.claim(sessionId, path, now);
    if (others.length === 0) return null;

    // Announce the overlap to the log too, so the other agent learns about it on
    // its next turn rather than only at commit time.
    const who = others.map((o) => o.handle).join(", ");
    store.post(handle, "claim", `also editing ${path} (already claimed by ${who})`, now);

    // Same tree means their edits are literally in these files right now; a
    // separate worktree is an independent checkout, so the risk is a merge later
    // rather than an overwrite now. The two need different advice, so they are
    // reported separately instead of averaged into one vague warning.
    const here = others.filter((o) => !o.worktree || o.worktree === tree);
    const away = others.filter((o) => o.worktree && o.worktree !== tree);
    const names = (cs: typeof others): string =>
      cs.map((o) => `${o.handle} (claimed ${agoText(o.tsMs, now)})`).join(", ");

    // Stated as consequences rather than orders: HOOKS.MD warns that imperative
    // injected text can read as an out-of-band command and trip Claude's
    // prompt-injection defenses. The facts carry the same weight.
    const lines = [`Another session is editing ${path}.`];
    if (here.length > 0) {
      lines.push(
        `- ${names(here)} — in THIS working tree. Their changes are uncommitted here, ` +
          `so \`git add .\` would stage their work and a revert or stash would discard ` +
          `it. CLAUDE.md's commit rules cover this case.`,
      );
    }
    if (away.length > 0) {
      lines.push(
        `- ${names(away)} — in a separate worktree. There is no on-disk collision, ` +
          `though the two versions have to merge later.`,
      );
    }
    return lines.join("\n");
  });

  if (!warning) return;
  emit("PreToolUse", warning, "presence: file also claimed by another agent");
}

try {
  await main();
} catch {
  // Fail open: never block an edit because coordination state is unavailable.
}
