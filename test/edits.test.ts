/**
 * Edit history: who touched what, and why it is a different table from claims.
 *
 * `claims` is live state and is DELETED with its session. That is right for an
 * overlap warning ("who is in this file NOW") and useless for the question this
 * answers ("who was in it"), which is asked precisely when a session has gone.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { DEFAULTS, loadConfig } from "../core/config.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-edits-${process.pid}-${n++}.db`;
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

const MAIN = "I:/Projects/Traffic";
const WT = "I:/Projects/Traffic/.claude/worktrees/water";

describe("history survives what live state does not", () => {
  test("an edit outlives the session that made it", () => {
    // THE WHOLE REASON THIS TABLE EXISTS. Measured live: an agent ended its
    // session mid-conversation and its six claims vanished with it, leaving no
    // record it had ever been in src/gen/terrain.ts.
    fresh((store) => {
      const now = Date.now();
      store.register("s1", MAIN, "master", now);
      store.claim("s1", "src/gen/terrain.ts", now, { tool: "Edit", worktree: MAIN });

      store.unregister("s1");
      expect(store.allClaims(now)).toHaveLength(0);
      expect(store.editsBy("s1", 0)).toHaveLength(1);
      expect(store.editsOf("src/gen/terrain.ts")).toHaveLength(1);
    });
  });

  test("the agent's name is frozen, so history still names its author", () => {
    // Resolving the name at READ time would blank out every row the moment that
    // session exits — which is exactly when blame gets asked.
    fresh((store) => {
      const now = Date.now();
      store.register("s1", MAIN, "master", now);
      store.setAlias("s1", "terrain-perf", now);
      store.claim("s1", "src/gen/terrain.ts", now, { tool: "Edit", worktree: MAIN });
      store.unregister("s1");
      expect(store.editsOf("src/gen/terrain.ts")[0]?.agent).toBe("terrain-perf");
    });
  });

  test("a stale sweep takes the session but not its history", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("s1", MAIN, "master", now - 10 * 60 * 60 * 1000);
      store.claim("s1", "src/a.ts", now - 10 * 60 * 60 * 1000, { worktree: MAIN });
      store.pruneStale(now);
      expect(store.findBySession("s1")).toBeNull();
      expect(store.editsBy("s1", 0)).toHaveLength(1);
    });
  });
});

describe("editsBy — what else is this agent in", () => {
  test("lists every file, most recent first, deduplicated by path", () => {
    fresh((store) => {
      const now = Date.now();
      const min = 60_000;
      store.register("s1", MAIN, "master", now);
      store.claim("s1", "src/a.ts", now - 30 * min, { worktree: MAIN });
      store.claim("s1", "src/b.ts", now - 20 * min, { worktree: MAIN });
      store.claim("s1", "src/a.ts", now - 5 * min, { worktree: MAIN });

      const files = store.editsBy("s1", 0);
      // A file edited three times is ONE fact about what they are working on.
      expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
      expect(files[0]?.count).toBe(2);
      expect(files[0]?.tsMs).toBe(now - 5 * min);
    });
  });

  test("honours the time window", () => {
    fresh((store) => {
      const now = Date.now();
      const hour = 60 * 60 * 1000;
      store.register("s1", MAIN, "master", now);
      store.claim("s1", "old.ts", now - 30 * hour, { worktree: MAIN });
      store.claim("s1", "new.ts", now - 1 * hour, { worktree: MAIN });
      expect(store.editsBy("s1", now - 24 * hour).map((f) => f.path)).toEqual(["new.ts"]);
    });
  });

  test("one agent's edits are not another's", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("s1", MAIN, "master", now);
      store.register("s2", WT, "worktree-water", now);
      store.claim("s1", "src/a.ts", now, { worktree: MAIN });
      store.claim("s2", "src/b.ts", now, { worktree: WT });
      expect(store.editsBy("s1", 0).map((f) => f.path)).toEqual(["src/a.ts"]);
      expect(store.editsBy("s2", 0).map((f) => f.path)).toEqual(["src/b.ts"]);
    });
  });
});

describe("editsOf — blame", () => {
  test("orders by TIMESTAMP, not by insertion", () => {
    // Rows normally arrive in time order, so rowid and timestamp agree — until
    // they do not, and then blame reads as a jumble with no hint it is wrong.
    // Caught on a seeded fixture: 18m, 8m, 22m, 40m.
    fresh((store) => {
      const now = Date.now();
      const min = 60_000;
      store.register("s1", MAIN, "master", now);
      store.claim("s1", "shared.ts", now - 40 * min, { worktree: MAIN });
      store.claim("s1", "shared.ts", now - 8 * min, { worktree: MAIN });
      store.claim("s1", "shared.ts", now - 22 * min, { worktree: MAIN });
      const ages = store.editsOf("shared.ts").map((e) => now - e.tsMs);
      expect(ages).toEqual([8 * min, 22 * min, 40 * min]);
    });
  });

  test("shows two agents interleaved on one file, with their worktrees", () => {
    // The cross-worktree case: git records both as the same author, so this is
    // the only place the two are distinguishable.
    fresh((store) => {
      const now = Date.now();
      const min = 60_000;
      store.register("s1", MAIN, "master", now);
      store.setAlias("s1", "terrain-perf", now);
      store.register("s2", WT, "worktree-water", now);
      store.setAlias("s2", "water-dynamic", now);
      store.claim("s1", "shared.ts", now - 30 * min, { worktree: MAIN });
      store.claim("s2", "shared.ts", now - 20 * min, { worktree: WT });
      store.claim("s1", "shared.ts", now - 10 * min, { worktree: MAIN });

      const rows = store.editsOf("shared.ts");
      expect(rows.map((r) => r.agent)).toEqual(["terrain-perf", "water-dynamic", "terrain-perf"]);
      expect(rows[1]?.worktree).toBe(WT);
    });
  });

  test("records the tool, because a Write is not an Edit", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("s1", MAIN, "master", now);
      store.claim("s1", "a.ts", now, { tool: "Write", worktree: MAIN });
      expect(store.editsOf("a.ts")[0]?.tool).toBe("Write");
    });
  });

  test("an untouched path reports nothing rather than guessing", () => {
    fresh((store) => {
      expect(store.editsOf("never/edited.ts")).toEqual([]);
    });
  });
});

describe("editAgents", () => {
  test("finds an agent that has exited, by the name it had", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("s1", MAIN, "master", now);
      store.setAlias("s1", "terrain-perf", now);
      store.claim("s1", "a.ts", now, { worktree: MAIN });
      store.unregister("s1");
      const seen = store.editAgents(0);
      expect(seen.map((a) => a.agent)).toContain("terrain-perf");
      expect(seen.find((a) => a.agent === "terrain-perf")?.sessionId).toBe("s1");
    });
  });
});

describe("config", () => {
  test("defaults apply when no file exists", () => {
    // The file is optional and always has been: this is read on hook paths, so
    // a missing or malformed config must degrade rather than take an edit with it.
    const cfg = loadConfig();
    expect(cfg.editKeepMs).toBeGreaterThan(0);
    expect(cfg.staleMs).toBeGreaterThan(0);
  });

  test("edit history is kept longer than anything else", () => {
    // It is the only table answering a question about the PAST; a horizon
    // shorter than the work board's would make blame the first thing to expire.
    expect(DEFAULTS.editKeepMs).toBeGreaterThan(DEFAULTS.workKeepMs);
    expect(DEFAULTS.editKeepMs).toBeGreaterThan(DEFAULTS.staleMs);
    expect(DEFAULTS.editKeepMs).toBeGreaterThan(DEFAULTS.claimTtlMs);
  });
});
