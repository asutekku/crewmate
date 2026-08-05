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
import { collectBoardView } from "../cli/work.ts";

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

const AGENT = "session:c5ce05bc-4024-45ef-8cb0-67c0c08d323d";

describe("agent identity", () => {
  test("the session id IS the conversation id, so it keys the timeline", () => {
    // MEASURED 2026-07-31 on this tool's own conversation: CLAUDE_CODE_SESSION_ID
    // is the transcript's filename — the uuid "claude --resume" takes — and a
    // mid-session restart moved the display name traffic-a0 -> traffic-7c while
    // the id stayed c5ce05bc-… . A restart is the SAME id.
    const id = "c5ce05bc-4024-45ef-8cb0-67c0c08d323d";
    expect(agentKey("Explore cheap agent communication solutions", id)).toBe(`session:${id}`);
  });

  test("RENAMING the conversation does not orphan its records", () => {
    // Tests the RECORDS, not the key function. Asserting
    // `agentKey(titleA, id) === agentKey(titleB, id)` would be a tautology —
    // `agentKey` ignores its title, so both sides reduce to `session:${id}` and
    // the assertion would hold for any implementation, including a broken one.
    // What has to be true is that an item opened before a rename is still found
    // after it.
    fresh((store) => {
      const w = store.work;
      const id = "c5ce05bc-4024-45ef-8cb0-67c0c08d323d";
      const opened = w.open(
        agentKey("Explore cheap agent communication solutions", id),
        "traffic-a0",
        "work records P0",
        ["one"],
        1000,
      );
      const found = w.target(agentKey("Something the model renamed it to later", id));
      expect(found?.workId).toBe(opened);
    });
  });

  test("a renamed agent is credited under its name after its session row goes", () => {
    // MEASURED 2026-08-05: `crew clear` empties `sessions`, and the board
    // immediately re-rendered this agent's own open item as `akari` — a name
    // it had been renamed away from two days earlier. The live-session
    // subquery had been the ONLY resolution, so anything it could not answer
    // fell straight back to the name frozen when the item was opened.
    fresh((store) => {
      const id = "c5ce05bc-4024-45ef-8cb0-67c0c08d323d";
      const key = agentKey("", id);
      store.work.open(key, "akari", "explore agent communication", [], 1000);
      store.owners.claim(id, "hopper", 2000);

      // The session row is gone; the ledger is not.
      store.db.query(`DELETE FROM sessions`).run();
      expect(store.work.items({ agentId: key })[0]?.agentName).toBe("hopper");
    });
  });

  test("an untitled session is keyed exactly like a titled one", () => {
    // The title never participates, so there is no second code path to get
    // wrong and no window where early records land under a different key.
    expect(agentKey("", "sess-1")).toBe("session:sess-1");
    expect(agentKey("a title", "sess-1")).toBe("session:sess-1");
    // Two different conversations must NOT share a timeline.
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

  test("a restarted session picks up the checklist it opened before", () => {
    // THE PROPERTY THE WHOLE IDENTITY DESIGN EXISTS FOR — and it holds through
    // a RENAME, which is what the earlier title-keyed version got wrong.
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "traffic-a0", "retiring the old net core", ["one", "two"], 1000);
      w.tick(id, 1, "", 2000);

      // Same conversation after a restart: same id, new display name, and the
      // model has since rewritten the conversation's title.
      const after = agentKey("a completely different title now", "c5ce05bc-4024-45ef-8cb0-67c0c08d323d");
      const resumed = w.target(after);
      expect(resumed?.workId).toBe(id);
      expect(w.tick(resumed!.workId, 2, "picked up after a restart", 3000)).toBe(true);
      expect(progress(w.steps(id)).done).toBe(2);
      // The name is the one FROZEN at creation, so the board still credits the
      // agent that opened it rather than blanking out after the restart.
      expect(resumed?.agentName).toBe("traffic-a0");
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

describe("who the board credits", () => {
  const ID = "c5ce05bc-4024-45ef-8cb0-67c0c08d323d";
  const KEY = `session:${ID}`;

  test("an agent that renames itself is credited under the NEW name", () => {
    // Found live: the board still said `traffic-7c` minutes after the agent had
    // renamed itself to `tooling`, because the name was frozen at creation.
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.work.open(KEY, "traffic-7c", "some work", [], now);
      store.setAlias(ID, "tooling", now);
      expect(store.work.items({ agentId: KEY })[0]?.agentName).toBe("tooling");
    });
  });

  test("an agent that has EXITED is still credited, from the ledger", () => {
    // The other half: with no live row to resolve against, the work must still
    // say who did it — the whole point of keeping closed records for a week.
    //
    // It resolves through `name_owners`, NOT the copy frozen at creation. This
    // assertion used to demand `traffic-7c`, the disposable label passed in at
    // `open`, and passed because the ledger was never consulted; the same gap
    // made `crew clear` re-render a live agent under a name it had abandoned
    // two days earlier. `register` ledgers the given name, so that is what an
    // exited agent is owed.
    fresh((store) => {
      const now = Date.now();
      const given = store.register(ID, "/tree", "master", now);
      store.work.open(KEY, "traffic-7c", "some work", [], now);
      store.unregister(ID);
      expect(store.work.items({ agentId: KEY })[0]?.agentName).toBe(given);
    });
  });

  test("a record whose conversation left the ledger keeps its frozen name", () => {
    // The LAST fallback, and the reason the frozen column still exists: once
    // `release` drops a conversation gone from disk, nothing else can name it.
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.work.open(KEY, "traffic-7c", "some work", [], now);
      store.unregister(ID);
      store.db.query(`DELETE FROM name_owners`).run();
      expect(store.work.items({ agentId: KEY })[0]?.agentName).toBe("traffic-7c");
    });
  });

  test("the live name is resolved on every read path", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.work.open(KEY, "traffic-7c", "some work", [], now);
      store.setAlias(ID, "tooling", now);
      expect(store.work.target(KEY)?.agentName).toBe("tooling");
      expect(store.work.openItems(KEY)[0]?.agentName).toBe("tooling");
      expect(store.work.items({})[0]?.agentName).toBe("tooling");
    });
  });

  test("a session named by its HANDLE resolves too, not just by alias", () => {
    // THE CASE THE THREE TESTS ABOVE ALL MISS: each of them calls `setAlias`,
    // and `alias` was the only column the query consulted — so they passed while
    // the ordinary session, whose name is its given handle with `alias` empty,
    // resolved to nothing and fell back to its frozen string.
    fresh((store) => {
      const now = Date.now();
      const handle = store.register(ID, "/tree", "master", now);
      store.work.open(KEY, "tooling", "some work", [], now);
      expect(store.work.items({ agentId: KEY })[0]?.agentName).toBe(handle);
    });
  });

  test("every row of one agent reads the same name, however it was frozen", () => {
    // Found live on the board 2026-08-01: one agent appeared under TWO headings,
    // `Hopper` and `tooling`, because items opened before and after it was named
    // kept different frozen strings. Rows are ordered by `updated_ms`, so which
    // name the group showed depended on which item had been touched last —
    // closing the newest item relabelled the whole group.
    fresh((store) => {
      const now = Date.now();
      const handle = store.register(ID, "/tree", "master", now);
      store.work.open(KEY, "tooling", "opened under the old name", [], now - 5000);
      const later = store.work.open(KEY, handle, "opened under the new one", [], now);

      const names = () => store.work.items({ agentId: KEY, includeClosed: true }).map((i) => i.agentName);
      expect(new Set(names())).toEqual(new Set([handle]));

      // And it stays that way once the newer item closes — the sort changes, the
      // name must not.
      store.work.close(later, "done", "", now + 1000);
      expect(new Set(names())).toEqual(new Set([handle]));
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

/**
 * P1 — a row for an agent that never runs `doing`.
 *
 * The board's founding problem: agents skip optional work, and the task board
 * this replaced had zero rows. An agent that never opens an item is a blank
 * where the operator expects to see who is doing what.
 */
describe("auto-filled rows", () => {
  test("an agent that never opens an item still gets one", () => {
    fresh((store) => {
      const w = store.work;
      expect(w.openItems(AGENT)).toEqual([]);
      const id = w.autoOpen(AGENT, "hopper", "Investigating the water sim", 1000);
      expect(id).not.toBeNull();
      const items = w.openItems(AGENT);
      expect(items.length).toBe(1);
      expect(items[0]?.subject).toBe("Investigating the water sim");
      expect(items[0]?.auto).toBe(true);
    });
  });

  test("ONE placeholder, however many prompts arrive", () => {
    fresh((store) => {
      const w = store.work;
      const a = w.autoOpen(AGENT, "hopper", "first title", 1000);
      const b = w.autoOpen(AGENT, "hopper", "first title", 2000);
      expect(b).toBe(a);
      expect(w.openItems(AGENT).length).toBe(1);
    });
  });

  test("the subject FOLLOWS the conversation title as it moves", () => {
    // Claude Code rewrites the title as the work develops, and a placeholder
    // frozen at the opening subject is the stale-label problem the roster's
    // `intent` column already had.
    fresh((store) => {
      const w = store.work;
      w.autoOpen(AGENT, "hopper", "looking at water", 1000);
      w.autoOpen(AGENT, "hopper", "fixing the drain rate", 2000);
      expect(w.openItems(AGENT).map((i) => i.subject)).toEqual(["fixing the drain rate"]);
    });
  });

  test("refreshing it keeps it FRESH, so the stale nudge never asks about it", () => {
    fresh((store) => {
      const w = store.work;
      const HOUR = 60 * 60 * 1000;
      w.autoOpen(AGENT, "hopper", "a title", 1000);
      // Two hours later, another prompt arrives.
      w.autoOpen(AGENT, "hopper", "a title", 1000 + 2 * HOUR);
      expect(w.staleItems(AGENT, 1000 + 2 * HOUR, HOUR)).toEqual([]);
    });
  });

  test("a placeholder is NEVER raised by the stale nudge", () => {
    // Belt and braces on the above: an agent asked to reconcile the tool's own
    // bookkeeping is being asked about something it never chose to track.
    fresh((store) => {
      const w = store.work;
      const HOUR = 60 * 60 * 1000;
      w.autoOpen(AGENT, "hopper", "a title", 1000);
      expect(w.staleItems(AGENT, 1000 + 5 * HOUR, HOUR)).toEqual([]);
    });
  });

  test("NO placeholder while the agent has an item of its own", () => {
    fresh((store) => {
      const w = store.work;
      w.open(AGENT, "hopper", "what I said I am doing", ["one"], 1000);
      expect(w.autoOpen(AGENT, "hopper", "a conversation title", 2000)).toBeNull();
      expect(w.openItems(AGENT).map((i) => i.subject)).toEqual(["what I said I am doing"]);
    });
  });

  test("opening a real item RETIRES the placeholder", () => {
    fresh((store) => {
      const w = store.work;
      w.autoOpen(AGENT, "hopper", "a guess at the subject", 1000);
      w.replaceAutoWithWork(
        AGENT,
        "hopper",
        "what I am actually doing",
        ["one"],
        2000,
      );
      // Two rows for one piece of work is worse than none.
      expect(w.openItems(AGENT).map((i) => i.subject)).toEqual(["what I am actually doing"]);
      // Closed, not deleted — the events under it are a real record of when
      // this session started working.
      expect(w.items({ agentId: AGENT, includeClosed: true }).length).toBe(2);
    });
  });

  test("an empty title opens nothing", () => {
    fresh((store) => {
      expect(store.work.autoOpen(AGENT, "hopper", "   ", 1000)).toBeNull();
      expect(store.work.openItems(AGENT)).toEqual([]);
    });
  });
});

/** P3 — a sha is the one fact on the board nobody has to remember to record. */
describe("commits landing on an item", () => {
  test("a commit is recorded against the agent's current item", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "hopper", "the work", ["one"], 1000);
      expect(w.recordLanded(AGENT, "074bb51", "feat: a thing", 2000)).toBe(id);

      const landed = w.events(id).filter((e) => e.kind === "landed");
      expect(landed.length).toBe(1);
      expect(landed[0]?.ref).toBe("074bb51");
      expect(landed[0]?.body).toBe("feat: a thing");
    });
  });

  test("a commit with no open item records nothing rather than inventing one", () => {
    fresh((store) => {
      expect(store.work.recordLanded(AGENT, "074bb51", "feat: a thing", 2000)).toBeNull();
      expect(store.work.items({ agentId: AGENT, includeClosed: true })).toEqual([]);
    });
  });

  test("landing counts as activity, so a committing agent is not asked about it", () => {
    fresh((store) => {
      const w = store.work;
      const HOUR = 60 * 60 * 1000;
      w.open(AGENT, "hopper", "the work", ["one"], 1000);
      w.recordLanded(AGENT, "074bb51", "feat", 1000 + 3 * HOUR);
      expect(w.staleItems(AGENT, 1000 + 3 * HOUR + 60_000, HOUR)).toEqual([]);
    });
  });
});

/** P4 — breaks and needs. */
describe("breaks and needs", () => {
  test("records and notifies affected peers through one domain operation", () => {
    fresh((store) => {
      const now = 10_000;
      for (const session of ["me", "peer", "other"])
        store.register(session, "/repo", "main", now);
      store.setAlias("me", "sender", now);
      store.setAlias("peer", "affected", now);
      store.claim("me", "src/shared.ts", now, { tool: "Edit", worktree: "/repo" });
      store.claim("peer", "src/shared.ts", now, { tool: "Edit", worktree: "/repo" });
      store.claim("other", "src/other.ts", now, { tool: "Edit", worktree: "/repo" });
      const workId = store.work.open(
        agentKey("", "me"),
        "sender",
        "change shared API",
        [],
        now,
      );

      const reached = store.recordWorkFlag({
        workId,
        kind: "breaks",
        text: "removed the old call",
        subject: "change shared API",
        senderSessionId: "me",
        senderName: "sender",
        sinceMs: 0,
        nowMs: now + 1,
      });

      expect(reached).toEqual(["affected"]);
      expect(store.work.events(workId).at(-1)?.kind).toBe("breaks");
      expect(store.drainUnread("peer").map((message) => message.body)).toContain(
        'removed the old call (in "change shared API")',
      );
      expect(store.drainUnread("other")).toEqual([]);
    });
  });

  test("both attach to the agent's current item as events", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "hopper", "the work", ["one"], 1000);
      w.record(id, "breaks", "deleted buildGraph; callers must move", 2000);
      w.record(id, "needs", "waiting on the lane seam landing", 3000);

      const kinds = w.events(id).map((e) => e.kind);
      expect(kinds).toContain("breaks");
      expect(kinds).toContain("needs");
    });
  });

  test("a break shows in --history, which is where a reader looks later", () => {
    fresh((store) => {
      const w = store.work;
      const id = w.open(AGENT, "hopper", "the work", ["one"], 1000);
      w.record(id, "breaks", "deleted buildGraph", 2000);
      const fold = foldEvents(w.events(id));
      expect(fold.breaks.length).toBe(1);
      expect(fold.breaks[0]).toContain("buildGraph");
    });
  });
});

describe("asking about items that stopped moving", () => {
  const HOUR = 60 * 60 * 1000;

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

  test("an item that has not moved for an hour is raised", () => {
    // The live case: an item sat 13 hours at "1/3 · updated 12h" while its
    // agent had shipped four unrelated commits, so the board advertised work
    // nobody was doing and named a specific agent while doing it.
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      w.open(AGENT, "a", "stale one", ["one"], now - 2 * HOUR);
      expect(w.staleItems(AGENT, now, HOUR).map((i) => i.subject)).toEqual(["stale one"]);
    });
  });

  test("an item worked on recently is left alone", () => {
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      w.open(AGENT, "a", "live one", ["one"], now - 5 * 60 * 1000);
      expect(w.staleItems(AGENT, now, HOUR)).toEqual([]);
    });
  });

  test("TICKING A STEP MAKES IT FRESH, so an agent mid-work is not nagged", () => {
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      const id = w.open(AGENT, "a", "moving", ["one", "two"], now - 3 * HOUR);
      expect(w.staleItems(AGENT, now, HOUR).length).toBe(1);
      w.tick(id, 1, "did the first bit", now - 60 * 1000);
      expect(w.staleItems(AGENT, now, HOUR)).toEqual([]);
    });
  });

  test("asked ONCE — an agent that judges it still live is not asked again", () => {
    // A reminder that repeats is a reminder that gets skipped, and then the one
    // that mattered is skipped too.
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      const id = w.open(AGENT, "a", "stale one", ["one"], now - 2 * HOUR);
      expect(w.staleItems(AGENT, now, HOUR).length).toBe(1);
      w.markAsked(id, now);
      expect(w.staleItems(AGENT, now, HOUR)).toEqual([]);
      // Still true an hour later, without the agent having touched it.
      expect(w.staleItems(AGENT, now + HOUR, HOUR)).toEqual([]);
    });
  });

  test("a closed item is never raised", () => {
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      const id = w.open(AGENT, "a", "finished", ["one"], now - 5 * HOUR);
      w.close(id, "done", "shipped it", now - 4 * HOUR);
      expect(w.staleItems(AGENT, now, HOUR)).toEqual([]);
    });
  });

  test("only THIS agent's items — you are not asked about a peer's", () => {
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      w.open(AGENT, "a", "mine", ["one"], now - 2 * HOUR);
      w.open("session:someone-else", "b", "theirs", ["one"], now - 2 * HOUR);
      expect(w.staleItems(AGENT, now, HOUR).map((i) => i.subject)).toEqual(["mine"]);
    });
  });

  test("the oldest comes first, since the display is capped", () => {
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      w.open(AGENT, "a", "recent-ish", ["one"], now - 2 * HOUR);
      w.open(AGENT, "a", "ancient", ["one"], now - 8 * HOUR);
      expect(w.staleItems(AGENT, now, HOUR).map((i) => i.subject)).toEqual([
        "ancient",
        "recent-ish",
      ]);
    });
  });
});

describe("the stale nudge under stress", () => {
  const HOUR = 60 * 60 * 1000;

  test("the boundary is EXCLUSIVE, so an item is never asked about early", () => {
    // `updated_ms < now - staleMs` is a strict comparison. Asserted rather than
    // assumed because an off-by-one here is invisible in normal use and turns
    // into "the nudge fired while I was still working" exactly once, on a
    // machine where the timestamps happen to line up.
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      w.open(AGENT, "a", "right on the line", [], now - HOUR);
      // Exactly at the threshold: not yet stale.
      expect(w.staleItems(AGENT, now, HOUR)).toEqual([]);
      // One millisecond past it: stale.
      expect(w.staleItems(AGENT, now + 1, HOUR).map((i) => i.subject)).toEqual(["right on the line"]);
    });
  });

  test("a 1 ms stale window does not make every item permanently overdue", () => {
    // A config can set `workStaleMs` to anything. The nudge has to stay
    // ASK-ONCE under a pathological setting, or a misconfigured repo turns
    // every prompt into a wall of reminders — which is how a nudge stops being
    // read at all.
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      for (let i = 0; i < 5; i++) w.open(AGENT, "a", `item ${i}`, [], now);
      const first = w.staleItems(AGENT, now + 10, 1);
      expect(first.length).toBe(5);
      for (const item of first) w.markAsked(item.workId, now + 10);
      // Asked once; the next turn must be silent even though every item is
      // still far past a 1 ms window.
      expect(w.staleItems(AGENT, now + 10_000, 1)).toEqual([]);
    });
  });

  test("MANY stale items drain a few per turn instead of repeating the same few", () => {
    // The hook shows at most STALE_SHOWN and marks only those. The property
    // that makes it work is that the SHOWN ones are marked, so the next turn
    // advances — a version that marked all of them would lose the tail, and one
    // that marked none would repeat the first three forever.
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      for (let i = 0; i < 10; i++) w.open(AGENT, "a", `item ${i}`, [], now - 2 * HOUR + i);

      const seen: string[] = [];
      for (let turn = 0; turn < 4; turn++) {
        const batch = w.staleItems(AGENT, now, HOUR).slice(0, 3);
        for (const item of batch) {
          seen.push(item.subject);
          w.markAsked(item.workId, now + turn);
        }
      }
      // Ten distinct items, each raised exactly once — no repeats, nothing lost.
      expect(seen.length).toBe(10);
      expect(new Set(seen).size).toBe(10);
      expect(w.staleItems(AGENT, now, HOUR)).toEqual([]);
    });
  });

  test("AN ITEM ASKED ONCE IS NEVER ASKED AGAIN, even after real work on it", () => {
    // DOCUMENTS A LIMITATION, and deliberately asserts the behaviour that
    // exists rather than the one the comments describe.
    //
    // `staleItems` filters on `asked_turn_ms = 0`, so the column is a BOOLEAN
    // in practice — the timestamp it stores is never compared to anything
    // (verified 2026-08-01: no code path reads `asked_turn_ms` except this
    // `= 0` test). `work.ts` says "must not be asked again NEXT TURN"; what
    // happens is "never again for the item's whole life".
    //
    // The consequence: an agent that answers the nudge, works for another day,
    // and abandons the item is never reminded a second time — the dangling item
    // the nudge exists to catch comes back and is now permanently invisible.
    // Left as-is because the alternative (re-ask after another stale window)
    // is a judgement about how naggy the tool should be, not a bug fix.
    fresh((store) => {
      const w = store.work;
      const now = 10 * HOUR;
      const id = w.open(AGENT, "a", "worked on, then abandoned again", [], now - 2 * HOUR);
      expect(w.staleItems(AGENT, now, HOUR).length).toBe(1);
      w.markAsked(id, now);

      // Genuine progress: the agent answered, and moved the item on.
      w.record(id, "did", "made real progress", now + 60_000);
      // ...then went quiet for a week.
      expect(w.staleItems(AGENT, now + 7 * 24 * HOUR, HOUR)).toEqual([]);
    });
  });
});

describe("placeholder rows under duress", () => {

  test("closeAuto with NO placeholder is a no-op, not a throw", () => {
    // Reached whenever an agent's first board command is `doing` — the common
    // case for a disciplined agent, and the one least likely to be exercised by
    // hand.
    fresh((store) => {
      expect(() => store.work.closeAuto("session:never-seen", 1000)).not.toThrow();
    });
  });

  test("closeAuto clears EVERY placeholder, not just the first", () => {
    // `autoOpen` is idempotent, so two auto rows should be unreachable — but if
    // one ever appears (a crash between transactions, a hand-edited db), the
    // cleanup must not leave a second placeholder advertising work that has a
    // real item beside it.
    fresh((store) => {
      const w = store.work;
      const db = (store as unknown as { db: { query: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      for (const t of ["ghost one", "ghost two"]) {
        db.query(
          `INSERT INTO work (agent_id, agent_name, subject, started_ms, updated_ms, auto) VALUES (?,?,?,?,?,1)`,
        ).run(AGENT, "a", t, 1000, 1000);
      }
      expect(w.openItems(AGENT).length).toBe(2);
      w.closeAuto(AGENT, 2000);
      expect(w.openItems(AGENT)).toEqual([]);
    });
  });

  test("a placeholder subject survives a newline and an absurd length", () => {
    // The subject is Claude Code's conversation title — model-written, so its
    // shape is not under this tool's control. It must not be able to break the
    // row or the board's layout.
    fresh((store) => {
      const w = store.work;
      const nasty = `line one\nline two ${"x".repeat(5000)}`;
      const id = w.autoOpen(AGENT, "a", nasty, 1000);
      expect(id).not.toBeNull();
      const item = w.openItems(AGENT)[0];
      expect(item?.subject).toBe(nasty.trim());
      // And it is still the SAME row on the next prompt, not a second one.
      w.autoOpen(AGENT, "a", nasty, 2000);
      expect(w.openItems(AGENT).length).toBe(1);
    });
  });

  test("a landed commit attaches to a PLACEHOLDER when that is all there is", () => {
    // `recordLanded` targets whatever item is open. A commit made by an agent
    // that never ran `doing` should still be recorded rather than dropped —
    // the sha is the one fact on the board nobody has to remember.
    fresh((store) => {
      const w = store.work;
      const auto = w.autoOpen(AGENT, "a", "a conversation title", 1000);
      expect(w.recordLanded(AGENT, "074bb51", "feat: a thing", 2000)).toBe(auto);
      const landed = w.events(auto ?? 0).filter((e) => e.kind === "landed");
      expect(landed.map((e) => e.ref)).toEqual(["074bb51"]);
    });
  });
});

describe("two processes, one db", () => {
  test("THE PLACEHOLDER RACE IS REAL, and the transaction is what closes it", () => {
    // Documents a measurement rather than exercising `autoOpen` directly, and
    // that is deliberate — an end-to-end race test on this code CANNOT
    // discriminate. Four real processes spun to one wall-clock instant all pass
    // whether `autoOpen` uses BEGIN IMMEDIATE, a deferred transaction, or no
    // transaction at all (measured 2026-08-01, three runs each): the whole
    // read-then-write takes microseconds, so the workers never actually
    // interleave and the test would pass on broken code. That is the "test
    // stops at the first observation" shape, so it is not shipped as one.
    //
    // What IS established: the race is not hypothetical. The same four
    // processes running a check-then-insert with the gap held open 40 ms
    // produced FOUR placeholder rows against this schema. So the atomicity in
    // `autoOpen` is load-bearing, and anyone tempted to unwrap the transaction
    // for tidiness should reproduce that measurement first.
    //
    // The assertion below is the SEQUENTIAL half — the part a test can hold
    // honestly. The concurrent half is guarded by the transaction, and by this
    // comment telling the next reader why there is no test for it.
    fresh((store) => {
      const w = store.work;
      for (let i = 0; i < 4; i++) w.autoOpen(AGENT, "racer", `title-${i}`, 1000 + i);
      const open = w.openItems(AGENT);
      expect(open.length).toBe(1);
      expect(open[0]?.auto).toBe(true);
      // The subject FOLLOWS the newest title rather than sticking at the first.
      expect(open[0]?.subject).toBe("title-3");
      // One 'started' event, so `--history` cannot claim the work began 4 times.
      expect(w.events(open[0]?.workId ?? 0).filter((e) => e.kind === "started").length).toBe(1);
    });
  });
});

describe("the board when a name has been reused", () => {
  test("two conversations that both used one name are told apart", () => {
    // MEASURED LIVE 2026-08-05: `crew board` printed two `akira` headers, each
    // with its own open item. Names return to the pool when a conversation
    // ends, so two blocks under one name is a legitimate state of the data —
    // and unreadable, because it looks like one agent listed twice.
    fresh((store) => {
      const now = Date.now();
      const older = "session:1f4b2f83-3d6c-4636-940d-c6000c15ef97";
      const newer = "session:1c77a134-1a87-4c1b-8917-c575fdf9473f";
      store.work.open(older, "akira", "keep-clear moves into net/", [], now - 9000);
      store.work.open(newer, "akira", "debug agent identity change", [], now);
      store.work.open("session:solo-1", "adela", "refactor with KISS", [], now);

      const result = collectBoardView(store, "", now, {
        all: false,
        history: false,
        raw: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.view.agents.map((a) => a.name).sort();
      expect(names).toEqual(
        [
          "adela",
          `akira (${older.slice(-6)})`,
          `akira (${newer.slice(-6)})`,
        ].sort(),
      );
    });
  });

  test("a name only one conversation holds is left plain", () => {
    // The suffix is disambiguation, not decoration: paying it on every row
    // would make the common case noisier to fix a case that is not present.
    fresh((store) => {
      const now = Date.now();
      store.work.open("session:solo-1", "adela", "one", [], now);
      store.work.open("session:solo-2", "ash", "two", [], now);
      const result = collectBoardView(store, "", now, {
        all: false,
        history: false,
        raw: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.view.agents.map((a) => a.name).sort()).toEqual(["adela", "ash"]);
    });
  });
});
