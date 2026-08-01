/**
 * Plan links: the join that makes a plan's state knowable.
 *
 * THE CLAIM UNDER TEST is narrow and worth stating exactly, because the obvious
 * alternative is wrong. A plan document's own git history says nothing about
 * whether its work happened -- an agent writes the plan, implements it, and
 * never touches the file again. Measured live 2026-08-01: one agent had 4 of 6
 * steps done and a sha landed while its plan file had ZERO commits.
 *
 * So a plan's state is derived from the WORK, and the `landed` shas are the one
 * column that is evidence rather than assertion: an agent can tick a step it
 * did not do, but it cannot invent a sha that git printed.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { agentKey, normalisePlanPath } from "../core/work.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-plans-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
      } catch {
        // Already gone, or never created. Not worth a branch.
      }
    }
  }
});

const A = agentKey("", "aaaa-1111");
const B = agentKey("", "bbbb-2222");
const PLAN = "audit_reports/terrain-water/WATER_PLAN.md";

describe("normalisePlanPath", () => {
  test("two agents typing the same plan differently produce one key", () => {
    // The whole join depends on this. Divergent strings silently split one plan
    // into two, each looking half-finished.
    const forms = [
      PLAN,
      `./${PLAN}`,
      PLAN.replace(/\//g, "\\"),
      `i:\\Projects\\Traffic\\${PLAN.replace(/\//g, "\\")}`,
      `/home/me/Traffic/${PLAN}`,
      `${PLAN}/`,
    ];
    for (const f of forms) expect(normalisePlanPath(f)).toBe(PLAN);
  });

  test("keeps a file name -- it is NOT a diary scope", () => {
    // normaliseScope strips a filename to reach its folder, which is right for
    // a scope and exactly wrong here: the FILE is the thing being named.
    expect(normalisePlanPath("plans/COORDINATION_PLAN.md")).toBe("plans/COORDINATION_PLAN.md");
  });

  test("an unrecognised absolute path is left alone rather than guessed at", () => {
    // A wrong reduction splits one plan in two, which is worse than a long path.
    const odd = "some/unknown/root/MY_PLAN.md";
    expect(normalisePlanPath(odd)).toBe(odd);
  });

  test("empty and dot reduce to no link", () => {
    expect(normalisePlanPath("")).toBe("");
    expect(normalisePlanPath("  ")).toBe("");
    expect(normalisePlanPath(".")).toBe("");
  });
});

describe("an existing db gains the column", () => {
  test("a db created BEFORE plan_doc still opens", () => {
    // THE BUG THIS FILE MISSED FIRST TIME. The partial index on plan_doc was
    // declared inside `createWorkTables`, which `CREATE TABLE IF NOT EXISTS`
    // skips on a live db -- so the index ran against a column the migration had
    // not added yet and every hook and CLI call died with "no such column:
    // plan_doc". Every test here passed, because a fresh db builds the table
    // WITH the column and the migration is a no-op.
    //
    // Found by running `cli.ts link` against the real roster, not by a test.
    const path = `${tmpdir().replace(/\\/g, "/")}/presence-plans-legacy-${process.pid}-${n++}.db`;
    paths.push(path);

    // A db as it was before the column existed: open it, then drop the column
    // to simulate the older shape.
    withStore(path, (s) => {
      s.work.open(A, "ambrose", "pre-existing work", ["a"], 1000);
    });
    withStore(path, (s) => {
      (s as unknown as { db: { exec(q: string): void } }).db.exec(
        `DROP INDEX IF EXISTS work_plan; ALTER TABLE work DROP COLUMN plan_doc`,
      );
    });

    // Reopening must migrate rather than throw, and the old row must survive.
    withStore(path, (s) => {
      const item = s.work.target(A);
      expect(item?.subject).toBe("pre-existing work");
      expect(item?.planDoc).toBe("");
      expect(s.work.link(item?.workId ?? 0, PLAN, 2000)).toBe(true);
      expect(s.work.planRollups()[0]?.planDoc).toBe(PLAN);
    });
  });
});

describe("linking", () => {
  test("doing --plan-doc links at open", () => {
    fresh((s) => {
      const id = s.work.open(A, "ambrose", "water sinks", ["p0", "p1"], 1000, PLAN);
      expect(s.work.target(A)?.planDoc).toBe(PLAN);
      expect(s.work.events(id).some((e) => e.kind === "linked")).toBe(false);
    });
  });

  test("link points an already-open item at a plan", () => {
    // The usual case: an agent works for an hour, THEN notices there was a plan.
    fresh((s) => {
      const id = s.work.open(A, "ambrose", "water sinks", ["p0"], 1000);
      expect(s.work.target(A)?.planDoc).toBe("");
      expect(s.work.link(id, PLAN, 2000)).toBe(true);
      expect(s.work.target(A)?.planDoc).toBe(PLAN);
      const linked = s.work.events(id).filter((e) => e.kind === "linked");
      expect(linked).toHaveLength(1);
      expect(linked[0]?.ref).toBe(PLAN);
    });
  });

  test("link normalises, so a pasted IDE path still joins", () => {
    fresh((s) => {
      const id = s.work.open(A, "ambrose", "water", [], 1000);
      s.work.link(id, `i:\\Projects\\Traffic\\${PLAN.replace(/\//g, "\\")}`, 2000);
      expect(s.work.target(A)?.planDoc).toBe(PLAN);
    });
  });

  test("linking an unknown item reports failure instead of inventing a row", () => {
    fresh((s) => expect(s.work.link(9999, PLAN, 1000)).toBe(false));
  });

  test("a link can be removed", () => {
    fresh((s) => {
      const id = s.work.open(A, "ambrose", "water", [], 1000, PLAN);
      expect(s.work.link(id, "", 2000)).toBe(true);
      expect(s.work.target(A)?.planDoc).toBe("");
      expect(s.work.planRollups()).toHaveLength(0);
    });
  });
});

describe("planRollups", () => {
  test("an unlinked item appears in no rollup", () => {
    fresh((s) => {
      s.work.open(A, "ambrose", "unrelated work", ["a"], 1000);
      expect(s.work.planRollups()).toHaveLength(0);
    });
  });

  test("steps and shas roll up across every item on one plan", () => {
    // Two agents, one plan -- the case a per-item view cannot answer.
    fresh((s) => {
      const one = s.work.open(A, "ambrose", "water p0", ["a", "b"], 1000, PLAN);
      s.work.tick(one, 1, "did a", 1100);
      const two = s.work.open(B, "hopper", "water p1", ["c"], 1200, PLAN);
      s.work.tick(two, 1, "did c", 1300);
      s.work.record(one, "landed", "feat(water): sinks", 1400, "16a92ee");
      s.work.record(two, "landed", "feat(water): springs", 1500, "abc1234");

      const [p, ...rest] = s.work.planRollups();
      expect(rest).toHaveLength(0);
      expect(p?.planDoc).toBe(PLAN);
      expect(p?.stepsDone).toBe(2);
      expect(p?.stepsTotal).toBe(3);
      expect(p?.items).toHaveLength(2);
      expect(new Set(p?.agents)).toEqual(new Set(["ambrose", "hopper"]));
      expect(new Set(p?.shas)).toEqual(new Set(["16a92ee", "abc1234"]));
      expect(p?.openItems).toBe(2);
    });
  });

  test("THE MOTIVATING CASE: work moves while the plan file does not", () => {
    // 4 of 6 steps and a landed sha, with nothing at all said about the file.
    // A git-derived inventory reports this plan as untouched; this one does not.
    fresh((s) => {
      const id = s.work.open(A, "ambrose", "water", ["1", "2", "3", "4", "5", "6"], 1000, PLAN);
      for (const step of [1, 2, 4, 5]) s.work.tick(id, step, "", 1000 + step);
      s.work.record(id, "landed", "feat(water): the ground holds water", 1100, "16a92ee");

      const p = s.work.planRollups()[0];
      expect(p?.stepsDone).toBe(4);
      expect(p?.stepsTotal).toBe(6);
      expect(p?.shas).toEqual(["16a92ee"]);
    });
  });

  test("a sha is recorded once however many items report it", () => {
    fresh((s) => {
      const id = s.work.open(A, "ambrose", "water", [], 1000, PLAN);
      s.work.record(id, "landed", "same commit", 1100, "16a92ee");
      s.work.record(id, "landed", "same commit again", 1200, "16a92ee");
      expect(s.work.planRollups()[0]?.shas).toEqual(["16a92ee"]);
    });
  });

  test("closing every item leaves the plan visible, with its shas", () => {
    // A finished plan is the thing the user most wants to see; dropping it on
    // close would answer "which are done" with silence.
    fresh((s) => {
      const id = s.work.open(A, "ambrose", "water", ["a"], 1000, PLAN);
      s.work.record(id, "landed", "feat: done", 1100, "16a92ee");
      s.work.close(id, "done", "", 1200);

      const p = s.work.planRollups()[0];
      expect(p?.openItems).toBe(0);
      expect(p?.closedItems).toBe(1);
      expect(p?.shas).toEqual(["16a92ee"]);
    });
  });

  test("plans sort by most recent activity", () => {
    fresh((s) => {
      s.work.open(A, "ambrose", "old", [], 1000, "plans/OLD.md");
      s.work.open(A, "ambrose", "new", [], 5000, "plans/NEW.md");
      expect(s.work.planRollups().map((p) => p.planDoc)).toEqual(["plans/NEW.md", "plans/OLD.md"]);
    });
  });

  test("an item with no steps contributes no false progress", () => {
    // 0/0 must not read as complete, and must not crash the ratio.
    fresh((s) => {
      s.work.open(A, "ambrose", "water", [], 1000, PLAN);
      const p = s.work.planRollups()[0];
      expect(p?.stepsDone).toBe(0);
      expect(p?.stepsTotal).toBe(0);
    });
  });
});
