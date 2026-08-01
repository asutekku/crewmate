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
import { loadConfig } from "../core/config.ts";
// The hook's own formatter, exported so the contract between what it COUNTS and
// what the command it PRINTS returns can be asserted. Driving the hook as a
// subprocess would test the same thing far more slowly and far less precisely.
import { diaryLines } from "../hooks/pre-edit.ts";
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
  STALE_ENTRY_MS,
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

  test("a TOP-LEVEL DOTFOLDER is a folder, not a file", () => {
    // Caught 2026-08-01 by trying to scope a finding to `.claude` and watching
    // it come back unscoped: the "looks like a file" test matched the leading
    // dot, so every top-level dotfolder was stripped to "" and silently became
    // repo-wide. This repo keeps its agent tooling in one, so the feature could
    // not describe the folder it lives in.
    expect(normaliseScope(".claude")).toBe(".claude");
    expect(normaliseScope(".github")).toBe(".github");
    expect(normaliseScope(".claude/hooks")).toBe(".claude/hooks");
    // A real dotfile still reduces to its folder — an extension needs something
    // in front of the dot, which is what tells the two apart.
    expect(normaliseScope(".claude/settings.json")).toBe(".claude");
  });

  test("an unscopeable scope is never SILENTLY dropped to repo-wide", () => {
    // The property behind the bug above. Passing a scope and getting "" back
    // means the entry never surfaces at edit time, which is the one thing that
    // makes the diary worth writing to — so it must not happen by accident.
    for (const given of [".claude", ".github", "src", "test", "src/sim/water"]) {
      expect(normaliseScope(given)).not.toBe("");
    }
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

  test("A NUL BYTE IN A QUERY DOES NOT THROW, in any position", () => {
    // Quoting each term makes every FTS operator character into data — except
    // this one, which is not an operator at all. SQLite binds a JS string as a
    // C string, so a NUL TRUNCATES the statement text: the closing quote
    // `ftsQuery` just appended lands after the cut and the driver throws
    // `unterminated string`. Measured 2026-08-01 against the unfixed code: a
    // NUL leading, mid-term, trailing OR alone all threw.
    //
    // This matters because `recall` is reachable from `pre-edit`, and a throw
    // there is a hook that fails on an ordinary edit — the failure mode the
    // whole quoting scheme exists to prevent.
    fresh((store) => {
      const now = Date.now();
      store.diary.write("s1", "a", ok({ title: "water flows downhill", topic: "water" }), now);
      for (const q of ["\u0000abc", "ab\u0000cd", "abc\u0000", "\u0000", "a \u0000 b"]) {
        expect(() => store.diary.recall({ query: q })).not.toThrow();
      }
      // Stripped, not escaped — a NUL carries no search intent, so the rest of
      // the term must still find the entry.
      expect(store.diary.recall({ query: "wa\u0000ter" }).length).toBe(1);
    });
  });

  test("genuinely hostile search input returns nothing rather than throwing", () => {
    // A user's search box reaches MATCH directly. These are the shapes that
    // are FTS5 SYNTAX rather than words — an unpaired quote, a column filter,
    // a NEAR operator, an unbalanced paren — plus the size and encoding
    // extremes. Every one must be inert, because the alternative is a hook
    // that dies on a search somebody typed in good faith.
    fresh((store) => {
      const now = Date.now();
      store.diary.write("s1", "a", ok({ title: "dist2 is linear", topic: "core" }), now);
      const hostile = [
        '"',
        "*",
        "NEAR/2",
        "^",
        "-",
        "...",
        "title:foo",
        "nosuchcolumn:foo",
        "(",
        "(a OR b)",
        "{a}",
        "x".repeat(10_000),
        "日本語 café ñ",
        "🔥🔥",
        Array.from({ length: 600 }, (_, i) => `t${i}`).join(" "),
      ];
      for (const q of hostile) {
        expect(() => store.diary.recall({ query: q })).not.toThrow();
      }
    });
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

  test("superseding writes its own reason, so `diary check` stays quiet", () => {
    // `diary check` flags a deprecation with no reason and flagged both entries
    // superseding had retired — correctly, since "no longer true" and nothing
    // else is the least useful thing an entry can say. The replacement IS the
    // explanation, so it is recorded rather than left blank.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const old = d.write("s1", "a", ok({ title: "old claim", topic: "x", scope: "src" }), now);
      const fresher = d.write("s1", "a", ok({ title: "the newer claim", topic: "x", scope: "src" }), now);
      d.supersede(old, fresher, now);

      expect(d.get(old)?.deprecatedWhy).toContain(`#${fresher}`);
      expect(d.get(old)?.deprecatedWhy).toContain("the newer claim");
      expect(d.check(now).filter((p) => p.kind === "deprecated-without-reason")).toEqual([]);
    });
  });

  test("an explicit reason is not overwritten by a later supersede", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const old = d.write("s1", "a", ok({ title: "old", topic: "x", scope: "src" }), now);
      const fresher = d.write("s1", "a", ok({ title: "new", topic: "x", scope: "src" }), now);
      d.deprecate(old, "measured wrong on seed 42", now);
      d.supersede(old, fresher, now);
      // The human reason is the better one; superseding only fills a GAP.
      expect(d.get(old)?.deprecatedWhy).toBe("measured wrong on seed 42");
      expect(d.get(old)?.supersededBy).toBe(fresher);
    });
  });

  test("a missing reason can be filled in later, so `diary check` has a repair", () => {
    // `deprecate` refuses an already-retired entry, which also made an EMPTY
    // reason permanently unfixable — `diary check` would report "does not say
    // why" forever with no command able to answer it. A report with no repair
    // is the same dead end as advice that fails when followed.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "t", topic: "x", scope: "src" }), now);
      d.deprecate(id, "", now);
      expect(d.check(now).some((p) => p.kind === "deprecated-without-reason")).toBe(true);

      expect(d.explainDeprecation(id, "measured wrong on seed 42")).toBe(true);
      expect(d.get(id)?.deprecatedWhy).toBe("measured wrong on seed 42");
      expect(d.check(now).some((p) => p.kind === "deprecated-without-reason")).toBe(false);
    });
  });

  test("filling in a reason NEVER overwrites one somebody wrote", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "t", topic: "x", scope: "src" }), now);
      d.deprecate(id, "the original reason", now);
      // The guard this preserves — the one the blanket refusal was protecting.
      expect(d.explainDeprecation(id, "a later, worse reason")).toBe(false);
      expect(d.get(id)?.deprecatedWhy).toBe("the original reason");
    });
  });

  test("a LIVE entry cannot be given a deprecation reason", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "t", topic: "x", scope: "src" }), now);
      // Explaining a deprecation that has not happened would leave an entry
      // reading as retired while still live in every query.
      expect(d.explainDeprecation(id, "why")).toBe(false);
      expect(d.get(id)?.deprecatedMs).toBe(0);
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

  test("a merged topic is findable BY FTS MATCH under the new name, not the old", () => {
    // The test above passes on broken code. It filters on `diary.topic`, which
    // is an ordinary column on the base table, so it never touches the FTS
    // index at all — and the index is where a merge silently fails.
    //
    // WHY THE FAILURE IS INVISIBLE FROM EVERY OTHER ANGLE. `diary_fts` is an
    // EXTERNAL CONTENT table: an `UPDATE diary_fts SET topic = ?` reports rows
    // changed, and a later `SELECT topic FROM diary_fts` reads THROUGH to the
    // content table and shows the NEW value. Only `MATCH` reads the index
    // itself. Measured 2026-08-01 against the unfixed code: after merging
    // `water-sim` into `hydrology`, `MATCH "water-sim"` still returned the row
    // and `MATCH "hydrology"` returned nothing — search answered under a topic
    // that no longer existed and refused the one that did.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "spillover is clamped", topic: "water-sim" }), now);

      expect(d.mergeTopic("water-sim", "hydrology")).toBe(1);
      // A query is FTS-ranked, so these two go through MATCH.
      expect(d.recall({ query: "hydrology" }).map((e) => e.id)).toEqual([id]);
      expect(d.recall({ query: "water-sim" }).length).toBe(0);
      // And the merge must not cost the entry its OTHER search terms — a
      // delete/insert repair that dropped the title would pass the two above.
      expect(d.recall({ query: "spillover" }).map((e) => e.id)).toEqual([id]);
    });
  });

  test("a merge keeps body and tags searchable", () => {
    // The repair rewrites the whole FTS row, so every indexed column is at risk,
    // not just the one being merged.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write(
        "s1",
        "a",
        ok({
          title: "the guard rejects it",
          topic: "old-topic",
          body: "canJunctionFastPath refuses a geometry change",
          tags: ["perf", "derive"],
        }),
        now,
      );
      d.mergeTopic("old-topic", "derive-fastpath");

      expect(d.recall({ query: "canJunctionFastPath" }).map((e) => e.id)).toEqual([id]);
      expect(d.recall({ query: "derive-fastpath" }).map((e) => e.id)).toEqual([id]);
      // The tag COLUMN is untouched by a topic merge and must stay intact.
      expect(d.recall({ tag: "perf" }).map((e) => e.id)).toEqual([id]);
      expect(d.get(id)?.tags).toEqual(["perf", "derive"]);
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

describe("diary check", () => {
  test("a clean diary reports nothing", () => {
    fresh((store) => {
      const now = Date.now();
      store.diary.write("s1", "a", ok({ title: "t", topic: "water", scope: "src/sim/water" }), now);
      expect(store.diary.check(now)).toEqual([]);
    });
  });

  test("near-duplicate topics are reported ONCE, with the merge that fixes them", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "one", topic: "water", scope: "src" }), now);
      d.write("s1", "a", ok({ title: "two", topic: "water", scope: "src" }), now);
      d.write("s1", "a", ok({ title: "three", topic: "water-sim", scope: "src" }), now);

      const dupes = d.check(now).filter((p) => p.kind === "near-duplicate-topic");
      // ONE problem, not two — a pair reported from both ends is the same pair.
      expect(dupes.length).toBe(1);
      // And it merges the SMALLER into the larger, which is the cheaper edit.
      expect(dupes[0]?.fix).toBe("cli.ts topic merge water-sim water");
    });
  });

  test("a reference to an entry that no longer exists is caught", () => {
    // The exact rot the memory dir it replaces already has: 4 dangling
    // wikilinks out of 99, all near-misses, because nothing ever checked.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const old = d.write("s1", "a", ok({ title: "old", topic: "x", scope: "src" }), now);
      const fresher = d.write("s1", "a", ok({ title: "new", topic: "x", scope: "src" }), now);
      d.supersede(old, fresher, now);
      // The replacement is pruned away, leaving a pointer to nothing.
      (store as unknown as { db: { query: (s: string) => { run: (n: number) => void } } }).db
        .query(`DELETE FROM diary WHERE id = ?`)
        .run(fresher);

      const dangling = d.check(now).filter((p) => p.kind === "dangling-reference");
      expect(dangling.length).toBe(1);
      expect(dangling[0]?.detail).toContain(`#${old}`);
    });
  });

  test("unscoped entries are flagged, because nothing surfaces them", () => {
    fresh((store) => {
      const now = Date.now();
      store.diary.write("s1", "a", ok({ title: "no scope", topic: "x" }), now);
      const p = store.diary.check(now).filter((x) => x.kind === "unscoped");
      expect(p.length).toBe(1);
      expect(p[0]?.detail).toContain("nothing surfaces them");
    });
  });

  test("a deprecation with no reason is flagged", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "t", topic: "x", scope: "src" }), now);
      d.deprecate(id, "", now);
      const p = d.check(now).filter((x) => x.kind === "deprecated-without-reason");
      // "This stopped being true" and nothing else is the least useful thing an
      // entry can say — the reason IS the value.
      expect(p.length).toBe(1);
    });
  });

  test("an old entry is UNVERIFIED, not wrong", () => {
    fresh((store) => {
      const now = Date.now();
      store.diary.write(
        "s1",
        "a",
        ok({ title: "ancient", topic: "x", scope: "src" }),
        now - STALE_ENTRY_MS - 1000,
      );
      const p = store.diary.check(now).filter((x) => x.kind === "unverified");
      expect(p.length).toBe(1);
      // The wording matters: an old finding is not a wrong one, and saying so
      // is cheaper for the next reader than letting them guess.
      expect(p[0]?.detail).toContain("not wrong");
    });
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

describe("what pre-edit actually prints", () => {
  test("EVERY COMMAND THE HOOK PRINTS RETURNS WHAT IT PROMISES", () => {
    // THE DEFECT THIS CATCHES, measured 2026-08-01 by driving the real hook:
    // with two repo-wide entries and no scoped ones, `pre-edit` printed
    //
    //   The diary has 2 entries about this folder:
    //   - 2 more diary entries cover this folder — `cli.ts recall --scope <file>`
    //
    // and that command returned ZERO rows. `countForPath` counts repo-wide
    // entries (scope ""), `recall --scope` deliberately excludes them, and the
    // hook subtracted one from the other as though they were one set.
    //
    // It is the same defect class the file already carries a note about — the
    // `--scope` equality bug — and the same shape as a refusal that suggests a
    // repair that does not work: an agent that follows the advice gets nothing
    // and learns to stop following it.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      d.write("s1", "a", ok({ title: "CRLF defeats multiline perl", topic: "tooling" }), now);
      d.write("s1", "a", ok({ title: "never git stash in a shared tree", topic: "tooling" }), now);

      const lines = diaryLines(store, "src/sim/water/flow.ts");
      const text = lines.join("\n");
      // It must NOT send the reader to a scope query that cannot match, because
      // neither entry is scoped to anything.
      expect(text).not.toContain("--scope");
      // Named as what they are: repo-wide, not "about this folder".
      expect(text).toContain("repo-wide");
    });
  });

  test("a scoped remainder still gets the --scope pointer, and it resolves", () => {
    // The other half of the same contract: when the remainder IS reachable by
    // `--scope`, the hook must still say so. A fix that simply deleted the
    // pointer would pass the test above and lose the feature.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const file = "src/sim/water/flow.ts";
      for (let i = 0; i < 4; i++) {
        d.write("s1", "a", ok({ title: `scoped ${i}`, topic: "x", scope: "src/sim/water" }), now);
      }
      const text = diaryLines(store, file).join("\n");
      expect(text).toContain(`--scope ${file}`);
      // The command named in the text has to return something.
      expect(d.recall({ scope: file, limit: 100 }).length).toBeGreaterThan(0);
    });
  });

  test("a MIXED folder reports each half by the command that reaches it", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const file = "src/sim/water/flow.ts";
      d.write("s1", "a", ok({ title: "repo wide one", topic: "x" }), now);
      d.write("s1", "a", ok({ title: "repo wide two", topic: "x" }), now);
      d.write("s1", "a", ok({ title: "scoped one", topic: "x", scope: "src/sim/water" }), now);

      const text = diaryLines(store, file).join("\n");
      // Both halves named, each with the command that actually returns it.
      expect(text).toContain("--scope");
      expect(text).toContain("repo-wide");
      // The counts must add up to what the header claims.
      expect(text).toContain("3 entries");
    });
  });

  test("a loud entry is quoted and NOT double-counted in the remainder", () => {
    // The remainder is "everything the reader has not already been shown". An
    // off-by-one here tells the agent to go looking for an entry it just read.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const file = "src/net/lanes.ts";
      d.write("s1", "a", ok({ title: "the loud one", topic: "x", kind: "warning", scope: "src/net" }), now);
      d.write("s1", "a", ok({ title: "a quiet one", topic: "x", scope: "src/net" }), now);

      const text = diaryLines(store, file).join("\n");
      expect(text).toContain("the loud one");
      // One shown, one left — not two.
      expect(text).toContain("1 more");
    });
  });

  test("an empty folder produces no lines at all", () => {
    // The hook injects context on EVERY edit, so "nothing to say" has to cost
    // nothing rather than emitting an empty header.
    fresh((store) => {
      expect(diaryLines(store, "src/untouched/file.ts")).toEqual([]);
    });
  });

  test("a deprecated entry is neither counted nor pointed at", () => {
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "was true once", topic: "x", scope: "src/net" }), now);
      d.deprecate(id, "the guard was deleted", now);
      expect(diaryLines(store, "src/net/lanes.ts")).toEqual([]);
    });
  });
});

describe("prune keeps the index honest", () => {
  test("a pruned entry leaves NO phantom search hit", () => {
    // An external-content index does not follow a DELETE either, so a pruned
    // row would keep matching a search and then resolve to nothing — the
    // dangling-reference rot, but in the search path where nothing checks it.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const cfg = loadConfig();
      d.write("s1", "a", ok({ title: "ancientuniqueterm here", topic: "x", scope: "src" }), now - cfg.diaryKeepMs - 1000);
      const keep = d.write("s1", "a", ok({ title: "freshuniqueterm here", topic: "x", scope: "src" }), now);
      expect(d.recall({ query: "ancientuniqueterm", all: true }).length).toBe(1);

      d.prune(now);
      expect(d.recall({ query: "ancientuniqueterm", all: true }).length).toBe(0);
      // And the survivor is still findable — a rebuild that dropped everything
      // would pass the assertion above.
      expect(d.recall({ query: "freshuniqueterm", all: true }).map((e) => e.id)).toEqual([keep]);
    });
  });

  test("pruning an empty diary is not an error", () => {
    fresh((store) => {
      expect(() => store.diary.prune(Date.now())).not.toThrow();
    });
  });
});

describe("deprecation interacts with everything else", () => {
  test("a deprecated entry is not ALSO reported as unscoped or unverified", () => {
    // `check` exists to name real problems. An entry that is already retired is
    // not a scoping problem and not an unverified claim — reporting it as both
    // would bury the live problems under noise about entries nobody will read.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "ancient and unscoped", topic: "x" }), now - STALE_ENTRY_MS - 1000);
      d.deprecate(id, "the code was deleted", now);
      expect(d.check(now)).toEqual([]);
    });
  });

  test("a whitespace-only reason is stored as EMPTY, so it stays repairable", () => {
    // `deprecate` trims. If "   " were stored verbatim, `check` would see a
    // non-empty reason and never flag it, while a reader sees nothing — a
    // problem that is invisible to the one tool meant to find it. And
    // `explainDeprecation` only writes into a BLANK field, so it could never
    // fix it either.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const id = d.write("s1", "a", ok({ title: "t", topic: "x", scope: "src" }), now);
      d.deprecate(id, "   ", now);
      expect(d.get(id)?.deprecatedWhy).toBe("");
      expect(d.check(now).some((p) => p.kind === "deprecated-without-reason")).toBe(true);
      // ...and the repair reaches it.
      expect(d.explainDeprecation(id, "a real reason")).toBe(true);
      expect(d.check(now).some((p) => p.kind === "deprecated-without-reason")).toBe(false);
    });
  });

  test("SUPERSEDING BY AN ALREADY-DEAD ENTRY IS ALLOWED, and points at a dead end", () => {
    // Documents shipped behaviour rather than asserting it is right.
    // `supersede` checks only that the replacement EXISTS, not that it is live,
    // so `#a → see #b` can be printed for a `#b` that is itself retired. The
    // reader follows the pointer and lands on another tombstone.
    //
    // `check`'s dangling-reference rule does NOT catch this — it looks for a
    // target that does not exist, and this one does. Left alone because
    // refusing it would also refuse the legitimate case where a chain is
    // retired in one pass, and a wrong refusal is worse than a weak pointer.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const a = d.write("s1", "a", ok({ title: "aaa", topic: "x", scope: "src" }), now);
      const b = d.write("s1", "a", ok({ title: "bbb", topic: "x", scope: "src" }), now);
      d.deprecate(b, "b stopped being true too", now);

      expect(d.supersede(a, b, now)).toBe(true);
      expect(d.get(a)?.supersededBy).toBe(b);
      expect(d.check(now).filter((p) => p.kind === "dangling-reference")).toEqual([]);
    });
  });

  test("a supersede CYCLE is storable and cannot hang a reader", () => {
    // Two entries can point at each other. It is only survivable because
    // nothing WALKS the chain — `cli.ts note` prints one hop ("→ see #n") and
    // stops. Pinned so that anyone who later adds chain-following knows a cycle
    // is reachable and has to bound the walk.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      const a = d.write("s1", "a", ok({ title: "aaa", topic: "x", scope: "src" }), now);
      const b = d.write("s1", "a", ok({ title: "bbb", topic: "x", scope: "src" }), now);
      d.supersede(a, b, now);
      d.supersede(b, a, now);
      expect(d.get(a)?.supersededBy).toBe(b);
      expect(d.get(b)?.supersededBy).toBe(a);
      // Both retired, so neither is volunteered at edit time.
      expect(d.forPath("src/anything.ts")).toEqual([]);
    });
  });

  test("forPath is CAPPED but countForPath is not, and the hook relies on both", () => {
    // `forPath` bounds what an edit pays for; `countForPath` is the honest
    // total. They are deliberately different numbers, and the hook subtracts
    // one from the other — so a change that made `countForPath` respect the cap
    // would silently make the remainder always zero.
    fresh((store) => {
      const now = Date.now();
      const d = store.diary;
      for (let i = 0; i < 50; i++) {
        d.write("s1", "a", ok({ title: `bulk ${i}`, topic: "x", scope: "src/net" }), now);
      }
      expect(d.forPath("src/net/x.ts").length).toBe(5);
      expect(d.forPath("src/net/x.ts", { limit: 2 }).length).toBe(2);
      expect(d.countForPath("src/net/x.ts")).toBe(50);
    });
  });
});
