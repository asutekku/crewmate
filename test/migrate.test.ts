/**
 * Opening a database that was created by an OLDER build.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS SEPARATE. Every other test here starts
 * from `withStore` on a fresh path, so the schema is created complete and every
 * migration is a no-op. That makes the whole suite structurally blind to the
 * one failure migrations have: an ordering mistake between `CREATE TABLE IF NOT
 * EXISTS` and `addColumnIfMissing`.
 *
 * The bug this was written for: an index over `injection_ledger.delivery_id`
 * sat with the CREATEs, above the migration that adds that column. On a fresh
 * db the column exists and it passes; on a db from the previous build the
 * CREATE is a no-op, the index throws `no such column: delivery_id`, and it
 * throws BEFORE the migration that would have fixed it — so the store could
 * never open that database again. Reproduced 2026-08-02, and invisible to 748
 * passing tests.
 *
 * Each case here builds the OLD shape by hand, opens it through the real
 * `withStore`, and asserts both that it opens and that the new column works.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";

let n = 0;
const paths: string[] = [];

/** A path for a db this test builds itself, never via `withStore`. */
function oldDbPath(): string {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-migrate-${process.pid}-${n++}.db`;
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {
        // Already gone, or never created.
      }
    }
  }
});

describe("a database from the previous build still opens", () => {
  test("injection_ledger without delivery_id migrates and indexes", () => {
    const path = oldDbPath();
    const old = new Database(path);
    // Exactly the shape shipped before `delivery_id` existed.
    old.query(
      `CREATE TABLE injection_ledger (
         session_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, key TEXT NOT NULL,
         dedupe_key TEXT NOT NULL, state_ver TEXT NOT NULL, outcome TEXT NOT NULL,
         form TEXT NOT NULL, reason TEXT NOT NULL, priority INTEGER NOT NULL,
         chars INTEGER NOT NULL)`,
    ).run();
    old.query(
      `INSERT INTO injection_ledger VALUES ('s1', 1000, 'roster', 'roster', 'v1',
        'selected', 'full', '', 90, 76)`,
    ).run();
    old.close();

    // The whole assertion: this must not throw.
    const history = withStore(path, (store) => store.injectionHistory("s1"));
    expect(history).toHaveLength(1);
    // The pre-migration row reads as delivery 0 — a real value, distinguishable
    // from anything the new code allocates, which starts at 1.
    expect(history[0]?.deliveryId).toBe(0);
    expect(history[0]?.key).toBe("roster");
  });

  test("a new delivery into a migrated table gets a real id", () => {
    const path = oldDbPath();
    const old = new Database(path);
    old.query(
      `CREATE TABLE injection_ledger (
         session_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, key TEXT NOT NULL,
         dedupe_key TEXT NOT NULL, state_ver TEXT NOT NULL, outcome TEXT NOT NULL,
         form TEXT NOT NULL, reason TEXT NOT NULL, priority INTEGER NOT NULL,
         chars INTEGER NOT NULL)`,
    ).run();
    old.close();

    withStore(path, (store) => {
      store.recordInjectionResult("s1", {
        shown: [
          {
            key: "roster",
            dedupeKey: "roster",
            stateVersion: "v1",
            form: "full",
            priority: 90,
            chars: 76,
          },
        ],
        omitted: [],
        nowMs: 2000,
      });
      expect(store.injectionHistory("s1")[0]?.deliveryId).toBeGreaterThan(0);
    });
  });

  test("injection_omissions without state_ver migrates", () => {
    const path = oldDbPath();
    const old = new Database(path);
    old.query(
      `CREATE TABLE injection_omissions (
         session_id TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL,
         reason TEXT NOT NULL, ts_ms INTEGER NOT NULL,
         PRIMARY KEY (session_id, key))`,
    ).run();
    old.query(
      `INSERT INTO injection_omissions VALUES ('s1', 'ob', 'the text', 'no room', 1000)`,
    ).run();
    old.close();

    const owed = withStore(path, (store) => store.injectionOmissions("s1"));
    expect(owed).toHaveLength(1);
    // Empty means "recorded before versions were kept", which a reader must be
    // able to tell apart from a real fingerprint.
    expect(owed[0]?.stateVersion).toBe("");
    expect(owed[0]?.text).toBe("the text");
  });

  test("a db with NO injection tables at all is created clean", () => {
    // The oldest case: a store from before any of this existed. An unrelated
    // table is enough to make the file pre-exist without hand-rolling the whole
    // real schema — writing a partial `sessions` here would only test this
    // file's ability to reproduce it, and fails on an index it omitted.
    const path = oldDbPath();
    const old = new Database(path);
    old.query(`CREATE TABLE unrelated (id INTEGER PRIMARY KEY)`).run();
    old.close();

    withStore(path, (store) => {
      expect(store.injectionHistory("s1")).toHaveLength(0);
      expect(store.injectionOmissions("s1")).toHaveLength(0);
      expect(store.injectionExposures("s1").size).toBe(0);
    });
  });

  test("a pre-P2 database gains every P2 table additively and reopening is a no-op", () => {
    const path = oldDbPath();
    const old = new Database(path);
    old.query(`CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`).run();
    old.query(`INSERT INTO legacy_marker VALUES (1, 'preserve me')`).run();
    old.close();
    const expected = ["message_acts","semantic_batches","obligations","obligation_events","obligation_dependencies","clearances","clearance_events","hazard_notices","message_deliveries"];
    for (let pass = 0; pass < 2; pass++) withStore(path, () => {});
    const migrated = new Database(path, { readonly: true });
    const names = new Set((migrated.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{name:string}>).map(x=>x.name));
    for (const name of expected) expect(names.has(name)).toBe(true);
    expect((migrated.query(`SELECT value FROM legacy_marker WHERE id=1`).get() as {value:string}).value).toBe("preserve me");
    migrated.close();
  });

  test("opening TWICE is idempotent", () => {
    // Migrations run on every open, so a second pass must not throw on the
    // column it added the first time.
    const path = oldDbPath();
    const old = new Database(path);
    old.query(
      `CREATE TABLE injection_ledger (
         session_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, key TEXT NOT NULL,
         dedupe_key TEXT NOT NULL, state_ver TEXT NOT NULL, outcome TEXT NOT NULL,
         form TEXT NOT NULL, reason TEXT NOT NULL, priority INTEGER NOT NULL,
         chars INTEGER NOT NULL)`,
    ).run();
    old.close();

    withStore(path, () => undefined);
    expect(() => withStore(path, () => undefined)).not.toThrow();
  });
});
