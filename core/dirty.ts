/**
 * Which files in a worktree have uncommitted changes.
 *
 * A committed file is not a collision, and a claim is released by nothing but a
 * 2-hour timer — so without this most of the warning channel points at
 * conflicts a commit already resolved. `git status` costs enough that this runs
 * ONLY once a conflicting claim exists, cached per worktree per process.
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
  // `--ignored` as well as `--untracked-files=all`: without it a gitignored
  // file an agent is actively editing reports CLEAN and its warning is
  // suppressed. Agents do edit `.claude/settings.local.json` and `dist/`.
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--ignored"], {
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
