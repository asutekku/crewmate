/**
 * Board rendering: the arithmetic, not the colours.
 *
 * These exist because the first working version had two width bugs that only
 * appear in a terminal — padding computed from a PAINTED string (ANSI escapes
 * occupy no columns but do count toward `.length`), and `briefAge` used where
 * `briefAgo` belonged, printing "started just now ago". Both are invisible to a
 * store test and to a piped run.
 */

import { describe, expect, test } from "bun:test";

import { agentTally, briefAge, briefAgo, itemLines, PLAIN_PAINT, stepLine } from "../core/board.ts";
import type { WorkFold, WorkItem, WorkStep } from "../core/work.ts";

const NOW = 10_000_000;

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    workId: 1,
    agentId: "title:x",
    agentName: "old-core-80",
    subject: "retiring the old net core",
    startedMs: NOW - 2 * 60 * 60 * 1000,
    closedMs: 0,
    outcome: "",
    updatedMs: NOW - 4 * 60 * 1000,
    askedTurnMs: 0,
    auto: false,
    ...over,
  };
}

function step(idx: number, text: string, done: boolean, note = ""): WorkStep {
  return { workId: 1, idx, text, doneMs: done ? NOW - 1000 : 0, note };
}

const EMPTY_FOLD: WorkFold = { landed: [], breaks: [], needs: "", status: "" };

describe("briefAge / briefAgo", () => {
  test("briefAge is a duration; briefAgo adds the suffix only when it reads", () => {
    expect(briefAge(NOW - 4 * 60_000, NOW)).toBe("4m");
    expect(briefAgo(NOW - 4 * 60_000, NOW)).toBe("4m ago");
    // The sentinel: "just now ago" is not English, and it shipped once.
    expect(briefAge(NOW, NOW)).toBe("just now");
    expect(briefAgo(NOW, NOW)).toBe("just now");
  });

  test("scales through hours to days", () => {
    expect(briefAge(NOW - 2 * 3600_000, NOW)).toBe("2h");
    expect(briefAge(NOW - 40 * 3600_000, NOW)).toBe("40h");
    expect(briefAge(NOW - 5 * 24 * 3600_000, NOW)).toBe("5d");
  });

  test("a future timestamp clamps rather than going negative", () => {
    // Clocks skew between a hook and a CLI run; "-3m ago" is worse than "just now".
    expect(briefAge(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("itemLines", () => {
  test("header carries subject, progress and both ages", () => {
    const lines = itemLines(
      item(),
      [step(1, "delete buildGraph", true), step(2, "migrate callers", false)],
      EMPTY_FOLD,
      NOW,
      80,
      PLAIN_PAINT,
    );
    expect(lines[0]).toContain("retiring the old net core");
    expect(lines[0]).toContain("1/2");
    expect(lines[0]).toContain("2h · updated 4m");
  });

  test("no line exceeds the terminal width", () => {
    // A board that wraps loses the indentation that carries its structure.
    const long = "a".repeat(200);
    for (const width of [60, 80, 120]) {
      const lines = itemLines(
        item({ subject: long }),
        [step(1, long, false)],
        { landed: ["2f2ac31"], breaks: [long], needs: long, status: "" },
        NOW,
        width,
        PLAIN_PAINT,
      );
      for (const line of lines) expect([...line].length).toBeLessThanOrEqual(width);
    }
  });

  test("the age column survives a painted subject", () => {
    // The bug this catches: padding measured on a painted string counted ANSI
    // escapes as columns, so the age drifted left by ~8 chars per colour used —
    // and ONLY in a terminal, never in a piped test.
    const paint = { ...PLAIN_PAINT, bold: (s: string) => `[1m${s}[22m` };
    const painted = itemLines(item(), [], EMPTY_FOLD, NOW, 80, paint)[0] ?? "";
    const plainLine = itemLines(item(), [], EMPTY_FOLD, NOW, 80, PLAIN_PAINT)[0] ?? "";
    // Strip the escapes back out; the visible text must be identical.
    // eslint-disable-next-line no-control-regex
    expect(painted.replace(/\[[0-9;]*m/g, "")).toBe(plainLine);
  });

  test("an open item lists its checklist and marks the current step", () => {
    const lines = itemLines(
      item(),
      [step(1, "one", true), step(2, "two", false), step(3, "three", false)],
      EMPTY_FOLD,
      NOW,
      80,
      PLAIN_PAINT,
    );
    expect(lines.filter((l) => l.includes("← current"))).toHaveLength(1);
    expect(lines.find((l) => l.includes("← current"))).toContain("two");
  });

  test("a CLOSED item hides its checklist — history, not a to-do list", () => {
    const lines = itemLines(
      item({ closedMs: NOW - 3600_000, outcome: "done" }),
      [step(1, "one", true), step(2, "two", false)],
      EMPTY_FOLD,
      NOW,
      80,
      PLAIN_PAINT,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("closed 1h ago");
  });

  test("an abandoned item says so rather than reading as done", () => {
    const lines = itemLines(
      item({ closedMs: NOW - 60_000, outcome: "abandoned" }),
      [],
      EMPTY_FOLD,
      NOW,
      80,
      PLAIN_PAINT,
    );
    expect(lines[0]).toContain("abandoned");
  });

  test("landed, breaks and needs each get their own line", () => {
    const lines = itemLines(
      item(),
      [],
      {
        landed: ["2f2ac31", "3e36ff9"],
        breaks: ["seed 42 goes 143→213 strokes"],
        needs: "someone to re-record citizenBaseline",
        status: "",
      },
      NOW,
      100,
      PLAIN_PAINT,
    );
    const joined = lines.join("\n");
    expect(joined).toContain("2f2ac31");
    expect(joined).toContain("3e36ff9");
    expect(joined).toContain("⚠ breaks");
    expect(joined).toContain("143→213");
    expect(joined).toContain("needs");
  });

  test("a status shows only when there is no checklist to show instead", () => {
    const fold: WorkFold = { ...EMPTY_FOLD, status: "unwrapping the call sites" };
    const withSteps = itemLines(item(), [step(1, "one", false)], fold, NOW, 80, PLAIN_PAINT);
    const without = itemLines(item(), [], fold, NOW, 80, PLAIN_PAINT);
    // With a checklist the current step already says where the agent is; the
    // free-text status would repeat it one line lower.
    expect(withSteps.join("\n")).not.toContain("unwrapping the call sites");
    expect(without.join("\n")).toContain("unwrapping the call sites");
  });

  test("two breaks render as two lines, not one joined blob", () => {
    const lines = itemLines(
      item(),
      [],
      { ...EMPTY_FOLD, breaks: ["first consequence", "second consequence"] },
      NOW,
      80,
      PLAIN_PAINT,
    );
    expect(lines.filter((l) => l.includes("⚠ breaks"))).toHaveLength(2);
  });
});

describe("stepLine", () => {
  test("a ticked step is marked and a pending one is not", () => {
    expect(stepLine(step(1, "one", true), false, 80, PLAIN_PAINT)).toContain("✓");
    expect(stepLine(step(2, "two", false), false, 80, PLAIN_PAINT)).toContain("▪");
  });

  test("a note rides along with a pending step but not a ticked one", () => {
    // A ticked step's note is history; the eye should land on what is LEFT.
    expect(stepLine(step(1, "one", true, "went fine"), false, 80, PLAIN_PAINT)).not.toContain(
      "went fine",
    );
    expect(stepLine(step(1, "one", false, "half done"), false, 80, PLAIN_PAINT)).toContain(
      "half done",
    );
  });

  test("`width` is the WHOLE line's budget, including the current marker", () => {
    // The overflow this catches: the caller cannot know `← current` costs
    // another twelve columns, so a pre-subtracted text budget ran the marked
    // step — the one a reader most wants — past the terminal edge.
    for (const width of [40, 60, 80]) {
      const marked = stepLine(step(1, "x".repeat(200), false), true, width, PLAIN_PAINT);
      expect([...marked].length).toBeLessThanOrEqual(width);
      expect(marked).toContain("← current");
    }
  });
});

describe("agentTally", () => {
  test("counts only what is non-zero", () => {
    expect(agentTally(2, 1)).toBe("2 open · 1 closed");
    expect(agentTally(2, 0)).toBe("2 open");
    expect(agentTally(0, 3)).toBe("3 closed");
    expect(agentTally(0, 0)).toBe("");
  });
});
