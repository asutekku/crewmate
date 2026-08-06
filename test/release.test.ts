/**
 * `crew release` — an agent gives up its name while still alive.
 *
 * WRITTEN AGAINST plans/RELEASE_PLAN.md, before the verb existed. The defect it
 * closes was measured twice on 2026-08-05/06: `HANDOVER.md` opened with
 * `crew call-me hopper`, and that instruction was unrunnable. A live session
 * cannot release its own name from the inside, because the reads it does to
 * VERIFY the release re-register it — `quit` deletes the roster row and writes
 * the departing name into `aliases`, then the next `register` finds the ledger
 * row intact and takes the name straight back.
 *
 * The three writes below are one transaction for that reason: dropping the
 * ledger row without the alias row leaves `restoreAlias` to hand the name back
 * on the next heartbeat, which is the exact bug the verb exists to fix.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { GIVEN_NAMES } from "../core/names.ts";

let n = 0;
const paths: string[] = [];

const OUTGOING = "aaaaaaaa-0000-0000-0000-000000000000";
const SUCCESSOR = "bbbbbbbb-0000-0000-0000-000000000000";

function dbPath(): string {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-rel-${process.pid}-${n++}.db`;
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
      } catch {
        // Already gone, or never created.
      }
    }
  }
});

/** Registers a session and renames it, which is how an agent takes a name. */
function named(
  store: Parameters<Parameters<typeof withStore>[1]>[0],
  sessionId: string,
  name: string,
  nowMs: number,
): void {
  store.registerAndRestore(sessionId, "/tree", "main", nowMs);
  store.setAlias(sessionId, name, nowMs);
}

describe("releaseName — the three writes", () => {
  test("the released name is takeable by a live peer in the same tick", () => {
    // THE POINT OF THE VERB. Previously this needed a third party running
    // `quit` and racing the outgoing session's next heartbeat.
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);
      store.registerAndRestore(SUCCESSOR, "/tree", "main", now);

      expect(store.releaseName(OUTGOING, now)).not.toBeNull();
      expect(store.setAlias(SUCCESSOR, "hopper", now)).toBe("hopper");
    });
  });

  test("the releasing session does NOT get the name back on re-register", () => {
    // The regression the verb exists to prevent. `register` reads the ledger,
    // and `restoreAlias` reads `aliases`; both must have been cleared.
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);
      store.releaseName(OUTGOING, now);

      store.registerAndRestore(OUTGOING, "/tree", "main", now + 60_000);
      const back = store.owners.nameFor(OUTGOING);
      expect(back).not.toBe("hopper");
    });
  });

  test("the releasing session's own heartbeat does not take the name back", () => {
    /**
     * THE BUG THIS VERB EXISTS TO FIX, reproduced end to end.
     *
     * The state checks above all pass with the `aliases` delete removed, so
     * they do not pin it. `restoreAlias` fires when the session's alias is
     * empty -- which `rename` makes true -- and reads whatever `aliases` still
     * holds. With the row left behind, the outgoing session's very next
     * heartbeat restores `hopper` to itself.
     *
     * NO SUCCESSOR HERE, deliberately. A successor that already holds the name
     * is protected by `restoreAlias`'s own `held` guard, which masks the defect;
     * the realistic handover has the successor starting AFTER the release, and
     * that window is exactly when the name must stay gone.
     *
     * Mutation-tested 2026-08-06: dropping the `aliases` delete turns this red
     * and every other test in this file green.
     */
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);
      const fresh = store.releaseName(OUTGOING, now);

      store.registerAndRestore(OUTGOING, "/tree", "main", now + 2000);

      const after = store.findBySession(OUTGOING);
      expect(after?.alias).not.toBe("hopper");
      expect(after?.handle).toBe(fresh as string);
      expect(store.owners.nameFor(OUTGOING)).not.toBe("hopper");
    });
  });

  test("the releasing session keeps a working, distinct name", () => {
    // It is still alive and still needs to be addressable, or `msg` cannot
    // reach it and the roster shows an agent with no name.
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);

      const fresh = store.releaseName(OUTGOING, now);
      expect(fresh).not.toBeNull();
      expect(fresh).not.toBe("hopper");
      expect(GIVEN_NAMES as readonly string[]).toContain(fresh as string);
      expect(store.owners.nameFor(OUTGOING)).toBe(fresh as string);
    });
  });

  test("the roster still lists the releasing agent, under the new name", () => {
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);
      const fresh = store.releaseName(OUTGOING, now);

      const live = store.liveSessions(now);
      const names = live.flatMap((p) => [p.handle.toLowerCase(), p.alias.toLowerCase()]);
      expect(live.map((p) => p.sessionId)).toContain(OUTGOING);
      expect(names).toContain((fresh as string).toLowerCase());
      expect(names).not.toContain("hopper");
    });
  });

  test("the ledger no longer holds the released name for anyone", () => {
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);
      store.releaseName(OUTGOING, now);
      expect(store.owners.all().map((o) => o.name)).not.toContain("hopper");
    });
  });
});

describe("releaseName — refusals, which must not throw", () => {
  test("a session that never registered fails cleanly", () => {
    withStore(dbPath(), (store) => {
      expect(store.releaseName("cccccccc-0000-0000-0000-000000000000", 1000)).toBeNull();
    });
  });

  test("releasing twice is not an error the second time, it is a no-op", () => {
    // An agent that retries after a dropped connection must not be punished,
    // and must not lose its second name to a partial write.
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);
      const first = store.releaseName(OUTGOING, now);
      const second = store.releaseName(OUTGOING, now);
      expect(first).not.toBeNull();
      // Whatever the second call returns, the agent still has exactly one name
      // and it is not the released one.
      expect(store.owners.nameFor(OUTGOING)).not.toBe("hopper");
      expect(second === null || second !== "hopper").toBe(true);
    });
  });
});

describe("releaseName — blast radius", () => {
  test("another conversation's ledger row is untouched", () => {
    // The `akari` guard: a name belongs to a conversation for as long as that
    // conversation exists, and one agent releasing must not disturb another.
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);
      named(store, SUCCESSOR, "vega", now);

      store.releaseName(OUTGOING, now);
      expect(store.owners.nameFor(SUCCESSOR)).toBe("vega");
    });
  });

  test("a released name does not collide with a live peer's name", () => {
    // The fresh name comes from the pool minus everything taken, so it must
    // never land on a name another live agent is answering to.
    withStore(dbPath(), (store) => {
      const now = 1000;
      named(store, OUTGOING, "hopper", now);
      named(store, SUCCESSOR, "vega", now);

      const fresh = store.releaseName(OUTGOING, now);
      expect(fresh).not.toBe("vega");
    });
  });
});
