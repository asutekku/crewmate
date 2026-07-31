/**
 * Which repo is this session in, and where does its presence db live.
 *
 * These hooks are installed USER-WIDE (`~/.claude/settings.json`), so they fire
 * in every project and in worktrees that live outside the repo directory. That
 * makes repo identity a runtime question, not a constant.
 *
 * THE KEY IS THE GIT COMMON DIR. Every worktree of one repo reports the same
 * `--git-common-dir` (verified: the main tree, an in-repo `.claude/worktrees/*`
 * checkout, and one under the system temp dir all resolve to the same path), and
 * two different repos never collide. Keying on cwd instead would split one repo
 * into a roster per worktree — the exact thing this is meant to join up.
 *
 * WHY NOT INSIDE THE REPO: a db under `.claude/` would be invisible to a
 * worktree pinned to an older commit, and would need gitignoring in every repo
 * the hooks touch. One directory under `~/.claude/` avoids both, and keeps a
 * non-git directory (where there is no repo to coordinate over) from creating
 * stray files.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export interface RepoContext {
  /**
   * The identity key: the shared `.git` in a repo, or the directory itself when
   * there is no repo. Sessions agree on this iff they should see each other.
   */
  readonly key: string;
  /** Working-tree root for THIS session; differs per worktree. */
  readonly root: string;
  /** Human-facing project name, e.g. `Traffic`. */
  readonly name: string;
  /** False when there is no git repo — worktrees cannot exist, so root is cwd. */
  readonly isGit: boolean;
  readonly dbPath: string;
}

const BASE_DIR = `${homedir().replace(/\\/g, "/")}/.claude/agent-presence`;

function git(cwd: string, args: readonly string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString().trim();
    return out.length > 0 ? out.replace(/\\/g, "/") : null;
  } catch {
    return null;
  }
}

/**
 * Windows and macOS resolve paths case-insensitively, Linux does not. Folding
 * case only where the platform does keeps two genuinely distinct Linux repos
 * (`~/work/App` and `~/work/app`) from sharing one roster, while still letting
 * `I:/Projects` and `i:/projects` agree on Windows.
 */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

function foldCase(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/**
 * A filesystem-safe, human-readable id for a project path. The hash keeps two
 * same-named projects in different directories apart; the name prefix is purely
 * so the directory is browsable.
 */
function slug(key: string, name: string): string {
  const hash = Bun.hash(foldCase(key)).toString(16).slice(0, 8);
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "project";
  return `${safe}-${hash}`;
}

/**
 * Resolves the project for `cwd`. Never null: a directory with no git repo is a
 * perfectly good coordination scope, and agents working there need the roster
 * just as much. Without this fallback the hooks would silently do nothing for
 * anyone who has not run `git init`, which looks like a broken install rather
 * than an unsupported setup.
 *
 * The two keys cannot collide: a git key always ends in `/.git`, a plain
 * directory never does.
 */
/**
 * Project identity is derived from a `git rev-parse` subprocess, measured at
 * ~31 ms — cheap once per session, but `PostToolBatch` fires after every batch
 * of tool calls, where it dominates the hook's cost.
 *
 * A repo's git common dir cannot change for a given directory (moving the repo
 * changes the directory too), so the answer is cached on disk beside the state.
 * The cache is keyed by cwd and holds only derived paths — nothing that goes
 * stale within a session.
 */
function cachedResolve(cwdNorm: string): RepoContext | null {
  try {
    const f = Bun.file(`${BASE_DIR}/paths.json`);
    if (!f.size) return null;
    const map = JSON.parse(readFileSync(`${BASE_DIR}/paths.json`, "utf8")) as Record<
      string,
      RepoContext
    >;
    return map[cwdNorm] ?? null;
  } catch {
    return null;
  }
}

function cacheResolve(cwdNorm: string, ctx: RepoContext): void {
  try {
    ensureBaseDir();
    const path = `${BASE_DIR}/paths.json`;
    let map: Record<string, RepoContext> = {};
    try {
      map = JSON.parse(readFileSync(path, "utf8")) as Record<string, RepoContext>;
    } catch {
      map = {};
    }
    map[cwdNorm] = ctx;
    writeFileSync(path, JSON.stringify(map));
  } catch {
    // A cache that cannot be written is not an error; the next call recomputes.
  }
}

export function resolveProject(cwd: string): RepoContext {
  const cwdNorm = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const hit = cachedResolve(cwdNorm);
  if (hit) return hit;
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir) {
    // The main working tree is the common dir's parent. Deriving the NAME from
    // it rather than from cwd keeps every worktree of one repo under one label.
    const root = commonDir.replace(/\/\.git\/?$/, "");
    const name = root.split("/").filter(Boolean).pop() ?? "repo";
    const ctx: RepoContext = {
      key: commonDir,
      root,
      name,
      isGit: true,
      dbPath: `${BASE_DIR}/${slug(commonDir, name)}.db`,
    };
    cacheResolve(cwdNorm, ctx);
    return ctx;
  }
  const name = cwdNorm.split("/").filter(Boolean).pop() ?? "project";
  const ctx: RepoContext = {
    key: cwdNorm,
    root: cwdNorm,
    name,
    isGit: false,
    dbPath: `${BASE_DIR}/${slug(cwdNorm, name)}.db`,
  };
  cacheResolve(cwdNorm, ctx);
  return ctx;
}

/**
 * This session's own working tree — what distinguishes one worktree's agent from
 * another's. Falls back to cwd outside a repo, where there is only ever one.
 */
export function worktreeRoot(cwd: string): string {
  const cwdNorm = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  // Cached for the same reason as the project paths: this runs on the per-edit
  // path, where a `git rev-parse` subprocess dominates the hook's cost (measured
  // 2026-07-31: pre-edit 157 ms → 106 ms). A directory's working tree cannot
  // change without the directory changing, so the answer is stable per key.
  const hit = cachedTree(cwdNorm);
  if (hit !== null) return hit;
  const tree = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]) ?? cwdNorm;
  cacheTree(cwdNorm, tree);
  return tree;
}

function cachedTree(cwdNorm: string): string | null {
  try {
    const map = JSON.parse(readFileSync(`${BASE_DIR}/trees.json`, "utf8")) as Record<string, string>;
    return map[cwdNorm] ?? null;
  } catch {
    // No cache yet, or an unreadable one: recompute. Not a failure.
    return null;
  }
}

function cacheTree(cwdNorm: string, tree: string): void {
  try {
    ensureBaseDir();
    const path = `${BASE_DIR}/trees.json`;
    let map: Record<string, string> = {};
    try {
      map = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      map = {};
    }
    map[cwdNorm] = tree;
    writeFileSync(path, JSON.stringify(map));
  } catch {
    // A cache that cannot be written is not an error; the next call recomputes.
  }
}

/**
 * The build a session loaded, versus the one now installed.
 *
 * A session reads the hook scripts when it starts and keeps that copy until it
 * restarts, so an install mid-flight leaves the roster mixing old and new
 * behaviour with nothing to distinguish them. The user had to infer it from the
 * SHAPE of the output — "some agents are running on older hooks i believe" —
 * which is a guess the roster should not require.
 *
 * Empty when unknown, which is what a pre-stamp build reports.
 */
export function installedVersion(): string {
  try {
    return readFileSync(`${BASE_DIR}/bin/VERSION`, "utf8").trim();
  } catch {
    return "";
  }
}

/** Empty outside a repo; the roster simply omits the branch then. */
export function currentBranch(cwd: string): string {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
}

export function ensureBaseDir(): void {
  mkdirSync(BASE_DIR, { recursive: true });
}

/**
 * Project-relative and forward-slashed, so two worktrees naming one file agree.
 *
 * Case folding follows the platform (see `foldCase`): comparing case-insensitively
 * on Linux would strip the wrong prefix for genuinely distinct paths.
 */
export function relPath(p: string, root: string): string {
  const s = p.replace(/\\/g, "/");
  const rootNorm = root.replace(/\\/g, "/").replace(/\/$/, "");
  return foldCase(s).startsWith(foldCase(rootNorm))
    ? s.slice(rootNorm.length).replace(/^\//, "")
    : s;
}
