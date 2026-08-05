/**
 * P1-2 — a file name in `who` must identify one file.
 *
 * WRITTEN AGAINST THE SPEC. The defect is not "basenames are ugly": it is that
 * `core/layout.ts` displayed `p.split("/").pop()` while `cli/roster-model.ts`
 * computed contention on the FULL path. Contention was therefore correct and
 * unreadable — `plans/README.md` and `README.md` both rendered as `README.md`,
 * so two agents in genuinely different files appeared to hold the same one.
 *
 * Measured cost, 2026-08-05: this made the audit document's own `breaks`
 * narrative read as self-contradictory (`who` showed a peer holding
 * `README.md` while `breaks` reported nobody in the same files), and a reviewer
 * lost a full pass to reconciling it. It also undermines the red-for-contested
 * signal, which the docs describe as the one marker that always means "look at
 * this" — red is only trustworthy if you can tell WHICH file is red.
 *
 * THE SPEC IS NOT "always show full paths". A roster of four agents in one tree
 * does not need `src/` repeated on every row, and the column is width-bound.
 * The rule is: shorten until a name would be ambiguous, then stop.
 */

import { describe, expect, test } from "bun:test";

import { summarizeFiles } from "../core/layout.ts";

const texts = (paths: readonly string[], contested?: ReadonlySet<string>): string[] =>
  summarizeFiles(paths, contested ? { contested } : {}).map((p) => p.text);

describe("P1-2 — display disambiguates only when leaves collide", () => {
  test("distinct leaves stay short, because the common case must stay quiet", () => {
    // Nothing is ambiguous here, so nothing is lengthened.
    expect(texts(["src/net/graph.ts", "docs/views.md"])).toEqual([
      "graph.ts",
      "views.md",
    ]);
  });

  test("colliding leaves are disambiguated by directory", () => {
    // THE DEFECT: both of these rendered as `README.md`.
    const shown = texts(["README.md", "plans/README.md"]);
    expect(new Set(shown).size).toBe(2);
    expect(shown.some((t) => t.includes("plans"))).toBe(true);
  });

  test("a collision lengthens only the names that collide", () => {
    const shown = texts(["README.md", "plans/README.md", "src/net/graph.ts"]);
    // The uninvolved file keeps its short form: one collision must not cost
    // every other row its brevity.
    expect(shown).toContain("graph.ts");
    expect(new Set(shown).size).toBe(shown.length);
  });

  test("three-way collisions still resolve to distinct labels", () => {
    const shown = texts([
      "README.md",
      "plans/README.md",
      "docs/plans/README.md",
    ]);
    expect(new Set(shown).size).toBe(3);
  });

  test("a contested path is shown in full, not merely disambiguated", () => {
    // STRONGER THAN THE COLLISION RULE, and deliberately so — `layout.test.ts`
    // already pins it ("ALWAYS names a contested path, however much else is
    // collapsed"). The contested entry is the one thing on the line that
    // requires a decision, so the reader must be able to act on the text
    // without reconstructing it. Disambiguation is the floor here, not the
    // ceiling: this was written expecting a shortened-but-unique label and
    // corrected once the existing spec turned out to demand more.
    const contested = new Set(["plans/README.md"]);
    const shown = texts(["README.md", "plans/README.md"], contested);
    expect(shown).toContain("plans/README.md");
    expect(new Set(shown).size).toBe(2);
  });

  test("identical paths are not treated as a collision with themselves", () => {
    expect(texts(["src/a.ts", "src/a.ts"])).toEqual(["a.ts", "a.ts"]);
  });
});
