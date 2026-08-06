/**
 * `set-role`, not `call-you`.
 *
 * WRITTEN AGAINST THE SPEC. `call-me` and `call-you` read as a matched pair, and
 * the symmetry is a lie: one takes a NAME for yourself, the other states what
 * you ARE. "Call you" is the grammar of addressing someone -- an agent reading
 * the pair reasonably expects `call-you` to name a PEER.
 *
 * MEASURED 2026-08-06. An agent asked to give itself a role ran
 * `crew call-you "Notekeeper"` and reported "I am now Cora — Notekeeper". It
 * worked, and the operator still had to ask what the verb was for. That is the
 * cost: the name teaches the wrong model of the command even when the call is
 * correct.
 *
 * `role` was ALREADY an alias, so the fix is which name is primary. The verb
 * table advertises the primary and recognises the aliases, so `call-you` keeps
 * working for every agent, hook and habit that already uses it.
 */

import { describe, expect, test } from "bun:test";

import { findVerb, usageFor, VERBS } from "../core/verbs.ts";

describe("the role verb says what it does", () => {
  test("`set-role` is the advertised name", () => {
    expect(findVerb("set-role")?.verb).toBe("set-role");
  });

  test("`call-you` still resolves — no agent's habit breaks", () => {
    // The whole point of aliasing rather than renaming. Hooks, docs and running
    // sessions carry `call-you`; it must keep working indefinitely.
    expect(findVerb("call-you")?.verb).toBe("set-role");
  });

  test("`role` still resolves too", () => {
    expect(findVerb("role")?.verb).toBe("set-role");
  });

  test("the old name is NOT advertised as its own verb", () => {
    // An alias that appears in the table would offer two names for one thing,
    // which is how the confusion started.
    expect(VERBS.filter((v) => v.verb === "call-you")).toHaveLength(0);
  });

  test("usage names the primary, so error text teaches the good name", () => {
    // `usageFor` is what an argument error prints. Reaching it through the old
    // alias must still steer the reader to `set-role`.
    expect(usageFor("call-you")).toContain("set-role");
  });

  test("`call-me` keeps its name — it is not the confusing half", () => {
    // Only the asymmetric one moves. `call-me <name>` reads correctly: it takes
    // a name for yourself, exactly as it says.
    expect(findVerb("call-me")?.verb).toBe("call-me");
  });

  test("the blurb says it sets a role rather than addressing anyone", () => {
    const blurb = findVerb("set-role")?.blurb ?? "";
    expect(blurb).toMatch(/role/i);
    expect(blurb).not.toMatch(/call/i);
  });

  test("both identity verbs stay in the identity group", () => {
    for (const name of ["call-me", "set-role"])
      expect(findVerb(name)?.group).toBe("identity");
  });
});
