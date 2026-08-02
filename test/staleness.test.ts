/**
 * The base-staleness warning: what it says, and the far larger question of when
 * it says nothing.
 *
 * WHY THE SILENCE IS THE FEATURE. 27 of this repo's 42 worktrees are stale and
 * most are abandoned; the value comes from scoping the warning to the session
 * actually sitting in one. A hook that speaks when nothing is wrong gets
 * scrolled past, and takes the lines around it with it.
 *
 * THE SAFETY RULE HAS ITS OWN TEST BECAUSE IT IS THE DANGEROUS PART. A branch
 * with commits of its own must never be told to merge, and no phrasing may ever
 * name `rebase`, `reset` or `checkout` — CLAUDE.md rules those out precisely
 * because they can swallow another agent's uncommitted work.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { baseStalenessLines, STALE_COMMITS } from "../core/shared.ts";
import { withStore } from "../core/store.ts";

let n = 0;
const paths: string[] = [];

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
      } catch {
        // Already gone, or never created.
      }
    }
  }
});

const at = (behind: number, ahead = 0): { behind: number; ahead: number } => ({ behind, ahead });

describe("when it speaks", () => {
  test("a stale worktree with nothing of its own is told to merge", () => {
    const lines = baseStalenessLines(at(47), "master", true);
    const text = lines.join("\n");
    expect(text).toContain("47 commits behind master");
    expect(text).toContain("git merge master");
  });

  test("the numbers come from the distance, not from a guess", () => {
    // 845 is the real worst case in this repo, measured 2026-08-02.
    expect(baseStalenessLines(at(845), "master", true).join("\n")).toContain("845");
  });

  test("it names the base it actually measured against", () => {
    // The hook is installed user-wide and runs in repos that use `main`.
    const text = baseStalenessLines(at(30), "main", true).join("\n");
    expect(text).toContain("behind main");
    expect(text).toContain("git merge main");
    expect(text).not.toContain("master");
  });

  test("no line runs away", () => {
    // Session-start context is paid by every agent on every session.
    for (const line of baseStalenessLines(at(845, 51), "master", true)) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("a branch with commits of its own", () => {
  test("is NEVER told to merge", () => {
    // THE LOAD-BEARING ASSERTION. Merging is a decision with conflict cost that
    // belongs to the agent; a hook that pushes it is one that loses work.
    const text = baseStalenessLines(at(298, 51), "master", true).join("\n");
    expect(text).not.toContain("git merge");
  });

  test("is told both numbers, so it can judge", () => {
    const text = baseStalenessLines(at(298, 51), "master", true).join("\n");
    expect(text).toContain("298");
    expect(text).toContain("51");
  });

  test("is warned that `git log` will not show its work on top", () => {
    // The exact confusion this whole feature exists for: after a merge from the
    // base, the newest commits are someone else's, so an agent reads its own
    // commits as missing. Measured — it cost five tool calls to disprove.
    expect(baseStalenessLines(at(298, 51), "master", true).join("\n")).toContain("git log");
  });
});

describe("it never suggests a command that could eat another agent's work", () => {
  // CLAUDE.md rule 5: no stash, no reset --hard, no checkout ., no clean. The
  // tree is shared and uncommitted work in it belongs to several sessions.
  const FORBIDDEN = ["rebase", "reset", "stash", "checkout", "clean", "--force", "-f "];

  test("in either phrasing, at any distance", () => {
    for (const ahead of [0, 51]) {
      for (const behind of [10, 47, 845]) {
        const text = baseStalenessLines(at(behind, ahead), "master", true).join("\n");
        for (const word of FORBIDDEN) expect(text).not.toContain(word);
      }
    }
  });
});

describe("when it stays quiet", () => {
  test("the main tree says nothing, however far anything has moved", () => {
    // The main tree IS the base. A count there is noise on every session.
    expect(baseStalenessLines(at(845), "master", false)).toEqual([]);
  });

  test("an in-sync worktree says nothing", () => {
    expect(baseStalenessLines(at(0), "master", true)).toEqual([]);
  });

  test("a worktree just under the threshold says nothing", () => {
    expect(baseStalenessLines(at(STALE_COMMITS - 1), "master", true)).toEqual([]);
    // And exactly at it, does.
    expect(baseStalenessLines(at(STALE_COMMITS), "master", true)).not.toHaveLength(0);
  });

  test("an unknown distance says nothing", () => {
    // `null` is what git-refused looks like. Guessing here would be the worst
    // outcome: a confident wrong number about someone's checkout.
    expect(baseStalenessLines(null, "master", true)).toEqual([]);
  });

  test("an unresolvable base says nothing", () => {
    // A repo with no master/main/trunk, or a fresh one with no commits.
    expect(baseStalenessLines(at(845), "", true)).toEqual([]);
  });
});

describe("the cached column", () => {
  test("an unmeasured session reads -1, not 0", () => {
    // 0 means "in sync" and would tell every peer this checkout is current when
    // nobody has looked. The default has to be the value that claims nothing.
    const path = `${tmpdir().replace(/\\/g, "/")}/presence-stale-${process.pid}-${n++}.db`;
    paths.push(path);
    withStore(path, (s) => {
      s.register("sess-a", "I:/tree", "master", 1000);
      expect(s.liveSessions(1000)[0]?.behindBase).toBe(-1);
      expect(s.liveSessions(1000)[0]?.baseBranch).toBe("");
    });
  });

  test("a measured distance round-trips", () => {
    const path = `${tmpdir().replace(/\\/g, "/")}/presence-stale-${process.pid}-${n++}.db`;
    paths.push(path);
    withStore(path, (s) => {
      s.register("sess-a", "I:/tree", "feature", 1000);
      s.setBaseDistance("sess-a", 298, "master");
      const row = s.liveSessions(1000)[0];
      expect(row?.behindBase).toBe(298);
      expect(row?.baseBranch).toBe("master");
    });
  });

  test("a db created BEFORE the columns still opens, and the old row survives", () => {
    // THE BUG CLASS THIS REPO HAS ALREADY SHIPPED ONCE. A fresh-db test cannot
    // see it: a fresh db builds `sessions` WITH the columns, so the migration is
    // a no-op and everything passes while every live db throws "no such column".
    // Found last time by running the CLI against the real roster, not by a test.
    const path = `${tmpdir().replace(/\\/g, "/")}/presence-stale-legacy-${process.pid}-${n++}.db`;
    paths.push(path);

    withStore(path, (s) => s.register("sess-old", "I:/tree", "master", 1000));
    withStore(path, (s) => {
      (s as unknown as { db: { exec(q: string): void } }).db.exec(
        `ALTER TABLE sessions DROP COLUMN behind_base;
         ALTER TABLE sessions DROP COLUMN base_branch`,
      );
    });

    withStore(path, (s) => {
      const row = s.liveSessions(1000)[0];
      expect(row?.sessionId).toBe("sess-old");
      expect(row?.behindBase).toBe(-1);
      s.setBaseDistance("sess-old", 47, "master");
      expect(s.liveSessions(1000)[0]?.behindBase).toBe(47);
    });
  });
});
