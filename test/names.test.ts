/**
 * Given names, roles, and the string the operator reads.
 *
 * The invariants worth defending are about ADDRESSING: a name is typed at `msg`
 * and must survive that trip, while a role is only ever read and must never be
 * mistaken for something typeable.
 */

import { describe, expect, test } from "bun:test";

import { fullName, GIVEN_NAMES, nameCase, pickName, titleCase } from "../core/names.ts";
import { validateAlias, validateRole } from "../core/topic.ts";
import { rosterName } from "../core/store.ts";

/** `GIVEN_NAMES` is `as const`, so a runtime string is not one of its literals. */
const POOL: readonly string[] = GIVEN_NAMES;

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
  test("with no seed it takes the first free name", () => {
    // The unseeded path is what callers with nothing stable to hash still get.
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

  /**
   * THE POOL WAS DECORATIVE. `find` returned the first free entry of a sorted
   * list, so 280 names chosen for their variety yielded `adela`, `akari`,
   * `akira`, `alder` -- and a roster of two read as two near-identical A-names.
   * These pin the distribution, not the specific names, so reordering the pool
   * does not turn them red.
   */
  test("a seed moves the name off the top of the pool", () => {
    const seeded = pickName(new Set(), "061b1a91-3739-4e63-866c-e9cc3441c77a");
    expect(POOL).toContain(seeded);
    expect(seeded).not.toBe(GIVEN_NAMES[0]);
  });

  test("the same seed always gives the same name", () => {
    // What makes this safe when a conversation loses its ledger row: it lands
    // on the name it had, not on whatever is free at that moment.
    const uuid = "22e930ad-0e3f-476f-9b6c-8a708813a581";
    expect(pickName(new Set(), uuid)).toBe(pickName(new Set(), uuid));
  });

  test("distinct seeds spread across the pool rather than clustering", () => {
    // Eight concurrent agents is the case the roster is built for. Alphabetical
    // assignment put all eight inside the first eight entries; the property
    // that matters is that they are spread, not that any one is chosen.
    const names = Array.from({ length: 8 }, (_, i) =>
      pickName(new Set(), `session-${i}-uuid`),
    );
    expect(new Set(names).size).toBe(8);
    const indices = names.map((n) => POOL.indexOf(n));
    expect(Math.max(...indices) - Math.min(...indices)).toBeGreaterThan(20);
  });

  test("a seeded pick still refuses a taken name, wrapping the pool", () => {
    // The probe walks forward from the offset and must wrap, or a seed landing
    // near the end of the pool would fall through to the numbered fallback
    // while most of the pool was still free.
    const seed = "wrap-me";
    const first = pickName(new Set(), seed);
    const second = pickName(new Set([first]), seed);
    expect(second).not.toBe(first);
    expect(POOL).toContain(second);
  });

  test("every seeded pick is drawn from the pool, never invented", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 250; i++) {
      const n = pickName(taken, `uuid-${i}`);
      expect(taken.has(n)).toBe(false);
      expect(POOL).toContain(n);
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

/**
 * Two casers, because the roster line has two halves with opposite needs.
 *
 * The ROLE half is prose and reads better as words. The NAME half is what a
 * peer types at `msg`, so its separator is load-bearing — `titleCase` on a name
 * hands back `Water Dynamic`, the exact unaddressable two-word form that
 * `validateAlias` now refuses.
 */
describe("nameCase", () => {
  test("capitalises without replacing the separator", () => {
    expect(nameCase("water-dynamic")).toBe("Water-Dynamic");
    expect(nameCase("terrain_perf")).toBe("Terrain_Perf");
    expect(nameCase("hopper")).toBe("Hopper");
  });

  test("what it returns is still a legal name", () => {
    // The property that matters: a name read off the roster can be typed back.
    for (const n of ["water-dynamic", "terrain_perf", "hopper", "a11y", "agent2"]) {
      const shown = nameCase(n);
      expect(shown).not.toMatch(/\s/);
      expect(validateAlias(shown).ok).toBe(true);
    }
  });

  test("does NOT lowercase what is already there", () => {
    expect(nameCase("GPU-splat")).toBe("GPU-Splat");
    expect(nameCase("a11y")).toBe("A11y");
  });

  test("the two casers disagree exactly where they should", () => {
    // Same input, different jobs — stated once so neither drifts into the other.
    expect(titleCase("water-dynamic")).toBe("Water Dynamic"); // role: prose
    expect(nameCase("water-dynamic")).toBe("Water-Dynamic"); // name: typeable
    expect(fullName("water-dynamic", "Keeper of Wet Things", "")).toBe(
      "Water-Dynamic — Keeper of Wet Things",
    );
    // …and a handle standing in for a missing role still reads as words.
    expect(fullName("turing", "", "water-dynamic")).toBe("Turing — Water Dynamic");
  });

  test("survives empty input", () => {
    expect(nameCase("")).toBe("");
  });
});

describe("fullName", () => {
  test("name first, role after a dash", () => {
    // NAME FIRST: it is the identifier — unique, typed at `msg`, and fixed —
    // so it belongs where the eye lands when scanning a column of eight.
    expect(fullName("luna", "Tooling Master", "tooling")).toBe("Luna — Tooling Master");
  });

  test("with no role, the slug stands in title-cased", () => {
    // Keeps what the self-chosen slugs were already good at — saying what
    // someone works on — instead of trading it for a bare given name.
    expect(fullName("luna", "", "terrain-perf")).toBe("Luna — Terrain Perf");
  });

  test("never repeats the name as its own suffix", () => {
    // An agent named `tooling` with slug `tooling` must not read `Tooling — Tooling`.
    expect(fullName("tooling", "", "tooling")).toBe("Tooling");
    expect(fullName("tooling", "Tooling", "x")).toBe("Tooling");
  });

  test("a role changes while the name stays put", () => {
    // THE POINT of two fields: a demotion reads as a demotion rather than as a
    // stranger appearing on the roster.
    expect(fullName("luna", "Tooling Master", "x")).toBe("Luna — Tooling Master");
    expect(fullName("luna", "Tooling Intern", "x")).toBe("Luna — Tooling Intern");
  });

  test("with neither role nor slug, the bare name stands alone", () => {
    expect(fullName("luna", "", "")).toBe("Luna");
  });

  test("a self-named agent does not read as the same word twice", () => {
    // Shipped briefly and caught on the live roster: passing the chosen name as
    // BOTH the name and the suffix produced "Tooling Master Tooling". The given
    // name is always the name; a chosen name stands after it, like a role.
    expect(fullName("hopper", "Tooling Master", "tooling")).toBe("Hopper — Tooling Master");
    expect(fullName("turing", "", "water-dynamic")).toBe("Turing — Water Dynamic");
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

describe("a name is never printed twice as its own role", () => {
  test("the derived role collapses when it is just the name respaced", () => {
    // MEASURED on the live roster: `Water-Dynamic — Water Dynamic`. With no role
    // set, the suffix derives from the HANDLE, and the two halves take different
    // casers on purpose — `water-dynamic` becomes the name `Water-Dynamic` and
    // the role `Water Dynamic`. An exact-match guard saw two different strings.
    expect(fullName("water-dynamic", "", "water-dynamic")).toBe("Water-Dynamic");
  });

  test("case and separators alone never justify a suffix", () => {
    expect(fullName("terrain-perf", "Terrain Perf", "")).toBe("Terrain-Perf");
    expect(fullName("hopper", "HOPPER", "")).toBe("Hopper");
  });

  test("a role that genuinely says something is still kept", () => {
    // The guard must not swallow a real role that merely starts with the name.
    expect(fullName("water-dynamic", "Water Dynamics Lead", "")).toBe(
      "Water-Dynamic — Water Dynamics Lead",
    );
    expect(fullName("turing", "", "water-dynamic")).toBe("Turing — Water Dynamic");
  });
});

describe("a rename does not leave the old name as a job title", () => {
  test("an aliased session derives no role from its superseded handle", () => {
    // MEASURED 2026-08-05: `crew call-me hopper` on a session handled `adela`
    // rendered `Hopper — Adela`. `call-me` writes the alias and leaves the
    // handle, so the handle-as-topic fallback printed the name just abandoned.
    const s = {
      sessionId: "s", handle: "adela", name: "traffic-1", alias: "hopper",
      role: "", status: "", blocked: "", worktree: "/t", branch: "main",
      behindBase: -1, baseBranch: "", lineageFrom: "", intent: "", title: "",
      summary: "", summaryMs: 0, lastSeenMs: 0, lastTurnMs: 0, startedMs: 0,
    };
    expect(rosterName(s)).toBe("Hopper");
  });

  test("an UNALIASED handle still says what the agent works on", () => {
    // The fallback earns its place in the ordinary case and must survive.
    const s = {
      sessionId: "s", handle: "water-dynamic", name: "traffic-2", alias: "",
      role: "", status: "", blocked: "", worktree: "/t", branch: "main",
      behindBase: -1, baseBranch: "", lineageFrom: "", intent: "", title: "",
      summary: "", summaryMs: 0, lastSeenMs: 0, lastTurnMs: 0, startedMs: 0,
    };
    expect(rosterName(s)).toBe("Water-Dynamic");
  });

  test("an explicit role always wins, aliased or not", () => {
    const s = {
      sessionId: "s", handle: "adela", name: "traffic-3", alias: "hopper",
      role: "Tooling Master", status: "", blocked: "", worktree: "/t",
      branch: "main", behindBase: -1, baseBranch: "", lineageFrom: "",
      intent: "", title: "", summary: "", summaryMs: 0, lastSeenMs: 0,
      lastTurnMs: 0, startedMs: 0,
    };
    expect(rosterName(s)).toBe("Hopper — Tooling Master");
  });
});
