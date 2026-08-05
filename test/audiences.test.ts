/**
 * `docs/audiences.md` cannot drift from `core/verbs.ts`.
 *
 * THE GUARD, not the fix — `test/tools/regen-audiences.ts` is the fix, exactly
 * as `verbs.test.ts` guards the README and `regen-readme.ts` regenerates it.
 *
 * WHY IT EXISTS. The audience split was prose and drifted immediately, four
 * times over: `core/verbs.ts`'s own header said 33 verbs against 51; this
 * document mis-stated its section totals; the remediation plan written to fix
 * that reproduced the same error inside itself; and the corrected plan then
 * dropped one item from a list it had just added. Hand-maintained counts in
 * this repo have a **100% measured drift rate**.
 *
 * So the assertion is not "the numbers happen to match today". It is that the
 * document is DERIVED, and that a verb added without regenerating is a red
 * test rather than a quiet inaccuracy an agent later quotes as fact.
 */

import { describe, expect, test } from "bun:test";

import { VERBS, type VerbAudience } from "../core/verbs.ts";

const DOC = new URL("../docs/audiences.md", import.meta.url).pathname.replace(
  /^\/(?=[A-Za-z]:)/,
  "",
);
const START = "<!-- BEGIN GENERATED AUDIENCES -->";
const END = "<!-- END GENERATED AUDIENCES -->";

const doc = await Bun.file(DOC).text();
const block = doc.slice(doc.indexOf(START), doc.indexOf(END));

const AUDIENCES: readonly VerbAudience[] = ["agent", "human", "shared", "oversight"];

describe("docs/audiences.md is generated, not hand-maintained", () => {
  test("the generation markers are present and ordered", () => {
    expect(doc.indexOf(START)).toBeGreaterThanOrEqual(0);
    expect(doc.indexOf(END)).toBeGreaterThan(doc.indexOf(START));
  });

  test("every verb appears in the generated block exactly once", () => {
    const missing = VERBS.filter(
      (v) => v.hidden !== true && !block.includes(`| \`${v.verb}\` |`),
    );
    expect(
      missing.map((v) => v.verb),
      "run `bun test/tools/regen-audiences.ts`",
    ).toEqual([]);
  });

  test("no verb appears twice — one audience each", () => {
    for (const v of VERBS.filter((x) => x.hidden !== true)) {
      const hits = block.split(`| \`${v.verb}\` |`).length - 1;
      expect(hits, v.verb).toBe(1);
    }
  });

  test("each audience's count matches the verb table", () => {
    for (const audience of AUDIENCES) {
      const n = VERBS.filter((v) => v.audience === audience).length;
      expect(block, `${audience} should read ${n}`).toContain(`| ${audience} | ${n} |`);
    }
  });

  test("the stated total matches the verb table", () => {
    expect(block).toContain(`${VERBS.length} verbs in total`);
  });

  test("every blurb in the block is the verb table's blurb", () => {
    // Catches the subtler drift: a verb present, but described differently
    // here than in `--help`. That is how `clear` came to promise it wiped the
    // message log in one place and keep it in another.
    for (const v of VERBS.filter((x) => x.hidden !== true))
      expect(block, v.verb).toContain(`| \`${v.verb}\` | ${v.blurb.replace(/\|/g, "\\|")} |`);
  });

  test("no verb is described outside the generated block", () => {
    // A hand-written table below the markers would go stale silently, which is
    // the failure mode this whole file exists to prevent.
    const outside = doc.slice(doc.indexOf(END));
    for (const v of VERBS.filter((x) => x.hidden !== true))
      expect(outside, `${v.verb} is documented outside the markers`).not.toContain(
        `| \`${v.verb}\` |`,
      );
  });
});

describe("the audience taxonomy stays meaningful", () => {
  test("every audience in use is one of the four declared", () => {
    for (const v of VERBS) expect(AUDIENCES).toContain(v.audience);
  });

  test("no audience is empty, or the distinction is not earning its place", () => {
    for (const audience of AUDIENCES)
      expect(
        VERBS.filter((v) => v.audience === audience).length,
        `${audience} has no verbs`,
      ).toBeGreaterThan(0);
  });

  test("`oversight` is not a synonym for `human`", () => {
    // The two were collapsed before, which hid the real gap: the operator had
    // no aggregate read surface at all. If everything oversight-shaped drifts
    // back into `human`, that gap becomes invisible again.
    const oversight = VERBS.filter((v) => v.audience === "oversight");
    expect(oversight.length).toBeGreaterThan(2);
  });
});
