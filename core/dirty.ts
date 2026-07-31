/**
 * Which files in a worktree have uncommitted changes.
 *
 * WHY THIS EXISTS: a claim is recorded per edit and released by nothing but a
 * 2-hour timer, so an agent that edited a file, committed it, and moved on is
 * still "holding" it. Measured on the live roster: 38 of 42 claims were on files
 * with no uncommitted changes at all — 90% of the warning channel pointing at
 * conflicts that had already been resolved by a commit. Peers replied "that's
 * committed" and the operator read the exchange.
 *
 * A committed file is not a collision. Both versions are in history, git merges
 * them, and the thing the warning is actually about — *their uncommitted work is
 * sitting in this file right now* — is simply not true.
 *
 * COST IS WHY THIS IS NOT DONE ON EVERY EDIT. `git status --porcelain` is ~40 ms
 * (measured, main tree, 11 dirty files), and `pre-edit` runs before every Edit
 * and Write. So it is called ONLY once a conflicting claim already exists, which
 * is rare, and the result is cached per worktree for the life of the process —
 * a hook is a short-lived process, so that is one call per warning, not per file.
 */

import { spawnSync } from "node:child_process";

/** Per-process, per-worktree. A hook exits in milliseconds, so this cannot go stale. */
const cache = new Map<string, ReadonlySet<string>>();

/**
 * Repo-relative paths with uncommitted changes in `tree`, or null when git
 * cannot answer.
 *
 * NULL IS NOT AN EMPTY SET, and the distinction is load-bearing: "no dirty
 * files" means every claim is stale, while "git failed" must leave every warning
 * exactly as it was. Collapsing the two would silence the whole channel the
 * first time this ran outside a repo.
 */
export function dirtyFiles(tree: string): ReadonlySet<string> | null {
  const hit = cache.get(tree);
  if (hit !== undefined) return hit;
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: tree,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  const set = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const path = parseStatusLine(line);
    if (path !== null) set.add(path);
  }
  cache.set(tree, set);
  return set;
}

/**
 * Pulls the path out of one `git status --porcelain` line.
 *
 * The format is two status characters, a space, then the path — and three
 * things complicate it. A rename is `R  old -> new`, and the NEW name is the one
 * a claim would match. A path containing a space, quote or non-ASCII byte is
 * emitted quoted with C-style escapes. And the trailing blank line must not
 * become an entry, or an empty path matches nothing but sits in the set.
 */
function parseStatusLine(line: string): string | null {
  if (line.length < 4) return null;
  let path = line.slice(3).trim();
  if (path === "") return null;
  // A rename's arrow: take the destination, which is what exists on disk now.
  const arrow = path.lastIndexOf(" -> ");
  if (arrow >= 0) path = path.slice(arrow + 4);
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    path = path.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return path;
}

/** Test seam: forget cached answers so a fixture can change the tree. */
export function clearDirtyCache(): void {
  cache.clear();
}
