/**
 * Given names, roles, and the string the operator reads.
 *
 * The invariants worth defending are about ADDRESSING: a name is typed at `msg`
 * and must survive that trip, while a role is only ever read and must never be
 * mistaken for something typeable.
 */

import { describe, expect, test } from "bun:test";

import { fullName, GIVEN_NAMES, pickName, titleCase } from "../core/names.ts";
import { validateAlias, validateRole } from "../core/topic.ts";

describe("the name pool", () => {
  test("every name is unique", () => {
    expect(new Set(GIVEN_NAMES).size).toBe(GIVEN_NAMES.length);
  });

  test("every name is addressable — it survives `msg <name>`", () => {
    // A pool entry that the name validator would refuse is a name an agent
    // could be assigned but could never be renamed TO, and one that `msg` might
    // not carry. Checked for all of them rather than sampled.
    for (const n of GIVEN_NAMES) {
      const r = validateAlias(n);
      expect(r.ok).toBe(true);
    }
  });

  test("every name is lowercase, so matching cannot depend on case", () => {
    // Widened to `string`: the pool is `as const`, so `toBe` would otherwise
    // demand the literal union and reject a computed comparison.
    for (const n of GIVEN_NAMES as readonly string[]) expect(n).toBe(n.toLowerCase());
  });

  test("the pool is large enough to outlast the 60-hour hold", () => {
    // A name is held for 60 h after last use, so the pool covers days of churn
    // rather than the agents alive at one moment. The eight-name list it
    // replaced ran out at nine agents and emitted `agent-3f9c21`.
    expect(GIVEN_NAMES.length).toBeGreaterThan(100);
  });
});

describe("pickName", () => {
  test("takes the first free name", () => {
    expect(pickName(new Set())).toBe(GIVEN_NAMES[0]);
    expect(pickName(new Set([GIVEN_NAMES[0]!]))).toBe(GIVEN_NAMES[1]);
  });

  test("never returns a taken name", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 250; i++) {
      const n = pickName(taken);
      expect(taken.has(n)).toBe(false);
      taken.add(n);
    }
  });

  test("an exhausted pool numbers rather than silently doubling up", () => {
    // Exhausting 220 names means something is wrong — a looping hook, a db
    // never pruned — and a name that quietly repeats would hide it.
    const all = new Set<string>(GIVEN_NAMES);
    const next = pickName(all);
    expect(all.has(next)).toBe(false);
    expect(next).toMatch(/\d/);
  });
});

describe("titleCase", () => {
  test("turns a slug into words", () => {
    expect(titleCase("terrain-perf")).toBe("Terrain Perf");
    expect(titleCase("water_sim_timberborn")).toBe("Water Sim Timberborn");
    expect(titleCase("tooling")).toBe("Tooling");
  });

  test("does NOT lowercase what is already there", () => {
    // Lowercasing first would flatten the acronyms that actually appear in this
    // repo's slugs. `GPU splat` reading as `Gpu Splat` is a small thing that
    // looks like a bug every time someone sees it.
    expect(titleCase("GPU-splat")).toBe("GPU Splat");
    expect(titleCase("a11y")).toBe("A11y");
    expect(titleCase("R4 core")).toBe("R4 Core");
  });

  test("survives empty and separator-only input", () => {
    expect(titleCase("")).toBe("");
    expect(titleCase("---")).toBe("");
  });
});

describe("fullName", () => {
  test("role in front, name at the end", () => {
    expect(fullName("luna", "Tooling Master", "tooling")).toBe("Tooling Master Luna");
  });

  test("with no role, the slug stands in title-cased", () => {
    // Keeps what the self-chosen slugs were already good at — saying what
    // someone works on — instead of trading it for a bare given name.
    expect(fullName("luna", "", "terrain-perf")).toBe("Terrain Perf Luna");
  });

  test("never repeats the name as its own prefix", () => {
    // An agent named `tooling` with slug `tooling` must not read `Tooling Tooling`.
    expect(fullName("tooling", "", "tooling")).toBe("Tooling");
    expect(fullName("tooling", "Tooling", "x")).toBe("Tooling");
  });

  test("a role changes while the name stays put", () => {
    // THE POINT of two fields: a demotion reads as a demotion rather than as a
    // stranger appearing on the roster.
    expect(fullName("luna", "Tooling Master", "x")).toBe("Tooling Master Luna");
    expect(fullName("luna", "Tooling Intern", "x")).toBe("Tooling Intern Luna");
  });

  test("with neither role nor slug, the bare name stands alone", () => {
    expect(fullName("luna", "", "")).toBe("Luna");
  });

  test("a self-named agent does not read as the same word twice", () => {
    // Shipped briefly and caught on the live roster: passing the chosen name as
    // BOTH the name and the slug produced "Tooling Master Tooling". The given
    // name is always the name; a chosen name stands in front like a role.
    expect(fullName("hopper", "Tooling Master", "tooling")).toBe("Tooling Master Hopper");
    expect(fullName("turing", "", "water-dynamic")).toBe("Water Dynamic Turing");
  });
});

describe("validateRole", () => {
  test("accepts the roles that make this worth having", () => {
    for (const role of ["Tooling Master", "Keeper of Wet Things", "Terrain Whisperer"]) {
      const r = validateRole(role);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.role).toBe(role);
    }
  });

  test("is LOOSER than a name, because it is read and never typed", () => {
    // A name cannot carry these; `msg` would choke. A role is only ever printed.
    for (const role of ["Hydrologist & Friend", "Sim's Keeper", "Router (Retired)"]) {
      expect(validateRole(role).ok).toBe(true);
      expect(validateAlias(role).ok).toBe(false);
    }
  });

  test("refuses control characters that could rewrite a roster row", () => {
    expect(validateRole(`Red${String.fromCharCode(27)}[31m Master`).ok).toBe(false);
    expect(validateRole(`Bell${String.fromCharCode(7)}`).ok).toBe(false);
    expect(validateRole(`Del${String.fromCharCode(127)}`).ok).toBe(false);
  });

  test("collapses whitespace rather than refusing it", () => {
    const r = validateRole("  Tooling    Master  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.role).toBe("Tooling Master");
  });

  test("refuses empty, over-long, and credential-shaped roles", () => {
    expect(validateRole("").ok).toBe(false);
    expect(validateRole("   ").ok).toBe(false);
    expect(validateRole("a".repeat(29)).ok).toBe(false);
    expect(validateRole("a".repeat(28)).ok).toBe(true);
    expect(validateRole("sk_live_0123456789abcdef0123456789abcdef").ok).toBe(false);
  });
});
