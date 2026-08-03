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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Where every project's db, and the optional config file, live. */
export const BASE_DIR = `${homedir().replace(/\\/g, "/")}/.claude/agent-presence`;

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
 * Project identity comes from a `git rev-parse` subprocess, measured at ~31 ms —
 * cheap once per session, but `PostToolBatch` fires after every batch of tool
 * calls, where it dominates the hook's cost. So it is cached on disk.
 *
 * THE CACHE OUTLIVES THE SESSION THAT WROTE IT, which is where the danger is: a
 * cwd's answer is stable only while that directory remains what it was. Deleting
 * a worktree and reusing its path, or `git init` in a directory previously seen
 * as plain, both change the true answer — so a hit is only trusted while its key
 * still exists on disk.
 */
function cachedResolve(cwdNorm: string): RepoContext | null {
  try {
    const f = Bun.file(`${BASE_DIR}/paths.json`);
    if (!f.size) return null;
    const map = JSON.parse(readFileSync(`${BASE_DIR}/paths.json`, "utf8")) as Record<
      string,
      RepoContext
    >;
    const hit = map[cwdNorm] ?? null;
    // The cache outlives the session that wrote it, so "cannot go stale" is only
    // true while the directory it describes still is what it was. A worktree
    // deleted and its path reused by a DIFFERENT repo would otherwise route that
    // session into the old repo's roster, and a `git init` in a directory
    // previously resolved as non-git would split that project in two. Checking
    // the key still exists costs a stat and closes both.
    if (hit && !existsSync(hit.key)) return null;
    return hit;
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

/**
 * Redirects every hook to a throwaway db.
 *
 * Testing a hook means RUNNING it, and running it writes to whatever db it
 * resolves — so a test payload lands in the live project roster as a real
 * session with real claims and real log lines. That happened here on
 * 2026-07-31: probe sessions left 26 junk messages and a false contested-file
 * warning naming this session on a file it never edited, all of which the user
 * had to read past. A test must not be able to reach the shared store at all.
 */
const TEST_DB = process.env["PRESENCE_TEST_DB"] ?? "";

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
export function resolveProject(cwd: string): RepoContext {
  const cwdNorm = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  if (TEST_DB !== "") {
    return { key: TEST_DB, root: cwdNorm, name: "test", isGit: false, dbPath: TEST_DB };
  }
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
  // Under test, resolve without touching the shared cache file: writing
  // `trees.json` into the live state dir is a leak in the isolation that
  // `PRESENCE_TEST_DB` exists to guarantee.
  if (TEST_DB !== "") {
    return git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]) ?? cwdNorm;
  }
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

/** What a build says it installed. Every field absent on a pre-manifest build. */
export interface InstallManifest {
  readonly installedAt: number;
  /** The commit installed from. EMPTY outside a git checkout, which is valid. */
  readonly sourceRevision: string;
  /** Content hash of the installed scripts — what a session reports as its build. */
  readonly contentHash: string;
  readonly schemaVersion: number;
  /** Raised when a name in featureSet starts meaning something different. */
  readonly featureSetVersion: number;
  readonly featureSet: readonly string[];
}

/**
 * What the installed build CLAIMS to provide, for asking whether a session
 * could have had a feature at all.
 *
 * Separate from `installedVersion` because a hash answers "which build" and not
 * "which capabilities" — and the second is the one exposure telemetry needs,
 * since `bin/` is a copy and a session keeps whatever it loaded at start.
 *
 * Null when absent or malformed, never a throw: this is read on hook paths, and
 * a missing manifest is the normal state of every build before this one.
 */
export function installManifest(): InstallManifest | null {
  try {
    const raw = JSON.parse(readFileSync(`${BASE_DIR}/bin/manifest.json`, "utf8")) as unknown;
    return parseManifest(raw);
  } catch {
    return null;
  }
}

/**
 * VALIDATES rather than coerces.
 *
 * An earlier version ran every field through `Number()`/`String()`, which turns
 * `"yesterday"` into `NaN`, `{}` into `NaN`, and `[false, 42]` into
 * `["false", "42"]` — all returned as a valid manifest. That is worse than
 * returning null: a caller asking "did this build have obligations?" would get
 * a confident wrong answer from a corrupt file. Anything that is not the
 * declared shape is not a manifest.
 */
export function parseManifest(raw: unknown): InstallManifest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const installedAt = o["installedAt"];
  const sourceRevision = o["sourceRevision"];
  const contentHash = o["contentHash"];
  const schemaVersion = o["schemaVersion"];
  const featureSetVersion = o["featureSetVersion"];
  const featureSet = o["featureSet"];

  if (typeof installedAt !== "number" || !Number.isFinite(installedAt) || installedAt < 0) {
    return null;
  }
  // Empty is VALID here and nowhere else: install.ts can legitimately run
  // outside a git checkout, and a build with no traceable commit is a fact to
  // record rather than a corrupt manifest to reject.
  if (typeof sourceRevision !== "string") return null;
  if (typeof contentHash !== "string" || contentHash === "") return null;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 0) {
    return null;
  }
  if (
    typeof featureSetVersion !== "number" ||
    !Number.isInteger(featureSetVersion) ||
    featureSetVersion < 0
  ) {
    return null;
  }
  if (!Array.isArray(featureSet) || featureSet.some((f) => typeof f !== "string")) return null;

  return {
    installedAt,
    sourceRevision,
    contentHash,
    schemaVersion,
    featureSetVersion,
    featureSet: featureSet as string[],
  };
}

/** Empty outside a repo; the roster simply omits the branch then. */
export function currentBranch(cwd: string): string {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "";
}

/**
 * How far a checkout has drifted from the branch it was cut from.
 *
 * `behind` is commits on the base that this checkout lacks; `ahead` is its own
 * commits the base lacks. Both null when there is no repo, no base branch, or
 * git refuses — an unknown answer must not read as zero, because zero is the
 * value that means "you are fine".
 *
 * WHY THIS EXISTS. An agent in a worktree cannot see this without asking, and
 * the natural way to ask — `git log` — shows the NEWEST commits, which after a
 * merge from the base are somebody else's. Measured 2026-08-02: an agent read
 * its own fourteen commits as missing that way and spent five tool calls
 * establishing they had landed. This is the same fact in 123 ms.
 *
 * BOTH NUMBERS OR NEITHER. `ahead` is what makes the advice safe: a branch with
 * its own commits must never be told to merge, because merging is a decision
 * with conflict cost that belongs to the agent.
 */
export interface BaseDistance {
  readonly behind: number;
  readonly ahead: number;
}

/**
 * The branch a worktree is measured against.
 *
 * Tried in order: whatever `origin/HEAD` points at, then the conventional names.
 * `origin/HEAD` is unset in plenty of clones — verified unset in THIS repo,
 * which is why the fallback list is load-bearing rather than decoration.
 *
 * Local refs only, deliberately: `worktree.baseRef: "head"` means worktrees here
 * branch from local HEAD, so local master is the honest base. Consulting a
 * remote would also put the network on the session-start path.
 */
const BASE_BRANCH_NAMES = ["master", "main", "trunk"] as const;

export function baseBranch(cwd: string): string {
  const head = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  // `origin/master` -> `master`. Local, per the note above.
  const named = head === null ? "" : (head.split("/").pop() ?? "");
  const candidates = named === "" ? BASE_BRANCH_NAMES : [named, ...BASE_BRANCH_NAMES];
  for (const name of candidates) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", name]) !== null) return name;
  }
  return "";
}

export function baseDistance(cwd: string, base: string): BaseDistance | null {
  if (base === "") return null;
  // One process for both numbers. `--count --left-right A...B` prints them as
  // `<left>\t<right>` — left is base-only (behind), right is ours (ahead).
  const out = git(cwd, ["rev-list", "--count", "--left-right", `${base}...HEAD`]);
  if (out === null) return null;
  const parts = out.split(/\s+/);
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  // A non-finite count means git printed something unexpected. Report unknown
  // rather than letting NaN reach a comparison, where `NaN >= 10` is false and
  // would silently mean "not stale".
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
  return { behind, ahead };
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
  // The prefix must end on a path BOUNDARY. A bare `startsWith` also matches a
  // sibling that merely shares the root as a string: with root
  // `I:/Projects/Traffic`, the file `I:/Projects/Traffic-experiments/x.ts`
  // yielded `-experiments/x.ts` — a relative-looking path that then slipped
  // past the outside-tree guard and was claimed as if it were in this repo.
  const inside =
    foldCase(s).startsWith(foldCase(rootNorm)) &&
    (s.length === rootNorm.length || s[rootNorm.length] === "/");
  return inside ? s.slice(rootNorm.length).replace(/^\//, "") : s;
}
