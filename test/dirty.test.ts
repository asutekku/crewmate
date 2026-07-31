/**
 * "Is this file actually uncommitted?" — the check that stops the overlap
 * warning crying wolf.
 *
 * Measured on the live roster 2026-08-01: 38 of 42 claims were on files with no
 * uncommitted changes. A claim is released by nothing but a 2-hour timer, so an
 * agent that edited a file, committed it and moved on still held it — and peers
 * kept replying "that's committed" to warnings about conflicts that no longer
 * existed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { clearDirtyCache, dirtyFiles } from "../core/dirty.ts";

let repo = "";

const git = (args: string[], cwd = repo): void => {
  spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
};

beforeAll(() => {
  repo = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/presence-dirty-`).replace(/\\/g, "/");
  git(["init", "-q", "."]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(`${repo}/committed.ts`, "export const a = 1;\n");
  writeFileSync(`${repo}/also-committed.ts`, "export const b = 2;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterAll(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
  } catch {
    /* windows sometimes holds the .git handle briefly */
  }
});

describe("dirtyFiles", () => {
  test("a committed file is NOT dirty — the whole point", () => {
    clearDirtyCache();
    const dirty = dirtyFiles(repo);
    expect(dirty).not.toBeNull();
    expect(dirty!.has("committed.ts")).toBe(false);
  });

  test("a modified file IS dirty", () => {
    writeFileSync(`${repo}/committed.ts`, "export const a = 99;\n");
    clearDirtyCache();
    expect(dirtyFiles(repo)!.has("committed.ts")).toBe(true);
  });

  test("an untracked file is dirty too", () => {
    // A brand-new file an agent is writing is uncommitted work like any other,
    // and `--untracked-files=all` is what makes it visible.
    writeFileSync(`${repo}/brand-new.ts`, "export const c = 3;\n");
    clearDirtyCache();
    expect(dirtyFiles(repo)!.has("brand-new.ts")).toBe(true);
  });

  test("committing a file makes it clean again", () => {
    // The transition the whole feature exists for: the warning must stop.
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "second"]);
    clearDirtyCache();
    const dirty = dirtyFiles(repo)!;
    expect(dirty.has("committed.ts")).toBe(false);
    expect(dirty.has("brand-new.ts")).toBe(false);
  });

  test("paths are repo-relative and forward-slashed, so claims can match", () => {
    // A claim stores `src/gen/terrain.ts`; if this returned an absolute or
    // backslashed path, every comparison would silently miss and the filter
    // would drop every warning.
    writeFileSync(`${repo}/nested.ts`, "x\n");
    clearDirtyCache();
    for (const p of dirtyFiles(repo)!) {
      expect(p).not.toContain("\\");
      expect(p.startsWith("/")).toBe(false);
      expect(/^[A-Za-z]:/.test(p)).toBe(false);
    }
  });

  test("NULL when git cannot answer, which is not the same as clean", () => {
    // Load-bearing: "no dirty files" means every claim is stale, while "we do
    // not know" must leave every warning exactly as it was. Collapsing the two
    // would silence the channel the first time this ran outside a repo.
    clearDirtyCache();
    const outside = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/presence-nogit-`);
    try {
      expect(dirtyFiles(outside.replace(/\\/g, "/"))).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the answer is cached per worktree", () => {
    // `git status` is ~40 ms and a warning may name several claims; paying it
    // once per tree is what makes the check affordable on a hook path.
    clearDirtyCache();
    const first = dirtyFiles(repo);
    // Change the tree WITHOUT clearing: a cached answer must not re-shell.
    writeFileSync(`${repo}/cache-probe.ts`, "y\n");
    expect(dirtyFiles(repo)).toBe(first!);
    clearDirtyCache();
    expect(dirtyFiles(repo)!.has("cache-probe.ts")).toBe(true);
  });

  test("a renamed file reports its NEW name", () => {
    // `git status` emits "R  old -> new", and the new name is the one a claim
    // recorded when the agent edited it.
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "third"]);
    git(["mv", "nested.ts", "renamed.ts"]);
    clearDirtyCache();
    const dirty = dirtyFiles(repo)!;
    expect(dirty.has("renamed.ts")).toBe(true);
    expect(dirty.has("nested.ts")).toBe(false);
  });

  test("a path containing a space survives quoting", () => {
    // git quotes such paths; an unparsed quote would put `"with space.ts"` in
    // the set and the claim for `with space.ts` would never match it.
    writeFileSync(`${repo}/with space.ts`, "z\n");
    clearDirtyCache();
    expect(dirtyFiles(repo)!.has("with space.ts")).toBe(true);
  });
});
