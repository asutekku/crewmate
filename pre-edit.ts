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

import { relPath, withStore } from "./store.ts";
import { agoText } from "./store.ts";
import { emit, readPayload, REPO } from "./shared.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const filePath = payload?.tool_input?.file_path;
  if (!sessionId || !filePath) return;

  const path = relPath(filePath, REPO);
  // The presence db is itself written by these hooks; claiming it is noise.
  if (path.includes(".claude/hooks/.state/")) return;

  const warning = withStore((store) => {
    const now = Date.now();
    store.touch(sessionId, now);
    const handle = store.handleFor(sessionId);
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

    const detail = others
      .map((o) => `${o.handle} (claimed ${agoText(o.tsMs, now)})`)
      .join(", ");
    return (
      `OVERLAP: ${path} is also being edited by ${detail}.\n` +
      `Their changes may be uncommitted in this shared tree. Per CLAUDE.md, stage only ` +
      `the files you authored — never \`git add .\` — and do not revert or stash their work. ` +
      `If your change would conflict with theirs, say so rather than overwriting it.`
    );
  });

  if (!warning) return;
  emit("PreToolUse", warning, "presence: file also claimed by another agent");
}

try {
  await main();
} catch {
  // Fail open: never block an edit because coordination state is unavailable.
}
