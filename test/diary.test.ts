/**
 * The shared diary.
 *
 * The thing under test is not "does a row round-trip" — it is whether an agent
 * that writes a finding is FOUND by the agent who needs it. So most of these
 * are search and scope tests, and the ones that look like storage tests are
 * really about the two places this can silently stop working: an external-content
 * FTS index that is not kept in step, and a tag filter that matches a prefix.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { wrap } from "../core/layout.ts";
import {
  BODY_MAX,
  checkNote,
  ftsQuery,
  normaliseScope,
  normaliseTerm,
  packTags,
  parseTags,
  nearTopic,
  scopeCandidates,
  TITLE_MAX,
} from "../core/diary.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-diary-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {
        /* already gone */
      }
    }
  }
});

/** The shape every test writes, so a test says only what it is about. */
function ok(input: Parameters<typeof checkNote>[0]) {
  const c = checkNote(input);
  if (!c.ok) throw new Error(`fixture rejected: ${c.why}`);
  return c.note;
}

describe("validation", () => {
  test("a title is required, because it is what search returns", () => {
    expect(checkNote({ title: "   ", topic: "water" }).ok).toBe(false);
  });

  test("a topic is required", () => {
    expect(checkNote({ title: "something true", topic: "" }).ok).toBe(false);
  });

  test("the title cap fits what agents actually write", () => {
    // Measured across the 137 memory-note descriptions in this repo: median
    // 140, p90 193, max 362. The cap has to clear the p90 or it fights every
    // real example; a 60-char "keep it short" rule would reject most of them.
    expect(TITLE_MAX).toBeGreaterThanOrEqual(193);
    const typical = "x".repeat(140);
    expect(checkNote({ title: typical, topic: "water" }).ok).toBe(true);
    expect(checkNote({ title: "x".repeat(TITLE_MAX + 1), topic: "water" }).ok).toBe(false);
  });

  test("an over-long title is told where to put the rest", () => {
    const r = checkNote({ title: "x".repeat(TITLE_MAX + 1), topic: "water" });
    expect(r.ok).toBe(false);
    // A refusal an agent cannot act on gets retried in the same shape.
    if (!r.ok) expect(r.why).toContain("--body");
  });

  test("an over-long body is told to write a report instead", () => {
    const r = checkNote({ title: "ok", topic: "water", body: "x".repeat(BODY_MAX + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("audit_reports/");
  });

  test("kind is a closed set, because a warning interrupts and a finding does not", () => {
    expect(checkNote({ title: "t", topic: "w", kind: "warning" }).ok).toBe(true);
    expect(checkNote({ title: "t", topic: "w", kind: "musing" as never }).ok).toBe(false);
  });

  test("topics and tags normalise to one lowercase word", () => {
    expect(normaliseTerm("  Water Sim  ")).toBe("water-sim");
    expect(normaliseTerm("PERF!!")).toBe("perf");
    expect(parseTags("perf, Flaky ,,perf")).toEqual(["perf", "flaky"]);
  });
});

describe("scope", () => {
  test("a file path is reduced to its folder", () => {
    // An agent that just edited a file will pass the file; refusing that
    // teaches nothing.
    expect(normaliseScope("src/sim/water/flow.ts")).toBe("src/sim/water");
    expect(normaliseScope("src/sim/water")).toBe("src/sim/water");
    expect(normaliseScope("src/sim/water/")).toBe("src/sim/water");
    expect(normaliseScope("")).toBe("");
  });

  test("candidates are the path's own prefixes, so the lookup stays indexed", () => {
    expect(scopeCandidates("src/sim/water/flow.ts")).toEqual(["", "src", "src/sim", "src/sim/water"]);
  });

  test("an entry matches a deeper file but not a sibling folder", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "hopper", ok({ title: "water is per-cell", topic: "water", scope: "src/sim/water" }), now);

      expect(d.forPath("src/sim/water/flow.ts").map((e) => e.title)).toEqual(["water is per-cell"]);
      // Deeper still — the whole point of prefix matching.
      expect(d.forPath("src/sim/water/sources/spring.ts").length).toBe(1);
      // A sibling must NOT match, or every entry fires on every edit.
      expect(d.forPath("src/sim/traffic/engine.ts").length).toBe(0);
    });
  });

  test("a repo-wide entry matches everything", () => {
    fresh((store) => {
      const now = Date.now();
      store.diary.write("s1", "hopper", ok({ title: "CRLF breaks perl -0pi", topic: "tooling" }), now);
      expect(store.diary.forPath("anything/at/all.ts").length).toBe(1);
    });
  });

  test("the nearest folder comes first", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "repo wide", topic: "t" }), now);
      d.write("s1", "a", ok({ title: "sim wide", topic: "t", scope: "src/sim" }), now);
      d.write("s1", "a", ok({ title: "water only", topic: "t", scope: "src/sim/water" }), now);
      // Most specific first: a reader shown one line should get the one that
      // is actually about the file being edited.
      expect(d.forPath("src/sim/water/flow.ts").map((e) => e.title)).toEqual([
        "water only",
        "sim wide",
        "repo wide",
      ]);
    });
  });

  test("recall --scope COVERS a path, so pre-edit's own pointer resolves", () => {
    // Caught live 2026-08-01 by the hook firing on its own file: it reported
    // entries scoped to `.claude/hooks/presence` and printed
    // `--scope .claude/hooks/presence/hooks`, which under equality matched
    // nothing. Advice that fails when followed is the same defect as a refusal
    // suggesting an invalid repair.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "outer", topic: "x", scope: "src/sim" }), now);
      d.write("s1", "a", ok({ title: "inner", topic: "x", scope: "src/sim/water" }), now);
      d.write("s1", "a", ok({ title: "elsewhere", topic: "x", scope: "src/net" }), now);

      // A deeper folder still finds the entry filed against its parent.
      expect(d.recall({ scope: "src/sim/water" }).map((e) => e.title).sort()).toEqual([
        "inner",
        "outer",
      ]);
      // And a FILE works, because that is what a caller usually has.
      expect(d.recall({ scope: "src/sim/water/flow.ts" }).map((e) => e.title).sort()).toEqual([
        "inner",
        "outer",
      ]);
      expect(d.recall({ scope: "src/net" }).map((e) => e.title)).toEqual(["elsewhere"]);
    });
  });

  test("what pre-edit reports and what its pointer returns are the same set", () => {
    // The invariant behind the bug above, stated so neither side can drift:
    // every entry the hook counts must be reachable by the command it prints.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      for (const scope of ["", "src", "src/sim", "src/sim/water"]) {
        d.write("s1", "a", ok({ title: `at ${scope || "root"}`, topic: "x", scope }), now);
      }
      const file = "src/sim/water/flow.ts";
      const counted = d.countForPath(file);
      // `recall --scope <file>` excludes the repo-wide entry (scope ""), which
      // is deliberate: a repo-wide note is not "about this folder".
      const reachable = d.recall({ scope: file, limit: 100 }).length;
      expect(counted).toBe(4);
      expect(reachable).toBe(3);
      // What matters is that the SCOPED ones are all reachable — the pointer
      // must not name entries the reader cannot then see.
      expect(d.forPath(file, { limit: 100 }).filter((e) => e.scope !== "").length).toBe(reachable);
    });
  });

  test("counting does not build the entries", () => {
    fresh((store) => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        store.diary.write("s1", "a", ok({ title: `t${i}`, topic: "x", scope: "src/net" }), now);
      }
      expect(store.diary.countForPath("src/net/lanes/build.ts")).toBe(3);
    });
  });
});

describe("search", () => {
  test("finds by a word in the title", () => {
    fresh((store) => {
      const now = Date.now();
      store.diary.write("s1", "a", ok({ title: "dist2 is LINEAR despite the name", topic: "core" }), now);
      expect(store.diary.recall({ query: "linear" }).length).toBe(1);
      expect(store.diary.recall({ query: "nonsense" }).length).toBe(0);
    });
  });

  test("finds by a word that is only in the BODY", () => {
    // The reason the FTS index covers both columns: the evidence often carries
    // the term the searcher remembers, and the title carries the claim.
    fresh((store) => {
      const now = Date.now();
      store.diary.write(
        "s1",
        "a",
        ok({ title: "the fast path is skipped", topic: "derive", body: "canJunctionFastPath rejects it" }),
        now,
      );
      expect(store.diary.recall({ query: "canJunctionFastPath" }).length).toBe(1);
    });
  });

  test("THE FTS INDEX IS EXTERNAL CONTENT and must be written explicitly", () => {
    // If `write` ever stops pushing the row into diary_fts, storage keeps
    // working and search silently returns nothing — the failure is invisible
    // from the write side, so it is asserted from the read side here.
    fresh((store) => {
      const now = Date.now();
      const id = store.diary.write("s1", "a", ok({ title: "findable", topic: "x" }), now);
      expect(store.diary.get(id)).not.toBeNull();
      expect(store.diary.recall({ query: "findable" }).map((e) => e.id)).toEqual([id]);
    });
  });

  test("a query with FTS operators in it does not throw", () => {
    // `dist2 - linear` and `what?` are ordinary things to search for; bare
    // punctuation is MATCH syntax and throws. A throw here would be a hook
    // failing on an ordinary word.
    fresh((store) => {
      const now = Date.now();
      store.diary.write("s1", "a", ok({ title: "dist2 is linear", topic: "core" }), now);
      for (const q of ["dist2 - linear", 'a "quoted', "what?", "*", "AND OR NOT", "-x"]) {
        expect(() => store.diary.recall({ query: q })).not.toThrow();
      }
      expect(store.diary.recall({ query: "dist2 - linear" }).length).toBe(1);
    });
  });

  test("ftsQuery survives empty and punctuation-only input", () => {
    expect(ftsQuery("")).toBe('""');
    expect(ftsQuery("   ")).toBe('""');
    expect(ftsQuery('a "b')).toBe('"a" OR "b"');
  });

  test("a tag filter does not match a LONGER tag with the same prefix", () => {
    // Why tags are stored comma-wrapped. `LIKE '%perf%'` matches
    // `perf-regression` and quietly widens every search that uses it.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "one", topic: "x", tags: ["perf"] }), now);
      d.write("s1", "a", ok({ title: "two", topic: "x", tags: ["perf-regression"] }), now);
      expect(d.recall({ tag: "perf" }).map((e) => e.title)).toEqual(["one"]);
      expect(d.recall({ tag: "perf-regression" }).map((e) => e.title)).toEqual(["two"]);
    });
  });

  test("packTags wraps so the LIKE cannot straddle two tags", () => {
    expect(packTags(["a", "b"])).toBe(",a,b,");
    expect(packTags([])).toBe("");
  });

  test("filters compose", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "slow derive", topic: "derive", tags: ["perf"], kind: "optimization" }), now);
      d.write("s1", "a", ok({ title: "slow water", topic: "water", tags: ["perf"], kind: "optimization" }), now);
      d.write("s2", "b", ok({ title: "broken water", topic: "water", kind: "error" }), now);

      expect(d.recall({ topic: "water" }).length).toBe(2);
      expect(d.recall({ topic: "water", kind: "error" }).map((e) => e.title)).toEqual(["broken water"]);
      expect(d.recall({ tag: "perf" }).length).toBe(2);
      expect(d.recall({ sessionId: "s2" }).map((e) => e.title)).toEqual(["broken water"]);
    });
  });
});

describe("freshness", () => {
  test("a deprecated entry leaves the default results but stays findable", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "selfFlattens kills the fast path", topic: "derive" }), now);
      expect(d.recall({}).length).toBe(1);

      expect(d.deprecate(id, "the guard was deleted in 9f6ccae", now)).toBe(true);
      // Gone from the default view...
      expect(d.recall({}).length).toBe(0);
      // ...but NOT deleted: "this was believed, and here is why it stopped
      // being true" is usually worth more than the claim was.
      const all = d.recall({ all: true });
      expect(all.length).toBe(1);
      expect(all[0]?.deprecatedWhy).toContain("9f6ccae");
    });
  });

  test("deprecating twice does not overwrite the first reason", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "t", topic: "x" }), now);
      expect(d.deprecate(id, "first reason", now)).toBe(true);
      expect(d.deprecate(id, "second reason", now + 1000)).toBe(false);
      expect(d.get(id)?.deprecatedWhy).toBe("first reason");
    });
  });

  test("superseding points at the replacement and retires the old one", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const old = d.write("s1", "a", ok({ title: "old claim", topic: "x" }), now);
      const fresher = d.write("s1", "a", ok({ title: "new claim", topic: "x" }), now + 1);

      expect(d.supersede(old, fresher, now + 2)).toBe(true);
      expect(d.get(old)?.supersededBy).toBe(fresher);
      // Retired, so a search lands on the current one...
      expect(d.recall({}).map((e) => e.id)).toEqual([fresher]);
      // ...and can still walk back to what it grew out of.
      expect(d.recall({ all: true }).length).toBe(2);
    });
  });

  test("an entry cannot supersede itself or a missing entry", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "t", topic: "x" }), now);
      expect(d.supersede(id, id, now)).toBe(false);
      expect(d.supersede(id, 9999, now)).toBe(false);
    });
  });

  test("pre-edit never surfaces a deprecated entry", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "stale", topic: "x", scope: "src/net" }), now);
      d.deprecate(id, "no longer true", now);
      expect(d.forPath("src/net/lanes.ts").length).toBe(0);
      expect(d.countForPath("src/net/lanes.ts")).toBe(0);
    });
  });
});

describe("organisation", () => {
  test("topics carry a count and a last-written time", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "one", topic: "water" }), now);
      d.write("s1", "a", ok({ title: "two", topic: "water" }), now + 5);
      d.write("s1", "a", ok({ title: "three", topic: "roads" }), now);

      const t = d.topics();
      expect(t[0]?.topic).toBe("water");
      expect(t[0]?.count).toBe(2);
      expect(t[0]?.lastMs).toBe(now + 5);
    });
  });

  test("merging folds one topic into another, INCLUDING in search", () => {
    // The FTS index carries its own copy of `topic`, so a merge that updates
    // only the base table leaves search answering under the old name.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "one", topic: "water-sim" }), now);
      d.write("s1", "a", ok({ title: "two", topic: "water" }), now);

      expect(d.mergeTopic("water-sim", "water")).toBe(1);
      expect(d.topics().map((t) => t.topic)).toEqual(["water"]);
      expect(d.recall({ topic: "water" }).length).toBe(2);
      expect(d.recall({ topic: "water-sim" }).length).toBe(0);
    });
  });

  test("merging a topic into itself is a no-op, not a wipe", () => {
    fresh((store) => {
      const now = Date.now();
      store.diary.write("s1", "a", ok({ title: "one", topic: "water" }), now);
      expect(store.diary.mergeTopic("water", "water")).toBe(0);
      expect(store.diary.recall({ topic: "water" }).length).toBe(1);
    });
  });

  test("the tag cloud counts across entries", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "one", topic: "x", tags: ["perf", "bun"] }), now);
      d.write("s1", "a", ok({ title: "two", topic: "y", tags: ["perf"] }), now);
      expect(d.tagCloud()).toEqual([
        { tag: "perf", count: 2 },
        { tag: "bun", count: 1 },
      ]);
    });
  });
});

describe("near-duplicate topics", () => {
  test("a qualifier on a shared stem is flagged", () => {
    // The duplicates that actually happen: someone writes `water`, someone else
    // writes `water-sim` a day later, and search quietly splits in two.
    expect(nearTopic("water", "water-sim")).toBe(true);
    expect(nearTopic("water-sim", "water")).toBe(true);
    expect(nearTopic("water", "water-sim-timberborn")).toBe(true);
  });

  test("unrelated short topics are NOT flagged", () => {
    // An edit-distance rule loose enough to catch `water`/`water-sim` also
    // pairs these, and a hint that cries wolf gets ignored.
    expect(nearTopic("gen", "net")).toBe(false);
    expect(nearTopic("roads", "render")).toBe(false);
    expect(nearTopic("water", "water")).toBe(false);
  });

  test("a LEADING qualifier changes the subject and is not flagged", () => {
    // `deep-water` is not a narrowing of `water` the way `water-deep` is.
    expect(nearTopic("water", "deep-water")).toBe(false);
  });
});

describe("titles wrap rather than truncate", () => {
  test("a long title keeps its ending", () => {
    // The end of a title carries the claim — "…despite the name" is the whole
    // point of the `dist2` entry. Truncating makes the reader open the body to
    // find out whether the result was relevant, which is the cost the
    // title/body split exists to avoid.
    const title =
      "dist2 in core/math.ts is LINEAR distance despite the name — comparing it against squared values is a recurring bug source";
    const lines = wrap(title, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(title);
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(60);
  });

  test("a word longer than the width is not broken mid-identifier", () => {
    const lines = wrap("resolveBuildingVisualBounds is the only oracle", 12);
    expect(lines[0]).toBe("resolveBuildingVisualBounds");
  });

  test("survives empty input", () => {
    expect(wrap("", 20)).toEqual([""]);
  });
});

describe("attribution", () => {
  test("the author resolves to the LIVE name after a rename", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("sess-a", "/tree", "master", now);
      store.setAlias("sess-a", "tooling", now);
      const id = store.diary.write("sess-a", "tooling", ok({ title: "t", topic: "x" }), now);

      store.setAlias("sess-a", "hopper", now);
      // Frozen-only would credit a name nobody uses any more.
      expect(store.diary.get(id)?.agent).toBe("hopper");
    });
  });

  test("an unnamed author reads as 'someone', never as a hex slice", () => {
    // A session-id slice frozen into an entry names nobody and never will —
    // and a diary entry outlives its author by a year, where a board item
    // expires in a week. Better an honest word than a false identifier.
    fresh((store) => {
      const now = Date.now();
      const id = store.diary.write("no-roster-row", "", ok({ title: "t", topic: "x" }), now);
      const author = store.diary.get(id)?.agent ?? "";
      expect(author).toBe("someone");
      expect(author).not.toContain("no-roster");
    });
  });

  test("a later registration gives an unnamed entry its author back", () => {
    // The reason the name is resolved at READ time rather than frozen: an agent
    // that writes before its roster row exists is still that agent.
    fresh((store) => {
      const now = Date.now();
      const id = store.diary.write("sess-late", "", ok({ title: "t", topic: "x" }), now);
      expect(store.diary.get(id)?.agent).toBe("someone");

      store.register("sess-late", "/tree", "master", now);
      store.setAlias("sess-late", "hopper", now);
      expect(store.diary.get(id)?.agent).toBe("hopper");
    });
  });

  test("the frozen name survives the author leaving", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("sess-a", "/tree", "master", now);
      store.setAlias("sess-a", "hopper", now);
      const id = store.diary.write("sess-a", "hopper", ok({ title: "t", topic: "x" }), now);

      store.unregister("sess-a");
      // No live row to resolve against, so the write-time copy is the answer.
      expect(store.diary.get(id)?.agent).toBe("hopper");
    });
  });
});
