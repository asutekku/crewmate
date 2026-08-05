/**
 * The guarantees the store split fixed, pinned so they cannot silently regress.
 *
 * WHY THIS FILE EXISTS. `plans/store-refactor.md` found ten correctness bugs and
 * they were all fixed in the same pass that split `core/store.ts` into
 * `core/store/`. Two of them — the alias hijack and the `MAX()` metadata pairing
 * — were fixed with NO test behind them, and it showed: disabling the hijack
 * guard on 2026-08-05 left all 1002 tests passing. A fix nothing pins is a fix
 * with a half-life.
 *
 * These are deliberately not in `store.test.ts`. That file opens ONE connection
 * per case (`fresh`), which is the right default and is exactly what cannot
 * express "two processes race". Several cases here need two live connections to
 * the same file, so the harness differs and the file does too.
 *
 * WHAT A TEST HERE CAN AND CANNOT SHOW. `.immediate()` takes SQLite's write lock
 * at BEGIN instead of at first write, which is what closes the read-then-write
 * window between two processes. A single-process test cannot interleave two
 * transactions at the statement level, so these do not prove the lock timing;
 * they prove the OUTCOME the lock exists to protect — one winner, no hijack, no
 * torn multi-table write — and they fail loudly if the guarding logic is
 * removed. The timing itself is the reason to keep `.immediate()`, and is
 * asserted structurally at the end.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { displayName, STALE_MS, withStore } from "../core/store.ts";

let n = 0;
const paths: string[] = [];

/** A db path this file opens more than once, so it cannot use `withStore`'s. */
function dbPath(): string {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-race-${process.pid}-${n++}.db`;
  paths.push(path);
  return path;
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

const NOW = 1_000_000;

describe("a name has one owner, even when two sessions want it", () => {
  test("a live session's HANDLE cannot be taken as another's alias", () => {
    // THE BUG THIS PINS. The collision query checked `alias` but not `handle`,
    // so an agent could set its alias to a peer's handle. `findByName` prefers
    // aliases, so the hijacker would then receive messages addressed to the
    // peer — silent message interception, not a cosmetic clash.
    const path = dbPath();
    withStore(path, (store) => {
      const victim = store.register("victim", "/tree", "master", NOW);
      const attacker = store.register("attacker", "/tree", "master", NOW);
      expect(victim).not.toBe(attacker);

      expect(store.setAlias("attacker", victim, NOW)).toBeNull();

      // And the routing that made it worth stealing still resolves to the owner.
      expect(store.findByName(victim, NOW)?.sessionId).toBe("victim");
    });
  });

  test("two sessions racing the same alias produce exactly one winner", () => {
    const path = dbPath();
    withStore(path, (first) => {
      first.register("a", "/tree", "master", NOW);
      first.register("b", "/tree", "master", NOW);
      withStore(path, (second) => {
        const won = first.setAlias("a", "tooling", NOW);
        const lost = second.setAlias("b", "tooling", NOW);
        expect(won).toBe("tooling");
        expect(lost).toBeNull();
      });
      expect(first.findByName("tooling", NOW)?.sessionId).toBe("a");
    });
  });

  test("case is not a loophole", () => {
    const path = dbPath();
    withStore(path, (store) => {
      store.register("a", "/tree", "master", NOW);
      store.register("b", "/tree", "master", NOW);
      expect(store.setAlias("a", "Tooling", NOW)).toBe("Tooling");
      expect(store.setAlias("b", "tOOLING", NOW)).toBeNull();
    });
  });

  test("a STALE session's name is released rather than held forever", () => {
    // The collision query is scoped to live sessions on purpose: names would
    // otherwise be exhausted by every session that ever ran.
    const path = dbPath();
    withStore(path, (store) => {
      const old = store.register("gone", "/tree", "master", NOW - STALE_MS * 2);
      store.register("new", "/tree", "master", NOW);
      expect(store.setAlias("new", old, NOW)).toBe(old);
    });
  });

  test("restoring an alias cannot steal one taken while the session was away", () => {
    const path = dbPath();
    withStore(path, (store) => {
      store.register("returner", "/tree", "master", NOW);
      expect(store.setAlias("returner", "keeper", NOW)).toBe("keeper");
      store.unregister("returner", NOW);

      store.register("squatter", "/tree", "master", NOW);
      expect(store.setAlias("squatter", "keeper", NOW)).toBe("keeper");

      // The original comes back and must NOT get its name back off the squatter.
      store.register("returner", "/tree", "master", NOW);
      expect(store.restoreAlias("returner", NOW)).toBeNull();
      expect(store.findByName("keeper", NOW)?.sessionId).toBe("squatter");
    });
  });
});

describe("an aggregate reports metadata from the row it aggregated", () => {
  test("the newest timestamp is paired with the NEWEST tool and worktree", () => {
    // THE BUG THIS PINS. `SELECT path, MAX(ts_ms), worktree, tool ... GROUP BY
    // path` lets SQLite take `worktree`/`tool` from any row in the group, so the
    // latest timestamp could be reported beside an older edit's tool. Rewritten
    // with ROW_NUMBER() OVER (PARTITION BY path ORDER BY ts_ms DESC, id DESC).
    const path = dbPath();
    withStore(path, (store) => {
      store.register("s", "/tree", "master", NOW);
      store.claim("s", "src/a.ts", NOW, { tool: "Write", worktree: "/old" });
      store.claim("s", "src/a.ts", NOW + 50, { tool: "Edit", worktree: "/new" });

      const [row] = store.editsBy("s", 0, 10);
      expect(row?.tsMs).toBe(NOW + 50);
      expect(row?.tool).toBe("Edit");
      expect(row?.worktree).toBe("/new");
      expect(row?.count).toBe(2);
    });
  });

  test("ties break on insertion order, so the pairing is still deterministic", () => {
    // Same millisecond is the case a plain MAX() is most free to get wrong.
    const path = dbPath();
    withStore(path, (store) => {
      store.register("s", "/tree", "master", NOW);
      store.claim("s", "src/a.ts", NOW, { tool: "first", worktree: "/one" });
      store.claim("s", "src/a.ts", NOW, { tool: "second", worktree: "/two" });

      const [row] = store.editsBy("s", 0, 10);
      expect(row?.tool).toBe("second");
      expect(row?.worktree).toBe("/two");
    });
  });

  test("each path keeps its OWN metadata when several are summarised", () => {
    const path = dbPath();
    withStore(path, (store) => {
      store.register("s", "/tree", "master", NOW);
      store.claim("s", "src/a.ts", NOW + 10, { tool: "Edit" });
      store.claim("s", "src/b.ts", NOW + 20, { tool: "Write" });

      const byPath = new Map(store.editsBy("s", 0, 10).map((e) => [e.path, e]));
      expect(byPath.get("src/a.ts")?.tool).toBe("Edit");
      expect(byPath.get("src/b.ts")?.tool).toBe("Write");
    });
  });
});

describe("a multi-table lifecycle change is all-or-nothing", () => {
  test("pruning takes a dead session's claims and tasks WITH the session", () => {
    // THE BUG THIS PINS. Three separate DELETEs meant a session could heartbeat
    // between them and keep its row while losing its claims. The set of dead
    // sessions is now resolved once, inside one immediate transaction.
    const path = dbPath();
    withStore(path, (store) => {
      store.register("dead", "/tree", "master", NOW - STALE_MS * 2);
      store.register("alive", "/tree", "master", NOW);
      store.claim("dead", "src/dead.ts", NOW - STALE_MS * 2, {});
      store.claim("alive", "src/alive.ts", NOW, {});

      store.pruneStale(NOW);

      expect(store.findBySession("dead")).toBeNull();
      expect(store.findBySession("alive")).not.toBeNull();
      const held = store.allClaims(NOW).map((c) => c.path);
      expect(held).toContain("src/alive.ts");
      expect(held).not.toContain("src/dead.ts");

      // AGAINST THE TABLE, not against `allClaims`. That view inner-joins
      // `sessions`, so an orphaned claim row vanishes from it whether or not it
      // was deleted — asserting through it passed happily with the claims
      // cleanup commented out. A leak this sweep exists to prevent has to be
      // read where it would actually accumulate.
      const rows = store.db
        .query(`SELECT path FROM claims`)
        .all() as Array<{ path: string }>;
      expect(rows.map((r) => r.path)).toEqual(["src/alive.ts"]);
    });
  });

  test("a second connection sees the whole sweep or none of it", () => {
    const path = dbPath();
    withStore(path, (first) => {
      first.register("dead", "/tree", "master", NOW - STALE_MS * 2);
      first.claim("dead", "src/x.ts", NOW - STALE_MS * 2, {});
      first.pruneStale(NOW);
      withStore(path, (second) => {
        expect(second.findBySession("dead")).toBeNull();
        expect(second.allClaims(NOW).map((c) => c.path)).not.toContain("src/x.ts");
      });
    });
  });
});

describe("a synchronous wrapper refuses an asynchronous callback", () => {
  test("an async callback throws instead of using a closed database", () => {
    // THE BUG THIS PINS. `withStore` closes the db in `finally`, which runs the
    // moment an async callback returns its PROMISE — so every await inside it
    // would touch a closed handle. Rejecting the shape is the only honest fix.
    const path = dbPath();
    expect(() => withStore(path, async () => 1)).toThrow(/synchronous/);
  });

  test("a thenable is refused too, not just a real promise", () => {
    const path = dbPath();
    expect(() =>
      withStore(path, () => ({ then: (r: (v: number) => void) => r(1) })),
    ).toThrow(/synchronous/);
  });

  test("ordinary synchronous values still pass through untouched", () => {
    const path = dbPath();
    expect(withStore(path, () => 42)).toBe(42);
    expect(withStore(path, () => null)).toBeNull();
    expect(withStore(path, () => ({ a: 1 }))).toEqual({ a: 1 });
  });
});

describe("an addressable name survives any whitespace", () => {
  // THE BUG THIS PINS. The collapse ran only when the string contained a literal
  // SPACE, so a tab or newline reached the roster intact and broke the one thing
  // a display name is for: being typed back at `msg`.
  test.each([
    ["a tab", "too\tling"],
    ["a newline", "too\nling"],
    ["a carriage return", "too\rling"],
    ["mixed runs", "too \t ling"],
  ])("%s collapses to a single dash", (_label, raw) => {
    const name = displayName({ alias: raw, name: "traffic-1", handle: "h" });
    expect(name).toBe("too-ling");
    expect(/\s/.test(name)).toBe(false);
  });

  test("surrounding whitespace is trimmed rather than dashed", () => {
    expect(displayName({ alias: "  tooling  ", name: "n", handle: "h" })).toBe("tooling");
  });
});

describe("the write lock is taken at BEGIN, not at first write", () => {
  test("every read-then-write transaction in the store is immediate()", () => {
    // A STRUCTURAL assertion, deliberately. The tests above prove the outcomes,
    // but a single process cannot interleave two transactions statement by
    // statement, so nothing above would notice `.immediate()` being downgraded
    // to a deferred `transaction()()` — which is precisely the regression that
    // reopens all of these windows between two real agent processes.
    //
    // Counted rather than named: this asserts the pattern did not quietly
    // disappear, without pinning a number that a legitimate new method breaks.
    const files = ["index", "sessions", "activity", "messages", "injection"];
    let immediate = 0;
    for (const file of files) {
      const src = readFileSync(new URL(`../core/store/${file}.ts`, import.meta.url), "utf8");
      immediate += src.split(".immediate()").length - 1;
      // A bare `transaction(...)()` call is the deferred form this replaced.
      expect(src).not.toMatch(/=\s*this\.db\.transaction\([\s\S]{0,400}?\}\)\(\);/);
    }
    expect(immediate).toBeGreaterThanOrEqual(14);
  });
});
