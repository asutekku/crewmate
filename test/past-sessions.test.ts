/**
 * WHAT A SESSION LEAVES BEHIND. The roster row is gone by the time an operator
 * comes looking -- a clean exit deletes it, the stale sweep reaps it -- so
 * everything here is about the archive surviving that, WITHOUT holding a name
 * the pool needs back.
 */

import { mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    // WAL leaves two sidecars beside the db; all three have to go.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(path + suffix);
      } catch {
        /* already gone */
      }
    }
  }
});

function dbPath(): string {
  const dir = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/past-`);
  const path = `${dir}/presence.db`;
  paths.push(path);
  return path;
}

const NOW = 1_700_000_000_000;

describe("past sessions", () => {
  test("a clean exit archives the session it removes", () => {
    const path = dbPath();
    withStore(path, (store) => {
      store.register("conv-a", "/repo", "main", NOW);
      store.sessions.setTitle("conv-a", "Implement battlepass rewards");
      store.unregister("conv-a", NOW + 1000);

      expect(store.findBySession("conv-a")).toBeNull();
      const past = store.past.find("conv-a");
      expect(past?.title).toBe("Implement battlepass rewards");
      expect(past?.endedMs).toBe(NOW + 1000);
    });
  });

  test("the stale sweep archives a session that never said goodbye", () => {
    const path = dbPath();
    withStore(path, (store) => {
      // THE CRASH: a killed terminal runs no SessionEnd hook, so the sweep is
      // the only thing that will ever archive this row.
      store.register("conv-crash", "/repo", "main", NOW);
      store.sessions.setTitle("conv-crash", "Battlepass tier table");
      const muchLater = NOW + 90 * 24 * 60 * 60 * 1000;
      store.pruneStale(muchLater);

      expect(store.findBySession("conv-crash")).toBeNull();
      expect(store.past.find("conv-crash")?.title).toBe("Battlepass tier table");
    });
  });

  test("archiving does not hold the name against the pool", () => {
    const path = dbPath();
    withStore(path, (store) => {
      const first = store.register("conv-1", "/repo", "main", NOW);
      store.unregister("conv-1", NOW + 1);
      // The ledger frees the name only when the transcript leaves disk, and no
      // transcript directory is configured here -- so this asserts the ARCHIVE
      // itself adds no obstacle: a second holder of one name must be storable.
      store.past.archive("conv-1", NOW + 2);
      expect(store.past.find("conv-1")?.handle).toBe(first);
    });
  });

  test("two conversations that held one name both survive in the archive", () => {
    const path = dbPath();
    withStore(path, (store) => {
      // `sessions` carries a UNIQUE index on handle. The archive must NOT, or
      // the second holder is rejected and its conversation becomes unfindable.
      store.register("conv-old", "/repo", "main", NOW);
      const name = store.findBySession("conv-old")?.handle ?? "";
      store.unregister("conv-old", NOW + 1);

      store.register("conv-new", "/repo", "main", NOW + 2);
      store.sessions.setAlias("conv-new", name, NOW + 2);
      store.unregister("conv-new", NOW + 3);

      expect(store.past.find("conv-old")).not.toBeNull();
      expect(store.past.find("conv-new")).not.toBeNull();
    });
  });

  test("a resumed conversation archives again, keeping the later record", () => {
    const path = dbPath();
    withStore(path, (store) => {
      store.register("conv-r", "/repo", "main", NOW);
      store.sessions.setTitle("conv-r", "First pass");
      store.unregister("conv-r", NOW + 10);

      store.register("conv-r", "/repo", "feature", NOW + 20);
      store.sessions.setTitle("conv-r", "Second pass");
      store.unregister("conv-r", NOW + 30);

      const past = store.past.find("conv-r");
      expect(past?.title).toBe("Second pass");
      expect(past?.endedMs).toBe(NOW + 30);
    });
  });

  test("archiving an unknown session writes nothing and does not throw", () => {
    const path = dbPath();
    withStore(path, (store) => {
      store.past.archive("never-existed", NOW);
      expect(store.past.find("never-existed")).toBeNull();
      expect(store.past.all()).toHaveLength(0);
    });
  });
});
