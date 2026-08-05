/**
 * The aggregates behind `crew stats`, against a real (throwaway) db.
 *
 * WHY THESE ARE WORTH PINNING. This command exists because the same numbers
 * were previously gathered by hand-written SQL, and two of six such attempts
 * failed — one on a guessed db path, one on a column that does not exist
 * (`messages.sender`; the real ones are `from_name`/`to_name`). A wrong column
 * throws and is caught; a wrong FILTER is silent and reports a plausible number
 * that is simply not the one you asked for. So every case below seeds rows
 * whose right answer differs from the answer a plausible mistake would give:
 * two names in one hour rather than two rows, a `say` with `to_session` but no
 * `to_name`, an agent whose sessions changed mid-life.
 *
 * No colour is asserted anywhere. The aggregation is a pure function over a
 * `Database`; the printing lives in cli.ts and is not this file's business.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import {
  agentActivity,
  agentCounts,
  collectStats,
  concurrency,
  countableTable,
  featureUse,
  hasTable,
  messageStats,
  sample,
  sizeText,
  spanText,
  tableCounts,
  usageFlag,
} from "../core/stats.ts";

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

let n = 0;
const paths: string[] = [];

/**
 * A fresh db per test, under the OS temp dir.
 *
 * NEVER beside the source and never a `/tmp/...` literal. Several agents share
 * this checkout, so a stray `-wal` pair shows up in everyone's `git status`;
 * and under Git Bash on Windows a `/tmp` path resolves to a DIFFERENT file
 * across processes, which is how a test db silently forks in two.
 */
function fresh<T>(fn: (db: Database) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-stats-${process.pid}-${n++}.db`;
  paths.push(path);
  // `withStore` FIRST, for its side effect: it runs the shipped schema and
  // every live migration, so these tests read the tables that actually ship
  // rather than a hand-rolled copy that a migration would silently outdate.
  // The connection is then reopened here, because `Store` keeps its handle
  // private and the aggregates take a `Database`.
  withStore(path, () => undefined);
  const db = new Database(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
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

function edit(db: Database, agent: string, tsMs: number, path = "src/a.ts", session = ""): void {
  db.query(
    `INSERT INTO edits (ts_ms, path, session_id, agent, worktree, branch, tool)
     VALUES (?, ?, ?, ?, '', '', 'Edit')`,
  ).run(tsMs, path, session === "" ? `sess-${agent}` : session, agent);
}

function message(
  db: Database,
  over: { handle?: string; kind?: string; toName?: string; toSession?: string } = {},
): void {
  db.query(
    `INSERT INTO messages (ts_ms, handle, kind, body, to_session, from_name, to_name)
     VALUES (?, ?, ?, 'x', ?, ?, ?)`,
  ).run(
    T0,
    over.handle ?? "ada",
    over.kind ?? "say",
    over.toSession ?? "",
    over.handle ?? "ada",
    over.toName ?? "",
  );
}

describe("hasTable / countableTable", () => {
  test("hasTable answers for a table the shipped schema creates, and one it does not", () => {
    fresh((db) => {
      expect(hasTable(db, "edits")).toBe(true);
      expect(hasTable(db, "diary")).toBe(true);
      // The guard that lets `stats` run against an older project db in the same
      // folder, which genuinely has fewer tables than this one.
      expect(hasTable(db, "nothing_like_this")).toBe(false);
    });
  });

  test("sqlite internals and FTS shadow tables are not state this tool accumulated", () => {
    expect(countableTable("edits")).toBe(true);
    expect(countableTable("sqlite_sequence")).toBe(false);
    expect(countableTable("diary_fts_data")).toBe(false);
    expect(countableTable("diary_fts_idx")).toBe(false);
    expect(countableTable("diary_fts_docsize")).toBe(false);
    expect(countableTable("diary_fts_config")).toBe(false);
    // The FTS table itself goes too: it is a view of `diary`, so counting it
    // reports the same 37 findings twice under two different names.
    expect(countableTable("diary_fts")).toBe(false);
  });
});

describe("tableCounts", () => {
  test("counts every real table, biggest first, and skips the shadows", () => {
    fresh((db) => {
      edit(db, "ada", T0);
      edit(db, "ada", T0 + 1000, "src/b.ts");
      edit(db, "bo", T0 + 2000, "src/c.ts");
      message(db);
      const counts = tableCounts(db);
      const byName = new Map(counts.map((c) => [c.table, c.rows]));
      expect(byName.get("edits")).toBe(3);
      expect(byName.get("messages")).toBe(1);
      // Empty tables are still listed: a table missing from the report reads as
      // a table that does not exist, which is a different fact.
      expect(byName.has("work")).toBe(true);
      expect(byName.get("work")).toBe(0);
      for (const c of counts) expect(countableTable(c.table)).toBe(true);
    });
  });

  test("is sorted descending, with ties broken by name so runs do not shuffle", () => {
    fresh((db) => {
      edit(db, "ada", T0);
      edit(db, "ada", T0 + 1);
      message(db);
      const counts = tableCounts(db);
      for (let i = 1; i < counts.length; i++) {
        const prev = counts[i - 1];
        const cur = counts[i];
        if (!prev || !cur) continue;
        expect(prev.rows >= cur.rows).toBe(true);
        if (prev.rows === cur.rows) expect(prev.table < cur.table).toBe(true);
      }
    });
  });
});

describe("agentCounts", () => {
  test("the four sources disagree, which is the whole point of printing four", () => {
    fresh((db) => {
      // Three agents edit; two of them message; one opens work; none write a
      // finding. A single "agent count" would have to pick one of these and be
      // wrong for every other question.
      edit(db, "ada", T0);
      edit(db, "bo", T0);
      edit(db, "cy", T0);
      message(db, { handle: "ada" });
      message(db, { handle: "bo" });
      db.query(
        `INSERT INTO work (agent_id, agent_name, subject, started_ms, closed_ms, outcome,
                           updated_ms, asked_turn_ms, auto, plan_doc)
         VALUES ('session:s1', 'ada', 'x', ?, 0, '', ?, 0, 0, '')`,
      ).run(T0, T0);
      expect(agentCounts(db)).toEqual({ edits: 3, messages: 2, work: 1, diary: 0 });
    });
  });

  test("an empty agent name is not an agent", () => {
    fresh((db) => {
      edit(db, "", T0);
      edit(db, "ada", T0);
      // A hook that fired before the session had a name writes `agent: ''`, and
      // counting it would inflate every roster figure by a phantom.
      expect(agentCounts(db).edits).toBe(1);
    });
  });
});

describe("agentActivity", () => {
  test("gives each agent its edit count and the span it was alive for", () => {
    fresh((db) => {
      edit(db, "hopper", T0);
      edit(db, "hopper", T0 + 36 * HOUR, "src/b.ts");
      edit(db, "ada", T0 + HOUR, "src/c.ts");
      const rows = agentActivity(db, 10);
      expect(rows.map((r) => r.agent)).toEqual(["hopper", "ada"]);
      const hopper = rows[0];
      expect(hopper?.edits).toBe(2);
      expect(spanText(hopper?.firstMs ?? 0, hopper?.lastMs ?? 0)).toBe("36.0h");
    });
  });

  test("keys on the NAME, so one agent across two sessions is one row", () => {
    fresh((db) => {
      // A conversation that resumes arrives as a fresh uuid holding the same
      // name. Keyed on the session id, the 36-hour outlier this section exists
      // to reveal would split into two unremarkable 18-hour rows.
      edit(db, "hopper", T0, "src/a.ts", "uuid-one");
      edit(db, "hopper", T0 + 36 * HOUR, "src/b.ts", "uuid-two");
      const rows = agentActivity(db, 10);
      expect(rows.length).toBe(1);
      expect(rows[0]?.edits).toBe(2);
      expect(spanText(rows[0]?.firstMs ?? 0, rows[0]?.lastMs ?? 0)).toBe("36.0h");
    });
  });

  test("honours the limit, taking the busiest", () => {
    fresh((db) => {
      for (let i = 0; i < 5; i++) {
        for (let e = 0; e <= i; e++) edit(db, `a${i}`, T0 + e, `src/${i}-${e}.ts`);
      }
      const rows = agentActivity(db, 2);
      expect(rows.map((r) => r.agent)).toEqual(["a4", "a3"]);
    });
  });
});

describe("concurrency", () => {
  test("buckets whole hours by how many DISTINCT agents edited in them", () => {
    fresh((db) => {
      // Hour 0: one agent, twice. Hour 1: three agents. Hour 2: two agents.
      edit(db, "ada", T0, "a.ts");
      edit(db, "ada", T0 + 60_000, "b.ts");
      edit(db, "ada", T0 + HOUR, "c.ts");
      edit(db, "bo", T0 + HOUR + 1000, "d.ts");
      edit(db, "cy", T0 + HOUR + 2000, "e.ts");
      edit(db, "ada", T0 + 2 * HOUR, "f.ts");
      edit(db, "bo", T0 + 2 * HOUR + 1000, "g.ts");
      const c = concurrency(db);
      expect(c.activeHours).toBe(3);
      expect(c.peak).toBe(3);
      expect(c.buckets).toEqual([
        { agents: 1, hours: 1 },
        { agents: 2, hours: 1 },
        { agents: 3, hours: 1 },
      ]);
    });
  });

  test("counts agents, not edits — one agent editing forty times is one agent", () => {
    // The plausible mistake, and it is SILENT: `COUNT(*)` instead of
    // `COUNT(DISTINCT agent)` reports a busy solo agent as a crowd of forty,
    // which is precisely the conclusion this histogram is consulted for.
    fresh((db) => {
      for (let i = 0; i < 40; i++) edit(db, "ada", T0 + i * 1000, `src/${i}.ts`);
      const c = concurrency(db);
      expect(c.peak).toBe(1);
      expect(c.buckets).toEqual([{ agents: 1, hours: 1 }]);
    });
  });

  test("hours with no edits are not counted as hours with zero agents", () => {
    fresh((db) => {
      // A day-long gap must not become 24 rows of "0 agents": the denominator
      // is ACTIVE hours, and diluting it would make co-presence look rare
      // because the machine was asleep.
      edit(db, "ada", T0);
      edit(db, "ada", T0 + 24 * HOUR, "src/b.ts");
      const c = concurrency(db);
      expect(c.activeHours).toBe(2);
      expect(c.buckets).toEqual([{ agents: 1, hours: 2 }]);
    });
  });

  test("an empty store reports nothing rather than throwing", () => {
    fresh((db) => {
      expect(concurrency(db)).toEqual({ buckets: [], activeHours: 0, peak: 0 });
    });
  });
});

describe("messageStats", () => {
  test("splits `say` on to_name, not to_session", () => {
    fresh((db) => {
      // THE COLUMN THAT MOTIVATED THIS COMMAND. `to_session` is swept with the
      // roster at 90 minutes while `to_name` is frozen at write time, so a
      // directed message from yesterday has a name and no session — reading the
      // session column reports almost the entire history as broadcast.
      message(db, { kind: "say", toName: "bo", toSession: "" });
      message(db, { kind: "say", toName: "cy", toSession: "sess-cy" });
      message(db, { kind: "say", toName: "", toSession: "" });
      message(db, { kind: "done" });
      const m = messageStats(db);
      expect(m.directedSays).toBe(2);
      expect(m.broadcastSays).toBe(1);
      expect(m.byKind).toEqual([
        { kind: "say", count: 3 },
        { kind: "done", count: 1 },
      ]);
    });
  });

  test("an empty message log reports nothing rather than throwing", () => {
    fresh((db) => {
      expect(messageStats(db)).toEqual({ byKind: [], directedSays: 0, broadcastSays: 0 });
    });
  });
});

describe("featureUse", () => {
  test("lists every feature INCLUDING the ones with no rows", () => {
    fresh((db) => {
      const features = featureUse(db, 0);
      const names = features.map((f) => f.feature);
      for (const want of [
        "questions",
        "diary findings",
        "work items",
        "minions",
        "aliases",
        "claims",
        "personal memories",
      ]) {
        expect(names).toContain(want);
      }
      // A feature omitted for having no rows reads as one that does not exist,
      // and surfacing the empty ones is what this section is FOR — the reader
      // decides what a zero means, but only if the row is on the page.
      for (const f of features) expect(f.rows).toBe(0);
    });
  });

  test("splits questions into asked and answered", () => {
    fresh((db) => {
      db.query(
        `INSERT INTO questions (asker_session, asker_name, target_session, target_name, text,
                                answer, asked_ms, answered_ms, expired_ms, delivered_ms)
         VALUES ('s1', 'ada', 's2', 'bo', 'q', '', ?, 0, 0, 0)`,
      ).run(T0);
      db.query(
        `INSERT INTO questions (asker_session, asker_name, target_session, target_name, text,
                                answer, asked_ms, answered_ms, expired_ms, delivered_ms)
         VALUES ('s1', 'ada', 's2', 'bo', 'q2', 'a', ?, ?, 0, 0)`,
      ).run(T0, T0 + 1000);
      const q = featureUse(db, 0).find((f) => f.feature === "questions");
      expect(q?.rows).toBe(2);
      expect(q?.detail).toBe("1 answered");
    });
  });

  test("splits work into open and closed", () => {
    fresh((db) => {
      const insert = db.query(
        `INSERT INTO work (agent_id, agent_name, subject, started_ms, closed_ms, outcome,
                           updated_ms, asked_turn_ms, auto, plan_doc)
         VALUES ('session:s1', 'ada', ?, ?, ?, '', ?, 0, 0, '')`,
      );
      insert.run("open one", T0, 0, T0);
      insert.run("closed one", T0, T0 + 1000, T0);
      insert.run("closed two", T0, T0 + 2000, T0);
      const w = featureUse(db, 0).find((f) => f.feature === "work items");
      expect(w?.rows).toBe(3);
      expect(w?.detail).toBe("1 open, 2 closed");
    });
  });

  test("personal memories come from the caller — they live in another database", () => {
    fresh((db) => {
      // `personal.db` sits beside every project db rather than inside one, so
      // no query against THIS handle can ever see it.
      const m = featureUse(db, 7).find((f) => f.feature === "personal memories");
      expect(m?.rows).toBe(7);
    });
  });
});

describe("usageFlag", () => {
  test("zero and one are both flagged, and say which they were", () => {
    // One row is a feature its author tried once, which for "has anybody
    // adopted this?" is the same news as none.
    expect(usageFlag(0)).toBe("(no rows in sample — exposure unknown)");
    expect(usageFlag(1)).toBe("(1 row in sample — exposure unknown)");
  });

  test("anything more is not editorialised at all", () => {
    expect(usageFlag(2)).toBe("");
    expect(usageFlag(400)).toBe("");
  });
  test("known exposure carries its denominator instead of claiming exposure unknown",()=>{
    expect(usageFlag(0,3)).toBe("(no rows across 3 exposed session opportunities)");
    expect(usageFlag(1,3)).toBe("(1 row across 3 exposed session opportunities)");
  });

  /**
   * The flag reports an observation and stops. A row count cannot separate
   * "nobody wants this" from "it shipped on Tuesday" from "no session was ever
   * told it exists" — this store records none of those — so a verdict here
   * would turn missing instrumentation into a product judgement, in the table a
   * later agent reads as authoritative. Pinned because the flag ONCE said
   * `(unused)`, and that word is what has to stay out.
   */
  test("no verdict words: an observation, never a conclusion", () => {
    for (const rows of [0, 1]) {
      const flag = usageFlag(rows);
      expect(flag.toLowerCase()).not.toContain("unused");
      expect(flag.toLowerCase()).not.toContain("dead");
      expect(flag).toContain("sample");
      expect(flag).toContain("exposure unknown");
    }
  });
});

describe("sample", () => {
  test("reports the window every other number is relative to", () => {
    fresh((db) => {
      edit(db, "luna", T0);
      edit(db, "rowan", T0 + 30 * 60_000);
      edit(db, "luna", T0 + 5 * HOUR);
      const s = sample(db);
      expect(s.activeHours).toBe(2);
      expect(s.spanMs).toBe(5 * HOUR);
    });
  });

  test("an empty store reports a zero window rather than crashing", () => {
    fresh((db) => {
      expect(sample(db)).toEqual({ activeHours: 0, spanMs: 0 });
    });
  });

  test("collectStats carries the sample, so no caller can print counts without it", () => {
    fresh((db) => {
      edit(db, "luna", T0);
      expect(collectStats(db, 0).sample.activeHours).toBe(1);
    });
  });
});

describe("spanText / sizeText", () => {
  test("a span under an hour reads in minutes, above it in hours", () => {
    expect(spanText(T0, T0 + 8 * 60_000)).toBe("8m");
    expect(spanText(T0, T0 + 2 * HOUR)).toBe("2.0h");
    expect(spanText(T0, T0 + 36.9 * HOUR)).toBe("36.9h");
  });

  test("a backwards span clamps to zero rather than going negative", () => {
    // Clocks skew between a hook and a CLI run, and "lived -3m" is worse than
    // an understated zero.
    expect(spanText(T0 + 1000, T0)).toBe("0m");
  });

  test("sizes scale through KB to MB", () => {
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(680 * 1024)).toBe("680.0 KB");
    expect(sizeText(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("collectStats", () => {
  test("one pass returns every section, and they agree with each other", () => {
    fresh((db) => {
      edit(db, "ada", T0);
      edit(db, "bo", T0 + 1000, "src/b.ts");
      message(db, { handle: "ada", kind: "say", toName: "bo" });
      const s = collectStats(db, 3);
      // The row count and the per-agent tally are two different queries over
      // the same table; if they disagree, one of them has a filter the other
      // does not, and the report contradicts itself.
      const edits = s.tables.find((t) => t.table === "edits")?.rows ?? 0;
      expect(edits).toBe(s.activity.reduce((sum, a) => sum + a.edits, 0));
      expect(s.agents.edits).toBe(s.activity.length);
      expect(s.concurrency.peak).toBe(2);
      expect(s.messages.directedSays).toBe(1);
      expect(s.features.find((f) => f.feature === "personal memories")?.rows).toBe(3);
    });
  });

  test("the store exposes the same numbers through its own handle", () => {
    const path = `${tmpdir().replace(/\\/g, "/")}/presence-stats-${process.pid}-${n++}.db`;
    paths.push(path);
    withStore(path, (store) => {
      const s = store.stats(0);
      // Reached through `Store` rather than a loose `Database`, because that is
      // how cli.ts reaches it — a getter that compiled but did not run would
      // pass every test above.
      expect(s.tables.length).toBeGreaterThan(0);
      expect(s.features.length).toBeGreaterThan(0);
      expect(s.concurrency.activeHours).toBe(0);
    });
  });
});
