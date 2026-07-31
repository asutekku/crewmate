/**
 * Delivery and identity guarantees, against a real (throwaway) SQLite db.
 *
 * This file exists because an audit found the store — the riskiest code in the
 * tool — had no committed coverage at all, and then found two defects in it
 * that a ten-line test would have caught. Every case below is a bug that
 * actually shipped.
 */

import { unlinkSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";

import { STALE_MS, withStore } from "./store.ts";

let n = 0;
const paths: string[] = [];

/** A fresh db per test: shared state is what these tests are about. */
function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${import.meta.dir}/.test-store-${process.pid}-${n++}.db`;
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

describe("delivery", () => {
  test("a broadcast interleaved before a directed message is not lost", () => {
    // A single monotonic cursor cannot say "delivered 7 but not 6", so a Stop
    // drain that skips a broadcast and then advances past it buries that row
    // forever. Broadcasts are the stay-off-this-file traffic the tool exists
    // to carry, so losing them defeats the point.
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.register("peer", "/t", "main", now);
      const peer = store.findBySession("peer")!;

      store.post(peer.handle, "say", "waterSim.ts is mine", now);
      store.post(peer.handle, "say", "review this?", now, { sessionId: "me", name: "me" });

      const atStop = store.drainDirected("me").map((m) => m.body);
      const atPrompt = store.drainUnread("me").map((m) => m.body);
      expect(atStop).toEqual(["review this?"]);
      expect(atPrompt).toContain("waterSim.ts is mine");
    });
  });

  test("Stop delivers directed messages and human notes, never peer chatter", () => {
    // Injecting at Stop CONTINUES the turn, so routine chatter delivered there
    // would let agents extend each other's turns to the continuation cap.
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.register("peer", "/t", "main", now);
      const peer = store.findBySession("peer")!;

      store.post(peer.handle, "done", "reached a stopping point", now);
      store.post("human", "note", "everyone commit please", now);
      store.post(peer.handle, "say", "to you only", now, { sessionId: "me", name: "me" });

      const bodies = store.drainDirected("me").map((m) => m.body);
      expect(bodies).toContain("to you only");
      expect(bodies).toContain("everyone commit please");
      expect(bodies).not.toContain("reached a stopping point");
    });
  });

  test("a directed message reaches only its recipient", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.register("other", "/t", "main", now);
      store.register("peer", "/t", "main", now);
      const peer = store.findBySession("peer")!;
      store.post(peer.handle, "say", "for me alone", now, { sessionId: "me", name: "me" });

      expect(store.drainUnread("me").map((m) => m.body)).toContain("for me alone");
      expect(store.drainUnread("other").map((m) => m.body)).not.toContain("for me alone");
    });
  });

  test("a session is never shown its own messages", () => {
    fresh((store) => {
      const now = Date.now();
      const handle = store.register("me", "/t", "main", now);
      store.post(handle, "say", "my own broadcast", now);
      expect(store.drainUnread("me")).toEqual([]);
    });
  });

  test("a drained message is not delivered twice", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.register("peer", "/t", "main", now);
      store.post(store.findBySession("peer")!.handle, "say", "once", now);
      expect(store.drainUnread("me")).toHaveLength(1);
      expect(store.drainUnread("me")).toHaveLength(0);
    });
  });

  test("a new session starts with its cursor at the end, not the beginning", () => {
    // Otherwise every session replays the whole log on its first turn.
    fresh((store) => {
      const now = Date.now();
      store.register("peer", "/t", "main", now);
      store.post(store.findBySession("peer")!.handle, "say", "ancient history", now);
      store.register("newcomer", "/t", "main", now);
      expect(store.drainUnread("newcomer")).toEqual([]);
    });
  });
});

describe("identity", () => {
  test("a reaped but living session comes back rather than going dark", () => {
    // pruneStale is a heuristic for terminals closed without exiting. It
    // misfires on an idle session and on a long turn that runs no Edit/Write —
    // and before this, nothing re-registered, so such a session recorded no
    // claims and raised NO OVERLAP WARNINGS for the rest of its life.
    fresh((store) => {
      const now = Date.now();
      store.register("long", "/t", "main", now - STALE_MS - 60_000);
      store.pruneStale(now);
      expect(store.handleFor("long")).toBeNull();

      const handle = store.handleForOrRegister("long", "/t", "main", now);
      expect(handle).not.toBe("");

      store.register("peer", "/t", "main", now);
      store.claim("peer", "src/x.ts", now);
      expect(store.conflictingClaims("long", "src/x.ts", now)).toHaveLength(1);
    });
  });

  test("handles are unique across simultaneous registrations", () => {
    // Four terminals launched at once each read the roster before any inserts,
    // and all four picked the same "first free" name.
    fresh((store) => {
      const now = Date.now();
      const handles = new Set<string>();
      for (let i = 0; i < 8; i++) handles.add(store.register(`s${i}`, "/t", "main", now));
      expect(handles.size).toBe(8);
    });
  });

  test("a resumed session keeps its handle so peer references stay valid", () => {
    fresh((store) => {
      const now = Date.now();
      const first = store.register("me", "/t", "main", now);
      expect(store.register("me", "/t2", "other", now + 1000)).toBe(first);
    });
  });

  test("display names are frozen at send time so the log survives the sender", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.register("peer", "/t", "main", now);
      const peer = store.findBySession("peer")!;
      store.syncAgents([{ sessionId: "peer", name: "traffic-99", status: "busy" }]);
      store.post(peer.handle, "say", "hello", now, { sessionId: "me", name: "me" });
      store.unregister("peer");
      expect(store.recent(10)[0]?.from).toBe("traffic-99");
    });
  });
});

describe("claims", () => {
  test("a session's own claim is never a conflict with itself", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.claim("me", "src/x.ts", now);
      expect(store.conflictingClaims("me", "src/x.ts", now)).toEqual([]);
    });
  });

  test("claims carry the session name, not just the internal handle", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.syncAgents([{ sessionId: "me", name: "traffic-07", status: "busy" }]);
      store.claim("me", "src/x.ts", now);
      expect(store.allClaims(now)[0]?.name).toBe("traffic-07");
    });
  });

  test("a dead session's claims stop being reported", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("ghost", "/t", "main", now - STALE_MS - 1000);
      store.claim("ghost", "src/x.ts", now - STALE_MS - 1000);
      store.pruneStale(now);
      expect(store.allClaims(now)).toEqual([]);
    });
  });
});
