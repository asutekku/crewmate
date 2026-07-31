/**
 * Roster layout arithmetic.
 *
 * Every case here is a rendering fault that reached the terminal. The previous
 * `who` produced lines of 78–276 characters against an 80-column window, so long
 * rows wrapped and a wrapped row is indistinguishable from a new agent's — with
 * seven agents live the output was unreadable, which is what prompted this.
 *
 * Widths are asserted in code points rather than eyeballed: colour codes come
 * BEFORE a field's text, so a mis-sized column looks fine in a terminal and is
 * only visible by counting.
 */

import { describe, expect, test } from "bun:test";

import {
  commonDir,
  fit,
  isScratchPath,
  pad,
  renderFileLine,
  shortAge,
  summarizeFiles,
} from "../core/layout.ts";

const width = (s: string): number => [...s].length;

describe("fit", () => {
  test("leaves text that already fits untouched", () => {
    expect(fit("short", 20)).toBe("short");
  });

  test("never exceeds the budget, ellipsis included", () => {
    // The whole point: one character over and the line wraps, costing a row and
    // breaking the column alignment for everything below it.
    for (const max of [1, 5, 12, 40]) {
      expect(width(fit("a".repeat(200), max))).toBeLessThanOrEqual(max);
    }
  });

  test("marks that it truncated", () => {
    expect(fit("abcdefghij", 5)).toBe("abcd…");
  });

  test("counts code points, so an emoji is not split into a broken half", () => {
    // "🔥".length is 2 in UTF-16; slicing by that unit yields a lone surrogate
    // and renders as a replacement box in the middle of the roster.
    const out = fit("🔥🔥🔥🔥", 3);
    expect(width(out)).toBeLessThanOrEqual(3);
    expect(out).not.toContain("�");
  });
});

describe("pad", () => {
  test("pads a short string to exactly the column width", () => {
    expect(width(pad("ada", 10))).toBe(10);
  });

  test("leaves an over-long string alone rather than silently cutting it", () => {
    // Truncation is `fit`'s job. Doing it here too would mean a caller that
    // forgot to `fit` gets a quietly different result instead of a visible one.
    expect(pad("a-very-long-agent-name", 5)).toBe("a-very-long-agent-name");
  });
});

describe("isScratchPath", () => {
  test("recognises the probe directories agents actually create", () => {
    // Measured live: one session held 17 of 18 claims in tmpprobe/, and another
    // 7 in tmpwb/ — together the bulk of a 276-character roster line.
    expect(isScratchPath("tmpprobe/r2size.ts")).toBe(true);
    expect(isScratchPath("tmpwb/trace.ts")).toBe(true);
    expect(isScratchPath("scratchpad/probe.ts")).toBe(true);
    expect(isScratchPath(".p3msg.tmp")).toBe(true);
    expect(isScratchPath("node_modules/three/build.js")).toBe(true);
  });

  test("does not mistake real source for scratch", () => {
    // Over-eager matching here HIDES a real collision, which is worse than the
    // noise it removes.
    expect(isScratchPath("src/sim/water/waterSim.ts")).toBe(false);
    expect(isScratchPath("docs/systems/water-sim.md")).toBe(false);
    expect(isScratchPath("test/bench/waterWorld.ts")).toBe(false);
    expect(isScratchPath("src/template/index.ts")).toBe(false);
  });
});

describe("commonDir", () => {
  test("finds the shared directory of a set of paths", () => {
    expect(commonDir(["a/b/one.ts", "a/b/two.ts", "a/b/three.ts"])).toBe("a/b");
  });

  test("stops at the point the paths diverge", () => {
    expect(commonDir(["a/b/one.ts", "a/c/two.ts"])).toBe("a");
  });

  test("returns empty when nothing is shared", () => {
    expect(commonDir(["a/one.ts", "b/two.ts"])).toBe("");
    expect(commonDir([])).toBe("");
  });
});

describe("summarizeFiles", () => {
  const contested = new Set(["docs/systems/water-sim.md"]);

  test("collapses a long list to its shared directory", () => {
    const paths = Array.from({ length: 13 }, (_, i) => `.claude/hooks/presence/core/f${i}.ts`);
    const text = summarizeFiles(paths).map((p) => p.text);
    expect(text).toEqual([".claude/hooks/presence/core/ (13 files)"]);
  });

  test("names a handful of files rather than collapsing them", () => {
    const text = summarizeFiles(["src/a.ts", "src/b.ts"]).map((p) => p.text);
    expect(text).toEqual(["a.ts", "b.ts"]);
  });

  test("counts scratch files instead of naming them", () => {
    const paths = ["src/build.ts", ...Array.from({ length: 17 }, (_, i) => `tmpprobe/p${i}.ts`)];
    const text = summarizeFiles(paths).map((p) => p.text);
    expect(text).toEqual(["build.ts", "+17 scratch"]);
  });

  test("ALWAYS names a contested path, however much else is collapsed", () => {
    // The one entry on this line that requires a decision can never be the one
    // hidden behind "(15 files)".
    const paths = [
      "docs/systems/water-sim.md",
      ...Array.from({ length: 15 }, (_, i) => `test/bench/b${i}.ts`),
    ];
    const pieces = summarizeFiles(paths, { contested });
    expect(pieces[0]?.text).toBe("docs/systems/water-sim.md");
    expect(pieces[0]?.contested).toBe(true);
    expect(pieces.some((p) => p.text.includes("15 files"))).toBe(true);
  });

  test("reports files it did not name rather than dropping them silently", () => {
    const pieces = summarizeFiles(["a/1.ts", "a/2.ts", "a/3.ts"], { maxNamed: 2 });
    expect(pieces.map((p) => p.text)).toEqual(["1.ts", "2.ts", "+1 more"]);
  });

  test("says nothing when an agent holds only scratch", () => {
    const pieces = summarizeFiles(["tmpwb/a.ts", "tmpwb/b.ts"]);
    expect(pieces.map((p) => p.text)).toEqual(["+2 scratch"]);
  });
});

describe("renderFileLine", () => {
  const paint = { contested: (s: string) => `<R>${s}</R>`, normal: (s: string) => `<D>${s}</D>` };

  test("colours each piece by role rather than wrapping the whole line", () => {
    // A line assembled plain, red-wrapped at the path, then dim-wrapped whole
    // LOSES the red: dim's trailing reset closes it. Painting per piece is the
    // only ordering that survives.
    const pieces = summarizeFiles(["docs/systems/water-sim.md", "src/a.ts"], {
      contested: new Set(["docs/systems/water-sim.md"]),
    });
    const line = renderFileLine(pieces, 80, paint);
    expect(line).toContain("<R>docs/systems/water-sim.md</R>");
    expect(line).toContain("<D>a.ts</D>");
  });

  test("stays inside the budget once the markup is stripped", () => {
    const pieces = summarizeFiles(Array.from({ length: 9 }, (_, i) => `src/long-name-${i}.ts`));
    const plain = renderFileLine(pieces, 30, paint).split(/<\/?[RD]>/).join("");
    expect(width(plain)).toBeLessThanOrEqual(30);
  });

  test("drops later pieces rather than overflowing for them", () => {
    const pieces = summarizeFiles(["src/aaaaaaaaaaaaaaaaaaaa.ts", "src/b.ts", "src/c.ts"]);
    const plain = renderFileLine(pieces, 24, paint).split(/<\/?[RD]>/).join("");
    expect(width(plain)).toBeLessThanOrEqual(24);
  });

  test("returns empty for no pieces instead of a stray separator", () => {
    expect(renderFileLine([], 40, paint)).toBe("");
  });
});

describe("shortAge", () => {
  test("uses a narrow form that fits a fixed column", () => {
    const now = 1_000_000_000;
    expect(shortAge(now, now)).toBe("now");
    expect(shortAge(now - 5 * 60_000, now)).toBe("5m");
    expect(shortAge(now - 3 * 3_600_000, now)).toBe("3h");
    expect(shortAge(now - 2 * 86_400_000, now)).toBe("2d");
  });

  test("never exceeds the column it is padded into", () => {
    const now = 1_000_000_000;
    for (const ago of [0, 30_000, 90_000, 3_600_000, 86_400_000, 30 * 86_400_000]) {
      expect(width(shortAge(now - ago, now))).toBeLessThanOrEqual(4);
    }
  });

  test("never renders a negative age from a clock skew", () => {
    const now = 1_000_000_000;
    expect(shortAge(now + 60_000, now)).toBe("now");
  });
});
