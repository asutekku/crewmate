/**
 * The pre-edit suggestion that makes plan links happen at all.
 *
 * WHY IT MATTERS MORE THAN ITS SIZE. `--plan-doc` and `link` shipped and
 * nothing pointed at them, which is exactly how `breaks` and `needs` ended up
 * used by nobody but their author. `crew plans` is only as good as the links
 * it has: one plan out of 82, until this hook started asking.
 *
 * SO MOST OF THIS FILE IS ABOUT STAYING QUIET. A hook that speaks on every plan
 * edit gets scrolled past, and then the diary lines above it get scrolled past
 * too — which would cost more than the feature is worth.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { agentKey } from "../core/work.ts";
import { looksLikePlan, planLinkLine } from "../hooks/pre-edit.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-planlink-${process.pid}-${n++}.db`;
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

const SESSION = "aaaa-1111";
const AGENT = agentKey("", SESSION);
const PLAN = ".claude/hooks/presence/plans/COORDINATION_PLAN.md";

describe("looksLikePlan", () => {
  test("recognises the real plans in this repo", () => {
    // Sampled from the 82 actually on disk, not invented.
    for (const p of [
      "audit_reports/roadmaps/CS_PARITY_ROADMAP.md",
      "audit_reports/terrain-water/WATER_DYNAMICS_PLAN.md",
      "audit_reports/roadmaps/INDUSTRY_CHAINS_EFFORT_20260729.md",
      ".claude/hooks/presence/plans/LINEAGE_PLAN.md",
      "docs/plans/SOME_PLAN.md",
    ]) {
      expect(looksLikePlan(p)).toBe(true);
    }
  });

  test("windows separators still match", () => {
    expect(looksLikePlan("audit_reports\\roadmaps\\CS_PARITY_ROADMAP.md")).toBe(true);
  });

  test("a system note is NOT a plan", () => {
    // The loose rule ("any .md under docs/") would fire on all of these, and a
    // suggestion on every doc edit is one nobody reads.
    for (const p of [
      "docs/systems/water.md",
      "docs/architecture/overview.md",
      "README.md",
      "docs/README.md",
      "CLAUDE.md",
    ]) {
      expect(looksLikePlan(p)).toBe(false);
    }
  });

  test("a dedicated plans folder is enough — the filename need not repeat it", () => {
    // MEASURED against this repo's real corpus, which is how the first version
    // was caught: requiring the PLAN/ROADMAP/EFFORT stem missed 6 of 76,
    // because `docs/plans/junction-editor.md` is a plan whose name never says
    // so. The folder has already made the claim.
    for (const p of [
      "docs/plans/junction-editor.md",
      "docs/plans/population-growth.md",
      ".claude/hooks/presence/plans/README.md",
    ]) {
      expect(looksLikePlan(p)).toBe(true);
    }
  });

  test("an AUDIT under audit_reports is a finding, not a plan", () => {
    // The distinction the repo already draws: an audit is a dated snapshot of
    // an investigation, a plan is a spec for work. Linking work to an audit
    // would misreport what shipped against it.
    expect(looksLikePlan("audit_reports/roadmaps/CITIZEN_FINAL_AUDIT.md")).toBe(false);
    expect(looksLikePlan("audit_reports/roadmaps/CODE_ROT_SWEEP.md")).toBe(false);
  });

  test("a plan-named file outside a plan folder is not a plan", () => {
    // `src/sim/PLANNER.ts` and friends: the name alone is not enough.
    expect(looksLikePlan("src/city/PLAN_helpers.md")).toBe(false);
  });

  test("source code is never a plan, whatever it is called", () => {
    expect(looksLikePlan("audit_reports/roadmaps/PLAN.ts")).toBe(false);
    expect(looksLikePlan("plans/ROADMAP.tsx")).toBe(false);
  });
});

describe("when it speaks", () => {
  test("an open unlinked item editing a plan gets the suggestion", () => {
    fresh((s) => {
      s.work.open(AGENT, "hopper", "coordination gaps", ["a"], 1000);
      const lines = planLinkLine(s, SESSION, PLAN);
      expect(lines.length).toBeGreaterThan(0);
      // THE COMMAND MUST BE RUNNABLE AS PRINTED. A hook that names a command
      // returning nothing has shipped here twice; the path in the advice is the
      // normalised one `link` will store.
      expect(lines.join("\n")).toContain(`crew link ${PLAN}`);
    });
  });

  test("no line runs away, however long the subject", () => {
    // FOUND BY LOOKING AT OUTPUT, not by a test — the first version put the
    // command and the subject on one line and produced 156 characters against
    // a real item, because a work subject is a sentence. The command is the
    // part meant to be copied, so it is the part that must not wrap.
    fresh((s) => {
      s.work.open(
        AGENT,
        "hopper",
        "a deliberately very long subject that goes on and on describing several phases of work",
        [],
        1000,
      );
      for (const line of planLinkLine(s, SESSION, PLAN)) {
        expect(line.length).toBeLessThanOrEqual(100);
      }
    });
  });

  test("the suggestion names the item, so it is obvious what gets linked", () => {
    fresh((s) => {
      s.work.open(AGENT, "hopper", "coordination gaps", [], 1000);
      expect(planLinkLine(s, SESSION, PLAN).join("\n")).toContain("coordination gaps");
    });
  });

  test("a pasted absolute path is normalised in the advice", () => {
    fresh((s) => {
      s.work.open(AGENT, "hopper", "water", [], 1000);
      const win = "i:\\Projects\\Traffic\\audit_reports\\terrain-water\\WATER_PLAN.md";
      expect(planLinkLine(s, SESSION, win).join("\n")).toContain(
        "crew link audit_reports/terrain-water/WATER_PLAN.md",
      );
    });
  });

  test("it repeats while the item is still unlinked", () => {
    // Deliberate. The condition is "is this item unlinked", not "have we said
    // it" — a said-once flag would be a column whose only job is suppressing
    // true advice, and this tool has already shipped one row nobody cleared.
    fresh((s) => {
      s.work.open(AGENT, "hopper", "coordination gaps", [], 1000);
      expect(planLinkLine(s, SESSION, PLAN)).not.toHaveLength(0);
      expect(planLinkLine(s, SESSION, PLAN)).not.toHaveLength(0);
    });
  });
});

describe("when it stays quiet", () => {
  test("editing an ordinary file says nothing", () => {
    fresh((s) => {
      s.work.open(AGENT, "hopper", "coordination gaps", [], 1000);
      expect(planLinkLine(s, SESSION, "src/sim/water/flow.ts")).toEqual([]);
    });
  });

  test("no open item means nothing to link", () => {
    // Suggesting `doing` here would be a different, unasked-for lecture.
    fresh((s) => expect(planLinkLine(s, SESSION, PLAN)).toEqual([]));
  });

  test("an item ALREADY linked to this plan says nothing", () => {
    fresh((s) => {
      s.work.open(AGENT, "hopper", "coordination gaps", [], 1000, PLAN);
      expect(planLinkLine(s, SESSION, PLAN)).toEqual([]);
    });
  });

  test("an item linked to ANOTHER plan says nothing", () => {
    // The agent has already decided. A hook that argues with a decision is one
    // that gets ignored on the occasion it is right.
    fresh((s) => {
      s.work.open(AGENT, "hopper", "water", [], 1000, "audit_reports/terrain-water/WATER_PLAN.md");
      expect(planLinkLine(s, SESSION, PLAN)).toEqual([]);
    });
  });

  test("a closed item does not count as open", () => {
    fresh((s) => {
      const id = s.work.open(AGENT, "hopper", "coordination gaps", [], 1000);
      s.work.close(id, "done", "", 2000);
      expect(planLinkLine(s, SESSION, PLAN)).toEqual([]);
    });
  });

  test("another agent's open item is not mine to link", () => {
    fresh((s) => {
      s.work.open(agentKey("", "bbbb-2222"), "ambrose", "water", [], 1000);
      expect(planLinkLine(s, SESSION, PLAN)).toEqual([]);
    });
  });
});
