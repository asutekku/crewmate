/**
 * Bug state: the one field that separates a bug list from a log.
 *
 * The diary was ALREADY a bug list -- `kind: error` plus `--scope` is a bug
 * report. What it lacked is state: a finding is true forever, a bug is open
 * until something fixes it.
 *
 * THE ASYMMETRY IS THE DESIGN, and most of this file defends it. Only an error
 * can be fixed. A finding is a fact ("an UPDATE on an external-content FTS5
 * table does nothing to the index") that stays true after someone works around
 * it, so a "fixed" marker on one would mean "we have stopped believing this" --
 * which is what `deprecate` is for. Refusing that is what keeps `bugs` a list
 * of things to DO rather than a list of things known.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import type { DiaryKind } from "../core/diary.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-bugs-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}

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

type Store = Parameters<Parameters<typeof withStore>[1]>[0];

function entry(s: Store, kind: DiaryKind, title: string, scope = "src/sim/water"): number {
  return s.diary.write(
    "sess-1",
    "hopper",
    { title, body: "", topic: "water", tags: [], kind, scope },
    1000,
  );
}

describe("only an error has open state", () => {
  test("an error can be fixed", () => {
    fresh((s) => {
      const bug = entry(s, "error", "springs render below the water plane");
      const fix = entry(s, "finding", "the spring pad reads seatY, not terrain height");
      expect(s.diary.fix(bug, fix, 2000)).toBe(true);
      expect(s.diary.get(bug)?.fixedBy).toBe(fix);
    });
  });

  test("a finding CANNOT be fixed", () => {
    // The core rule. A finding is knowledge; closing it is meaningless, and
    // allowing it would turn `bugs` into a list of things people have read.
    fresh((s) => {
      const finding = entry(s, "finding", "dist2 is linear despite the name");
      expect(s.diary.fix(finding, entry(s, "finding", "anything"), 2000)).toBe(false);
      expect(s.diary.get(finding)?.fixedMs).toBe(0);
    });
  });

  test("a warning cannot be fixed either", () => {
    fresh((s) => {
      const warn = entry(s, "warning", "PRESENCE_TEST_DB must be absolute");
      expect(s.diary.fix(warn, entry(s, "finding", "x"), 2000)).toBe(false);
    });
  });

  test("an optimization cannot be fixed", () => {
    fresh((s) => {
      const opt = entry(s, "optimization", "the active set could skip dry cells");
      expect(s.diary.fix(opt, entry(s, "finding", "x"), 2000)).toBe(false);
    });
  });
});

describe("fixing", () => {
  test("a bug cannot be fixed twice", () => {
    fresh((s) => {
      const bug = entry(s, "error", "a bug");
      expect(s.diary.fix(bug, entry(s, "finding", "first fix"), 2000)).toBe(true);
      expect(s.diary.fix(bug, entry(s, "finding", "second fix"), 3000)).toBe(false);
    });
  });

  test("an entry cannot fix itself", () => {
    fresh((s) => {
      const bug = entry(s, "error", "a bug");
      expect(s.diary.fix(bug, bug, 2000)).toBe(false);
    });
  });

  test("fixing by a nonexistent entry is refused", () => {
    // Otherwise a typo in --fixes silently records a pointer to nothing.
    fresh((s) => {
      const bug = entry(s, "error", "a bug");
      expect(s.diary.fix(bug, 9999, 2000)).toBe(false);
      expect(s.diary.get(bug)?.fixedMs).toBe(0);
    });
  });

  test("fixing an unknown bug is refused", () => {
    fresh((s) => expect(s.diary.fix(9999, entry(s, "finding", "x"), 2000)).toBe(false));
  });

  test("A FIX DOES NOT DEPRECATE THE BUG — it stays true as history", () => {
    // The bug WAS real. The next reader hitting the same symptom wants to find
    // it and follow the link to the fix, not to find nothing because it was
    // tidied away.
    fresh((s) => {
      const bug = entry(s, "error", "springs render below the water plane");
      s.diary.fix(bug, entry(s, "finding", "the fix"), 2000);
      const after = s.diary.get(bug);
      expect(after?.deprecatedMs).toBe(0);
      expect(after?.fixedMs).toBe(2000);
    });
  });
});

describe("openBugs", () => {
  test("lists unfixed errors and nothing else", () => {
    fresh((s) => {
      entry(s, "error", "open bug");
      entry(s, "finding", "a finding");
      entry(s, "warning", "a warning");
      const fixed = entry(s, "error", "fixed bug");
      s.diary.fix(fixed, entry(s, "finding", "the fix"), 2000);

      const open = s.diary.openBugs();
      expect(open.map((b) => b.title)).toEqual(["open bug"]);
    });
  });

  test("a deprecated error is not an open bug", () => {
    // An error that stopped being true is a mistake in the record, not work.
    fresh((s) => {
      const bug = entry(s, "error", "was never actually a bug");
      s.diary.deprecate(bug, "misdiagnosed — the pad was correct", 2000);
      expect(s.diary.openBugs()).toHaveLength(0);
    });
  });

  test("scope filters to the folder and its parents", () => {
    fresh((s) => {
      entry(s, "error", "water bug", "src/sim/water");
      entry(s, "error", "traffic bug", "src/sim/traffic");
      expect(s.diary.openBugs("src/sim/water").map((b) => b.title)).toEqual(["water bug"]);
    });
  });

  test("a repo-wide bug surfaces under any scope", () => {
    fresh((s) => {
      entry(s, "error", "everywhere bug", "");
      expect(s.diary.openBugs("src/sim/water").map((b) => b.title)).toEqual(["everywhere bug"]);
    });
  });

  test("newest first, and the limit is honoured", () => {
    fresh((s) => {
      for (let i = 0; i < 5; i++) entry(s, "error", `bug ${i}`);
      const open = s.diary.openBugs("", 2);
      expect(open).toHaveLength(2);
      expect(open[0]?.title).toBe("bug 4");
    });
  });

  test("no open bugs reads as empty, not as an error", () => {
    fresh((s) => expect(s.diary.openBugs()).toEqual([]));
  });
});
