/**
 * A lineage the operator can SEE.
 *
 * WRITTEN AGAINST THE SPEC. `lineageName` was defined, exported and tested, and
 * had ZERO call sites -- measured 2026-08-06 by grepping every renderer. So
 * `crew inherit hopper` printed "you are Akari, Hopper's Disciple" once, set
 * `lineage_from`, and the roster went on showing plain `Akari` forever. The
 * lineage was real in the database and invisible everywhere a reader looks.
 *
 * NAME AND ROLE AND LINEAGE ARE THREE DIFFERENT THINGS, and this is the point
 * of the change. A name is TYPED (`msg akari`) and must stay one word. A role
 * is CHOSEN and changes with the work. A lineage is a FACT about whose
 * knowledge this agent took up, and the agent does not get to pick it. Writing
 * the lineage into the role would let the next `call-you` erase it and would
 * let any agent claim a descent it never inherited.
 */

import { describe, expect, test } from "bun:test";

import { displayName, rosterName } from "../core/store/types.ts";
import type { Session } from "../core/store/types.ts";

const base: Session = {
  sessionId: "aaaa",
  name: "traffic-9",
  handle: "akari",
  alias: "",
  role: "",
  status: "",
  blocked: "",
  worktree: "",
  branch: "",
  baseDistance: -1,
  lineageFrom: "",
} as unknown as Session;

const session = (over: Partial<Session>): Session => ({ ...base, ...over });

describe("the roster shows a lineage", () => {
  test("an inherited lineage is visible without a role", () => {
    // THE DEFECT: this rendered as plain `Akari`.
    expect(rosterName(session({ lineageFrom: "hopper" }))).toBe(
      "Akari, Hopper's Disciple",
    );
  });

  test("no lineage renders exactly as before", () => {
    expect(rosterName(session({}))).toBe("Akari");
    expect(rosterName(session({ role: "Tooling Master" }))).toBe(
      "Akari — Tooling Master",
    );
  });

  test("a role and a lineage coexist — neither replaces the other", () => {
    // The operator's ruling, 2026-08-06: keep the name, keep the connotation.
    // A chosen role must not evict a fact, and a fact must not evict a choice.
    const shown = rosterName(
      session({ role: "Tooling Master", lineageFrom: "hopper" }),
    );
    expect(shown).toContain("Akari");
    expect(shown).toContain("Tooling Master");
    expect(shown).toContain("Hopper");
  });

  test("the ADDRESSABLE name is untouched", () => {
    // If the disciple form leaked into `displayName`, every `msg` to this agent
    // would fail: peers type one unquoted word.
    const s = session({ role: "Tooling Master", lineageFrom: "hopper" });
    expect(displayName(s)).toBe("akari");
    expect(displayName(s)).not.toContain(" ");
  });

  test("inheriting your own name adds no suffix", () => {
    // A RESUME is not a succession: same uuid, same transcript. `discipleName`
    // already returns the bare name here, and the roster must not invent one.
    expect(rosterName(session({ lineageFrom: "akari" }))).toBe("Akari");
  });

  test("a chosen name carries the lineage too", () => {
    // The lineage follows the AGENT, not the handle it was issued.
    expect(rosterName(session({ alias: "vega", lineageFrom: "hopper" }))).toBe(
      "Vega, Hopper's Disciple",
    );
  });

  test("the role slug fallback does not fire under a lineage", () => {
    // With no alias and no role, `rosterName` derives a role from the handle.
    // That must not produce `Akari, Hopper's Disciple — Akari`.
    const shown = rosterName(session({ handle: "akari", lineageFrom: "hopper" }));
    expect(shown).toBe("Akari, Hopper's Disciple");
  });
});
