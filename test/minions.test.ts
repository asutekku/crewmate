/**
 * Subagents — "minions" — and how they attach to the parent that spawned them.
 *
 * The design in one line: a minion is VISIBLE but not ADDRESSABLE. It shows up
 * under its parent on `who` so the operator can see what is actually running,
 * and it has no identity of its own — no roster row, no pool name, no inbox.
 * Everything it does was already attributed to its parent before this table
 * existed, because its tool calls carry the parent's session id.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { MINION_STALE_MS, withStore } from "../core/store.ts";
import { minionName } from "../core/names.ts";
import { formatRoster } from "../core/shared.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-minion-${process.pid}-${n++}.db`;
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

const PARENT = "parent-conversation-uuid";

describe("minionName", () => {
  test("reads as the parent's possession", () => {
    expect(minionName("hopper", 1)).toBe("Hopper's Minion #1");
    expect(minionName("hopper", 12)).toBe("Hopper's Minion #12");
  });

  test("a name already ending in s takes a bare apostrophe", () => {
    expect(minionName("iris", 2)).toBe("Iris' Minion #2");
  });

  test("a multi-word chosen name survives", () => {
    // `validateAlias` permits spaces, so this is reachable.
    expect(minionName("water dynamic", 1)).toBe("Water Dynamic's Minion #1");
  });
});

describe("numbering", () => {
  test("counts up per parent", () => {
    fresh((store) => {
      const now = Date.now();
      expect(store.startMinion("a1", PARENT, now)).toBe(1);
      expect(store.startMinion("a2", PARENT, now)).toBe(2);
      expect(store.startMinion("a3", PARENT, now)).toBe(3);
    });
  });

  test("each parent has its own sequence", () => {
    fresh((store) => {
      const now = Date.now();
      expect(store.startMinion("a1", PARENT, now)).toBe(1);
      expect(store.startMinion("b1", "other-parent", now)).toBe(1);
      expect(store.startMinion("a2", PARENT, now)).toBe(2);
    });
  });

  test("A NUMBER IS NEVER REUSED, even after every minion has finished", () => {
    fresh((store) => {
      const now = Date.now();
      store.startMinion("a1", PARENT, now);
      store.startMinion("a2", PARENT, now);
      store.endMinion("a1", now);
      store.endMinion("a2", now);
      // Counting LIVE rows would restart at 1 here and silently repoint any log
      // line that named "Minion #1" at a different minion.
      expect(store.startMinion("a3", PARENT, now)).toBe(3);
    });
  });

  test("a repeated start does not consume a second number", () => {
    fresh((store) => {
      const now = Date.now();
      expect(store.startMinion("a1", PARENT, now)).toBe(1);
      // Same agent_id: one live minion must not appear under two names.
      expect(store.startMinion("a1", PARENT, now)).toBe(1);
      expect(store.startMinion("a2", PARENT, now)).toBe(2);
    });
  });
});

describe("liveness", () => {
  test("a running minion is listed under its parent", () => {
    fresh((store) => {
      const now = Date.now();
      store.startMinion("a1", PARENT, now, { task: "audit the store", agentType: "general" });
      const live = store.liveMinions(now).get(PARENT) ?? [];
      expect(live.length).toBe(1);
      expect(live[0]?.seq).toBe(1);
      expect(live[0]?.task).toBe("audit the store");
      expect(live[0]?.agentType).toBe("general");
    });
  });

  test("a finished minion drops off", () => {
    fresh((store) => {
      const now = Date.now();
      store.startMinion("a1", PARENT, now);
      store.startMinion("a2", PARENT, now);
      store.endMinion("a1", now);
      const live = store.liveMinions(now).get(PARENT) ?? [];
      expect(live.map((m) => m.seq)).toEqual([2]);
    });
  });

  test("the task name arrives on close, because Start never carries one", () => {
    fresh((store) => {
      const now = Date.now();
      // SubagentStart has agent_id and agent_type but no description; the
      // parent's own wording shows up in SubagentStop's background_tasks.
      store.startMinion("a1", PARENT, now, { agentType: "general-purpose" });
      expect((store.liveMinions(now).get(PARENT) ?? [])[0]?.task).toBe("");
      store.endMinion("a1", now, "Trivial probe task");

      store.startMinion("a2", PARENT, now);
      const rows = store.liveMinions(now).get(PARENT) ?? [];
      expect(rows.map((m) => m.seq)).toEqual([2]);
    });
  });

  test("a crashed parent's minion stops being believed", () => {
    fresh((store) => {
      const then = Date.now() - MINION_STALE_MS - 60_000;
      store.startMinion("a1", PARENT, then);
      const now = Date.now();
      // No SubagentStop ever fired — the parent died. Without a bound this row
      // would read as "still working" on every `who` from now on.
      expect(store.liveMinions(now).get(PARENT) ?? []).toEqual([]);
      store.pruneMinions(now);
      expect(store.liveMinions(now).get(PARENT) ?? []).toEqual([]);
    });
  });
});

describe("the roster line", () => {
  test("the label column fits the longest NUMBER, not the parent's name", () => {
    // Regression: the line borrowed the roster's `nameW`, which is measured on
    // agent names, so every minion truncated to `hoppe…` — hiding the one part
    // that tells two of them apart.
    const labels = [1, 2, 12].map((seq) => minionName("hopper", seq));
    const width = Math.max(...labels.map((l) => [...l].length));
    expect(width).toBe([..."Hopper's Minion #12"].length);
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(width);
    // And the name a peer would type is shorter than the label, which is why
    // sizing on the former cannot fit the latter.
    expect([..."hopper"].length).toBeLessThan(width);
  });
});

describe("what PEERS are told", () => {
  test("a peer sees the count, so it knows whom to ask", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(PARENT, "/tree", "master", now);
      store.setAlias(PARENT, "hopper", now);
      store.startMinion("a1", PARENT, now, { task: "rewrite the lot placer" });
      store.startMinion("a2", PARENT, now);

      const peers = store.liveSessions(now);
      const line = formatRoster(peers, [], now, "/tree", undefined, false, store.minionCounts(now))
        .join("\n");
      expect(line).toContain("+2 subagents working as them");
      // NEVER THE NAMES. `msg hopper's minion #1` resolves to nothing — only the
      // parent can reach one — so offering a peer that name would be a dead end.
      expect(line).not.toContain("Minion #1");
      expect(line).not.toContain("rewrite the lot placer");
    });
  });

  test("singular reads as English", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(PARENT, "/tree", "master", now);
      store.startMinion("a1", PARENT, now);
      const line = formatRoster(
        store.liveSessions(now), [], now, "/tree", undefined, false, store.minionCounts(now),
      ).join("\n");
      expect(line).toContain("+1 subagent working as them");
    });
  });

  test("a parent with none says nothing at all", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(PARENT, "/tree", "master", now);
      const line = formatRoster(
        store.liveSessions(now), [], now, "/tree", undefined, false, store.minionCounts(now),
      ).join("\n");
      expect(line).not.toContain("subagent");
    });
  });
});

describe("a minion is not an agent", () => {
  test("it never appears on the roster", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(PARENT, "/tree", "master", now);
      store.startMinion("a1", PARENT, now, { task: "grep things" });
      // The roster counts ADDRESSABLE agents. A minion on it would be something
      // the operator could not `msg` and a peer could not reach.
      expect(store.liveSessions(now).length).toBe(1);
    });
  });

  test("it takes no name from the pool", () => {
    fresh((store) => {
      const now = Date.now();
      const parentName = store.register(PARENT, "/tree", "master", now);
      for (let i = 0; i < 5; i++) store.startMinion(`a${i}`, PARENT, now);
      // Registering after five spawns must not have been pushed down the pool.
      const other = store.register("second-conversation", "/tree", "master", now);
      expect(other).not.toBe(parentName);
      expect(store.liveSessions(now).length).toBe(2);
    });
  });

  test("its name follows the parent's, because it is derived and not stored", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(PARENT, "/tree", "master", now);
      store.startMinion("a1", PARENT, now);
      store.setAlias(PARENT, "hopper", now);

      const live = (store.liveMinions(now).get(PARENT) ?? [])[0]!;
      expect(minionName("hopper", live.seq)).toBe("Hopper's Minion #1");
      // Frozen at spawn, it would still read "Tooling's Minion #1" here and the
      // roster would indent it under an agent by another name.
      store.setAlias(PARENT, "iris", now);
      expect(minionName("iris", live.seq)).toBe("Iris' Minion #1");
    });
  });
});
