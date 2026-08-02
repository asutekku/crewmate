/**
 * `baseDistance` and `baseBranch` against REAL git repos, built per test.
 *
 * WHY NOT A STUB. The value of these two functions is entirely in whether they
 * parse what git actually prints, so a fake `git` would test the fake. The
 * failure mode is well known in this repo: a stubbed fixture once produced eight
 * green tests over wiring that never ran.
 *
 * The repos are tiny (three commits) and land in the OS temp dir, never in the
 * shared tree — a test that runs `git` inside this repo would be reading state
 * three other agents are writing.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, test } from "bun:test";

import { baseBranch, baseDistance } from "../core/repo.ts";

const made: string[] = [];

function run(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

function commit(dir: string, text: string): void {
  // SYNCHRONOUS deliberately. `Bun.write` returns a promise, and an unawaited
  // one let `git add` run before the file existed — git then had nothing to
  // stage and `commit` exited non-zero on an empty index.
  writeFileSync(`${dir}/f.txt`, text);
  run(dir, "add", "f.txt");
  run(dir, "commit", "-m", text);
}

/** A repo with `base` at 2 commits and a branch cut from its first. */
function repo(baseName: string): string {
  const dir = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/presence-basedist-`).replace(/\\/g, "/");
  made.push(dir);
  run(dir, "init", "-q", `--initial-branch=${baseName}`);
  run(dir, "config", "user.email", "t@example.com");
  run(dir, "config", "user.name", "t");
  // No GPG signing, no hooks: the ambient user config must not reach these.
  run(dir, "config", "commit.gpgsign", "false");
  commit(dir, "one");
  return dir;
}

afterAll(() => {
  for (const d of made) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // A locked file on Windows; the temp dir is the OS's problem then.
    }
  }
});

describe("baseDistance", () => {
  test("a fresh checkout is 0 and 0", () => {
    const dir = repo("master");
    expect(baseDistance(dir, "master")).toEqual({ behind: 0, ahead: 0 });
  });

  test("behind counts commits the base has and we do not", () => {
    const dir = repo("master");
    run(dir, "checkout", "-q", "-b", "feature");
    run(dir, "checkout", "-q", "master");
    commit(dir, "two");
    commit(dir, "three");
    run(dir, "checkout", "-q", "feature");
    expect(baseDistance(dir, "master")).toEqual({ behind: 2, ahead: 0 });
  });

  test("ahead counts our own commits, and the two are independent", () => {
    // THE CASE THE SAFETY RULE TURNS ON. Getting these the wrong way round
    // would tell a branch with unmerged work to merge.
    const dir = repo("master");
    run(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "mine-a");
    run(dir, "checkout", "-q", "master");
    commit(dir, "theirs");
    run(dir, "checkout", "-q", "feature");
    expect(baseDistance(dir, "master")).toEqual({ behind: 1, ahead: 1 });
  });

  test("a branch merged INTO the base reports 0 ahead", () => {
    // Exactly what confused akira: the work landed, the worktree fast-forwarded,
    // and `git log` then showed someone else's commits on top. The number must
    // say "nothing of your own is unmerged", because that is the truth.
    const dir = repo("master");
    run(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "mine");
    run(dir, "checkout", "-q", "master");
    run(dir, "merge", "-q", "--ff-only", "feature");
    run(dir, "checkout", "-q", "feature");
    expect(baseDistance(dir, "master")).toEqual({ behind: 0, ahead: 0 });
  });

  test("an unknown base is null, never zero", () => {
    // Zero means "you are fine" and is the one answer that must be earned.
    const dir = repo("master");
    expect(baseDistance(dir, "no-such-branch")).toBeNull();
    expect(baseDistance(dir, "")).toBeNull();
  });

  test("outside a repo it is null", () => {
    const outside = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/presence-nogit-`);
    made.push(outside);
    expect(baseDistance(outside.replace(/\\/g, "/"), "master")).toBeNull();
  });
});

describe("baseBranch", () => {
  test("finds master", () => {
    expect(baseBranch(repo("master"))).toBe("master");
  });

  test("finds main — the hook is installed user-wide, not just for this repo", () => {
    expect(baseBranch(repo("main"))).toBe("main");
  });

  test("is empty when no conventional base exists", () => {
    // A repo whose only branch is something else entirely. Empty means the
    // warning stays silent, which is the right answer for "I cannot tell".
    const dir = repo("develop");
    expect(baseBranch(dir)).toBe("");
    expect(baseDistance(dir, baseBranch(dir))).toBeNull();
  });

  test("outside a repo it is empty", () => {
    const outside = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/presence-nogit-`);
    made.push(outside);
    expect(baseBranch(outside.replace(/\\/g, "/"))).toBe("");
  });
});
