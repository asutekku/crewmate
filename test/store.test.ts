/**
 * Delivery and identity guarantees, against a real (throwaway) SQLite db.
 *
 * This file exists because an audit found the store — the riskiest code in the
 * tool — had no committed coverage at all, and then found two defects in it
 * that a ten-line test would have caught. Every case below is a bug that
 * actually shipped.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { displayName, STALE_MS, withStore } from "../core/store.ts";

let n = 0;
const paths: string[] = [];

/**
 * A fresh db per test: shared state is what these tests are about.
 *
 * Created under the OS temp dir, never beside the source. These run in a repo
 * several agents share, and a `-wal`/`-shm` pair left in the working tree shows
 * up in everyone's `git status` as untracked litter — briefly did, before this.
 */
function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-test-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    // WAL leaves two sidecars beside the db; all three have to go.
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

  test("Stop delivers anything ADDRESSED to this session, plus human notes", () => {
    // Injecting at Stop CONTINUES the turn, so broadcast chatter delivered there
    // would let agents extend each other's turns to the continuation cap. The
    // test is "addressed to me", not "is a say" — a directed `claim` (someone is
    // editing a file I hold) is exactly the news worth ending a turn for, and
    // filtering by kind kept it waiting for the next prompt.
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.register("peer", "/t", "main", now);
      const peer = store.findBySession("peer")!;
      const to = { sessionId: "me", name: "me" };

      store.post(peer.handle, "done", "reached a stopping point", now);
      store.post(peer.handle, "say", "broadcast to everyone", now);
      store.post("human", "note", "everyone commit please", now);
      store.post(peer.handle, "say", "to you only", now, to);
      store.post(peer.handle, "claim", "also editing src/x.ts (held by you)", now, to);

      const bodies = store.drainDirected("me").map((m) => m.body);
      expect(bodies).toContain("to you only");
      expect(bodies).toContain("also editing src/x.ts (held by you)");
      expect(bodies).toContain("everyone commit please");
      expect(bodies).not.toContain("reached a stopping point");
      expect(bodies).not.toContain("broadcast to everyone");
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
    // The subject here is FREEZING, not which name wins: resolving a sender at
    // read time would blank out every historical line once that session exits,
    // and the log's job is to still make sense afterwards.
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.register("peer", "/t", "main", now);
      const peer = store.findBySession("peer")!;
      const sender = displayName(peer);
      store.syncAgents([{ sessionId: "peer", name: "traffic-99", status: "busy" }]);
      store.post(peer.handle, "say", "hello", now, { sessionId: "me", name: "me" });
      store.unregister("peer");
      expect(store.recent(10)[0]?.from).toBe(sender);
      // And it is a real name, not an empty string standing in for a dead row.
      expect(sender).not.toBe("");
    });
  });
});

describe("summaries", () => {
  test("a session with no transcript is never queued for a summary", () => {
    // The worker reads the transcript; with no path there is nothing to read,
    // and queueing it would spawn an ~8 s model call that can only fail.
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      expect(store.staleSummarySessions(now, 60_000)).toEqual([]);
    });
  });

  test("a session whose summary is older than the TTL comes back due", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.setTranscript("me", "/tmp/t.jsonl");
      store.setSummary("me", "Optimizing the water sim", now - 3_600_000);
      const due = store.staleSummarySessions(now, 60_000);
      expect(due.map((d) => d.sessionId)).toEqual(["me"]);
      expect(due[0]?.path).toBe("/tmp/t.jsonl");
    });
  });

  test("a fresh summary is not regenerated, so repeated `who` costs nothing", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.setTranscript("me", "/tmp/t.jsonl");
      store.setSummary("me", "Optimizing the water sim", now);
      expect(store.staleSummarySessions(now, 60_000)).toEqual([]);
    });
  });

  test("an EMPTY summary still stamps the clock, so failure is not retried hotly", () => {
    // A transcript that cannot be summarised would otherwise look permanently
    // stale and spawn a model call on every roster read.
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.setTranscript("me", "/tmp/t.jsonl");
      store.setSummary("me", "", now);
      expect(store.staleSummarySessions(now, 60_000)).toEqual([]);
    });
  });

  test("a dead session is never queued, however stale its summary", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("ghost", "/t", "main", now - STALE_MS - 1000);
      store.setTranscript("ghost", "/tmp/t.jsonl");
      expect(store.staleSummarySessions(now, 60_000)).toEqual([]);
    });
  });

  test("title and summary survive a round trip through the store", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("me", "/t", "main", now);
      store.setTitle("me", "Explore cheap agent communication solutions");
      store.setSummary("me", "Wiring transcript titles into the roster", now);
      const s = store.findBySession("me");
      expect(s?.title).toBe("Explore cheap agent communication solutions");
      expect(s?.summary).toBe("Wiring transcript titles into the roster");
      // liveSessions is the roster's source and must agree with findBySession.
      expect(store.liveSessions(now)[0]?.title).toBe(
        "Explore cheap agent communication solutions",
      );
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

  test("an overlap is announced once per window, not once per edit", () => {
    // `pre-edit` fires on every edit, so an agent working through a contested
    // file posted an identical claim line each time — six in one log view,
    // burying the conversation between the two agents resolving it.
    fresh((store) => {
      const now = Date.now();
      const me = store.register("me", "/t", "main", now);
      expect(store.announcedOverlapRecently(me, "src/x.ts", now)).toBe(false);
      store.post(me, "claim", "also editing src/x.ts (held by peer in this tree)", now);
      expect(store.announcedOverlapRecently(me, "src/x.ts", now)).toBe(true);
      // A DIFFERENT file is still news.
      expect(store.announcedOverlapRecently(me, "src/y.ts", now)).toBe(false);
    });
  });

  test("the announcement window does not treat `_` in a path as a wildcard", () => {
    // LIKE's `_` matches any character, so an unescaped lookup for one file
    // would answer for its neighbour and suppress a real announcement.
    fresh((store) => {
      const now = Date.now();
      const me = store.register("me", "/t", "main", now);
      store.post(me, "claim", "also editing src/a_b.ts (held by peer in this tree)", now);
      expect(store.announcedOverlapRecently(me, "src/a_b.ts", now)).toBe(true);
      expect(store.announcedOverlapRecently(me, "src/axb.ts", now)).toBe(false);
    });
  });

  test("claims carry the worktree, so same-tree and cross-tree are separable", () => {
    // Two agents on one path in ONE checkout are about to overwrite each other;
    // in two worktrees they are editing different files. Reporting both the
    // same way made the warning meaningless.
    fresh((store) => {
      const now = Date.now();
      store.register("main", "/repo", "master", now);
      store.register("wt", "/repo/.claude/worktrees/x", "feature", now);
      store.claim("main", "src/x.ts", now);
      store.claim("wt", "src/x.ts", now);
      const holders = store.allClaims(now).filter((c) => c.path === "src/x.ts");
      expect(holders).toHaveLength(2);
      expect(new Set(holders.map((c) => c.worktree)).size).toBe(2);
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
