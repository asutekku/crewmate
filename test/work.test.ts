/**
 * Work records: the timeline property, and the P0 gate.
 *
 * THE GATE FROM THE PLAN: "Two items open at once for one agent, both listed
 * with their checklists; closing one leaves the other." Plus the constraint that
 * makes the design worth anything — "P0 must prove the timeline property … a P0
 * that stores current state in columns will not grow into `--history` later."
 * Both are tested here rather than asserted in a commit message.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { agentKey, foldEvents, parsePlan, progress, WORK_KEEP_MS } from "../core/work.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-work-${process.pid}-${n++}.db`;
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

const AGENT = "title:retiring the old net core";

describe("agent identity", () => {
  test("the conversation title keys the timeline, not the session", () => {
    // The measured reason: worktree+branch collapsed 4 of 5 live agents onto
    // `Traffic#master`. A restarted terminal is a new session id, so a
    // session-keyed record would split one agent's timeline in two.
    const before = agentKey("retiring the old net core", "session-aa");
    const after = agentKey("retiring the old net core", "session-a0");
    expect(after).toBe(before);
  });

  test("an untitled session falls back to its own id rather than to nothing", () => {
    expect(agentKey("", "sess-1")).toBe("session:sess-1");
    expect(agentKey("   ", "sess-1")).toBe("session:sess-1");
    // Two untitled sessions must NOT share a timeline.
    expect(agentKey("", "sess-2")).not.toBe(agentKey("", "sess-1"));
  });
});

describe("parsePlan", () => {
  test("splits on semicolons and newlines", () => {
    expect(parsePlan("delete buildGraph; migrate callers; re-record")).toEqual([
      "delete buildGraph",
      "migrate callers",
      "re-record",
    ]);
    expect(parsePlan("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  test("strips the numbering agents add reflexively", () => {
    // Storing "1. delete buildGraph" as step 1 renders as "1. 1. delete …".
    expect(parsePlan("1. delete buildGraph; 2) migrate; - re-record")).toEqual([
      "delete buildGraph",
      "migrate",
      "re-record",
    ]);
  });

  test("an empty plan is no steps, not one empty step", () => {
    expect(parsePlan("")).toEqual([]);
    expect(parsePlan("  ;  ; ")).toEqual([]);
  });
});

describe("the P0 gate: several items open at once", () => {
  test("two items open together, both with their own checklists", () => {
    fresh((store) => {
      const w = store.work;
      const core = w.open(AGENT, "old-core-80", "retiring the old net core", ["delete", "migrate"], 1000);
      const sliver = w.open(AGENT, "old-core-80", "junction sliver fix", ["never absorb", "verify"], 2000);

      const open = w.openItems(AGENT);
      expect(open.map((i) => i.subject).sort()).toEqual([
        "junction sliver fix",
        "retiring the old net core",
      ]);
      expect(w.steps(core).map((s) => s.text)).toEqual(["delete", "migrate"]);
      expect(w.steps(sliver).map((s) => s.text)).toEqual(["never absorb", "verify"]);
    });
  });

  test("closing one leaves the other open, with its checklist intact", () => {
    fresh((store) => {
      const w = store.work;
      const core = w.open(AGENT, "old-core-80", "retiring the old net core", ["delete", "migrate"], 1000);
      const sliver = w.open(AGENT, "old-core-80", "junction sliver fix", ["never absorb"], 2000);

      w.close(sliver, "done", "", 3000);

      const open = w.openItems(AGENT);
      expect(open).toHaveLength(1);
      expect(open[0]?.workId).toBe(core);
      expect(w.steps(core)).toHaveLength(2);
      // The closed one is history, not deleted — that is what `--all` reads.
      const all = w.items({ agentId: AGENT, includeClosed: true });
      expect(all).toHaveLength(2);
      expect(all.find((i) => i.workId === sliver)?.outcome).toBe("done");
    });
  });

  test("a bare command targets the most recently touched item", () => {
    fresh((store) => {
      const w = store.work;
      const core = w.open(AGENT, "a", "retiring the old net core", [], 1000);
      const sliver = w.open(AGENT, "a", "junction sliver fix", [], 2000);
      expect(w.target(AGENT)?.workId).toBe(sliver);

      // Touching the older one makes it the target: an agent that says
      // "back to the core work" then reports against it must hit that item.
      w.record(core, "note", "back on this", 3000);
      expect(w.target(AGENT)?.workId).toBe(core);
    });
  });

  test("a subject substring overrides the most-recent rule", () => {
    fresh((store) => {
      const w = store.work;
      w.open(AGENT, "a", "retiring the old net core", [], 1000);
      const sliver = w.open(AGENT, "a", "junction sliver fix", [], 2000);
      w.record(sliver, "note", "x", 2500);
      expect(w.target(AGENT, "core")?.subject).toBe("retiring the old net core");
      expect(w.target(AGENT, "nothing matches this")).toBeNull();
    });
  });

  test("a restarted session picks up the checklist the old one opened", () => {
    // THE PROPERTY THE WHOLE IDENTITY DESIGN EXISTS FOR. Verified end-to-end
    // too: a session registered as `e2e-session-2` under the same conversation
    // title ticked step 2 of an item `e2e-session-1` had opened.
    fresh((store) => {
      const w = store.work;
      const before = agentKey("retiring the old net core", "session-aa");
      const id = w.open(before, "traffic-aa", "retiring the old net core", ["one", "two"], 1000);
      w.tick(id, 1, "", 2000);

      const after = agentKey("retiring the old net core", "session-a0");
      const resumed = w.target(after);
      expect(resumed?.workId).toBe(id);
      expect(w.tick(resumed!.workId, 2, "picked up after a restart", 3000)).toBe(true);
      expect(progress(w.steps(id)).done).toBe(2);
      // The name is the one FROZEN at creation, so the board still credits the
      // agent that opened it rather than blanking out after the restart.
      expect(resumed?.agentName).toBe("traffic-aa");
    });
  });

  test("one agent's items are invisible to another's commands", () => {
    fresh((store) => {
      const w = store.work;
      w.open(AGENT, "a", "retiring the old net core", [], 1000);
      expect(w.target("title:something else")).toBeNull();
      expect(w.openItems("title:something else")).toHaveLength(0);
    });
  });
});

describe("the timeline property", () => {
  test("every state change appends an event; nothing is overwritten", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "retiring the old net core", ["delete", "migrate"], 1000);
      w.tick(id, 1, "buildGraph and the core flag deleted", 2000);
      w.record(id, "landed", "2f2ac31 core retired", 3000, "2f2ac31");
      w.record(id, "breaks", "seed 42 goes 143→213 strokes", 3100);
      w.tick(id, 2, "12 call sites migrated", 4000);
      w.record(id, "landed", "3e36ff9 callers migrated", 5000, "3e36ff9");
      w.close(id, "done", "", 6000);

      const events = w.events(id);
      expect(events.map((e) => e.kind)).toEqual([
        "started",
        "did",
        "landed",
        "breaks",
        "did",
        "landed",
        "closed",
      ]);
      // Strictly ascending ids AND timestamps: the history renders in the order
      // things happened, not in the order rows were written.
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.id).toBeGreaterThan(events[i - 1]!.id);
        expect(events[i]!.tsMs).toBeGreaterThanOrEqual(events[i - 1]!.tsMs);
      }
    });
  });

  test("current state is a fold over the events, not a stored column", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", [], 1000);
      w.record(id, "landed", "first", 2000, "2f2ac31");
      w.record(id, "landed", "second", 3000, "3e36ff9");
      w.record(id, "breaks", "road baselines move", 3100);
      w.record(id, "needs", "someone to re-record citizenBaseline", 3200);
      w.record(id, "step", "unwrapping the call sites", 4000, "3");

      const fold = foldEvents(w.events(id));
      expect(fold.landed).toEqual(["2f2ac31", "3e36ff9"]);
      expect(fold.breaks).toEqual(["road baselines move"]);
      expect(fold.needs).toBe("someone to re-record citizenBaseline");
      expect(fold.status).toBe("unwrapping the call sites");
    });
  });

  test("a duplicate landed sha folds once", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", [], 1000);
      // P3 auto-detects commits; an agent may also record the same one by hand.
      w.record(id, "landed", "by hand", 2000, "2f2ac31");
      w.record(id, "landed", "by hook", 2100, "2f2ac31");
      expect(foldEvents(w.events(id)).landed).toEqual(["2f2ac31"]);
    });
  });

  test("an empty breaks retracts a consequence that did not happen", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", [], 1000);
      w.record(id, "breaks", "baselines move", 2000);
      expect(foldEvents(w.events(id)).breaks).toEqual(["baselines move"]);
      w.record(id, "breaks", "", 3000);
      expect(foldEvents(w.events(id)).breaks).toEqual([]);
      // The retraction is itself an event: the history still shows it was said.
      expect(w.events(id).filter((e) => e.kind === "breaks")).toHaveLength(2);
    });
  });

  test("a needs is cleared by an empty one", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", [], 1000);
      w.record(id, "needs", "waiting on the water branch", 2000);
      w.record(id, "needs", "", 3000);
      expect(foldEvents(w.events(id)).needs).toBe("");
    });
  });
});

describe("steps", () => {
  test("ticking derives progress and names the next outstanding step", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", ["one", "two", "three"], 1000);
      expect(progress(w.steps(id))).toMatchObject({ done: 0, total: 3 });
      w.tick(id, 1, "", 2000);
      const p = progress(w.steps(id));
      expect(p.done).toBe(1);
      expect(p.current?.text).toBe("two");
      expect(p.outstanding.map((s) => s.text)).toEqual(["two", "three"]);
    });
  });

  test("ticking out of order leaves the LOWEST outstanding step as current", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", ["one", "two", "three"], 1000);
      w.tick(id, 2, "", 2000);
      // Step 1 is still the one to do next; a later tick must not skip it.
      expect(progress(w.steps(id)).current?.text).toBe("one");
    });
  });

  test("a note on a ticked step survives into the timeline", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", ["migrate callers"], 1000);
      w.tick(id, 1, "12 call sites, 2 needed a different fix", 2000);
      expect(w.steps(id)[0]?.note).toBe("12 call sites, 2 needed a different fix");
      const did = w.events(id).find((e) => e.kind === "did");
      expect(did?.body).toBe("migrate callers: 12 call sites, 2 needed a different fix");
      expect(did?.ref).toBe("1");
    });
  });

  test("ticking a step that does not exist reports rather than inventing one", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", ["one"], 1000);
      expect(w.tick(id, 7, "", 2000)).toBe(false);
      expect(w.steps(id)).toHaveLength(1);
      expect(w.events(id).filter((e) => e.kind === "did")).toHaveLength(0);
    });
  });

  test("add appends a discovered phase after the last one", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", ["one", "two"], 1000);
      expect(w.addStep(id, "three", 2000)).toBe(3);
      expect(w.steps(id).map((s) => s.text)).toEqual(["one", "two", "three"]);
      // `add` must work on an item that never had a plan — that is the path from
      // "no checklist" to "a checklist", and P2's strictness gate reads it.
      const bare = w.open(AGENT, "a", "y", [], 3000);
      expect(w.addStep(bare, "first", 4000)).toBe(1);
      expect(progress(w.steps(bare)).total).toBe(1);
    });
  });

  test("an item with no checklist has zero steps, not an empty one", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "quick fix", [], 1000);
      // The P2 silence condition keys on this: total 0 means the agent judged
      // the work not worth phasing, and must never be asked to reconcile.
      expect(progress(w.steps(id)).total).toBe(0);
      expect(progress(w.steps(id)).current).toBeNull();
    });
  });
});

describe("lifetime", () => {
  test("an OPEN record survives the roster's stale sweep", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "long-running work", ["one"], 1000);
      // pruneStale runs on every `who`; a work record keyed on the AGENT must
      // not die with the session that opened it.
      store.pruneStale(Date.now());
      expect(w.items({ agentId: AGENT })).toHaveLength(1);
      expect(w.steps(id)).toHaveLength(1);
    });
  });

  test("a closed record is kept for the keep window, then pruned with its rows", () => {
    fresh((store) => {
      const w = store.work;
      const now = Date.now();
      const recent = w.open(AGENT, "a", "recent", ["s"], now - 1000);
      const old = w.open(AGENT, "a", "old", ["s"], now - WORK_KEEP_MS * 2);
      w.close(recent, "done", "", now - 500);
      w.close(old, "done", "", now - WORK_KEEP_MS - 1000);

      w.pruneWork(now);
      const left = w.items({ agentId: AGENT, includeClosed: true });
      expect(left.map((i) => i.subject)).toEqual(["recent"]);
      // Steps and events die WITH the item; they are what actually grows.
      expect(w.steps(old)).toHaveLength(0);
      expect(w.events(old)).toHaveLength(0);
      expect(w.steps(recent)).toHaveLength(1);
    });
  });

  test("an item still open past the keep window is never pruned", () => {
    fresh((store) => {
      const w = store.work;
      const now = Date.now();
      w.open(AGENT, "a", "forgotten but open", [], now - WORK_KEEP_MS * 3);
      w.pruneWork(now);
      expect(w.openItems(AGENT)).toHaveLength(1);
    });
  });
});

describe("board ordering", () => {
  test("open items sort ahead of closed ones", () => {
    fresh((store) => {
      const w = store.work;
      const closed = w.open(AGENT, "a", "closed one", [], 1000);
      w.close(closed, "done", "", 2000);
      w.open(AGENT, "a", "open one", [], 1500);
      const items = w.items({ agentId: AGENT, includeClosed: true });
      expect(items.map((i) => i.subject)).toEqual(["open one", "closed one"]);
    });
  });

  test("recording bumps updatedMs so the board sorts on real activity", () => {
    fresh((store) => {
      const w = store.work;
      const first = w.open(AGENT, "a", "first", [], 1000);
      w.open(AGENT, "a", "second", [], 2000);
      w.record(first, "note", "still going", 5000);
      expect(w.items({ agentId: AGENT })[0]?.subject).toBe("first");
    });
  });

  test("a tick bumps updatedMs too — a ticked step IS activity", () => {
    fresh((store) => {
      const w = store.work;
      const first = w.open(AGENT, "a", "first", ["one"], 1000);
      w.open(AGENT, "a", "second", [], 2000);
      w.tick(first, 1, "", 5000);
      expect(w.items({ agentId: AGENT })[0]?.subject).toBe("first");
    });
  });

  test("items() with no agent shows every agent's records", () => {
    fresh((store) => {
      const w = store.work;
      w.open("title:one", "a", "a-work", [], 1000);
      w.open("title:two", "b", "b-work", [], 2000);
      expect(w.items({}).map((i) => i.subject).sort()).toEqual(["a-work", "b-work"]);
    });
  });
});

describe("the idle-check guard (stored in P0, read in P2)", () => {
  test("markAsked records the turn so one item cannot be asked twice", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "a", "x", ["one"], 1000);
      expect(w.target(AGENT)?.askedTurnMs).toBe(0);
      w.markAsked(id, 4242);
      expect(w.target(AGENT)?.askedTurnMs).toBe(4242);
      // Asking must NOT count as activity — a reminder the agent ignored should
      // not reorder the board or make the item look freshly worked on.
      expect(w.target(AGENT)?.updatedMs).toBe(1000);
    });
  });
});
