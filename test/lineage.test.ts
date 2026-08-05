/**
 * Lineage: knowledge that outlives the conversation that learned it.
 *
 * THE BUG THIS CLOSES, in the operator's words: "I might start a new session
 * with roadworks, and if I forget a roadwork agent already exists, it might
 * create a completely new empty state that has to learn everything from
 * scratch." That was not a risk — it was the behaviour, every time, because
 * memories were keyed on the conversation uuid and a new conversation is a new
 * uuid by definition.
 *
 * TWO PROPERTIES CARRY IT AND BOTH FAIL SILENTLY. A successor must actually
 * read its predecessor's memories (or the feature does nothing), and a live
 * lineage must never be adopted (or two sessions write one body of knowledge
 * and it becomes a composite nobody can untangle).
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { checkMemory, lineageKey, withPersonal } from "../core/personal.ts";
import { discipleName } from "../core/names.ts";
import { displayName, lineageName, withStore } from "../core/store.ts";
import { lineageLines } from "../hooks/pre-edit.ts";

let n = 0;
let base = "";
const paths: string[] = [];

beforeEach(() => {
  // ABSOLUTE, not /tmp: under Git Bash a /tmp path resolves to a different file
  // per process, so a harness silently writes one db and reads another.
  base = `${tmpdir().replace(/\\/g, "/")}/presence-lineage-${process.pid}-${n++}`;
  process.env["PRESENCE_TEST_DB"] = base;
  paths.push(base);
});

afterEach(() => {
  delete process.env["PRESENCE_TEST_DB"];
  for (const p of paths.splice(0)) {
    for (const suffix of ["", ".personal", ".personal-wal", ".personal-shm", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {
        /* already gone */
      }
    }
  }
});

const HOPPER_UUID = "hopper-conversation-uuid";
const VEGA_UUID = "vega-conversation-uuid";

function ok(title: string) {
  const c = checkMemory(title, "", []);
  if (!c.ok) throw new Error(`fixture rejected: ${c.why}`);
  return c;
}

describe("the bug it closes", () => {
  test("a NEW conversation reading the same lineage sees what the old one learned", () => {
    // The whole feature in one assertion. Before this, the second read was 0.
    withPersonal((p) => {
      p.remember(HOPPER_UUID, "hopper", ok("hands me rendering changes to check"), "Traffic",
        false, 1, "hopper");
      // A different conversation entirely — new uuid, same lineage.
      expect(p.forLineage("hopper", "Traffic").length).toBe(1);
      expect(p.forLineage(lineageKey("hopper", VEGA_UUID), "Traffic").length).toBe(1);
    });
  });

  test("the conversation that learned it is still recorded", () => {
    // Frozen at write time, like the diary and `edits`. "Which conversation
    // learned this" must stay answerable after that conversation is gone.
    withPersonal((p) => {
      const id = p.remember(HOPPER_UUID, "hopper", ok("x"), "Traffic", false, 1, "hopper");
      const m = p.get(id);
      expect(m?.sessionId).toBe(HOPPER_UUID);
      expect(m?.lineage).toBe("hopper");
    });
  });

  test("a disciple's own writes JOIN the lineage rather than forking it", () => {
    // vega writes under hopper's lineage: `agent` says who learned it, `lineage`
    // says whose body of knowledge it joins. Both are needed.
    withPersonal((p) => {
      p.remember(HOPPER_UUID, "hopper", ok("the master's"), "Traffic", false, 1, "hopper");
      p.remember(VEGA_UUID, "vega", ok("the disciple's"), "Traffic", false, 2, "hopper");
      expect(p.forLineage("hopper", "Traffic").map((m) => m.title)).toEqual([
        "the master's",
        "the disciple's",
      ]);
      expect(p.get(2)?.agent).toBe("vega");
    });
  });

  test("case does not split a lineage", () => {
    // Names are matched case-insensitively everywhere else here, and two
    // lineages differing only in case would be invisible to whoever typed them.
    expect(lineageKey("Hopper", HOPPER_UUID)).toBe("hopper");
    expect(lineageKey("  HOPPER  ", HOPPER_UUID)).toBe("hopper");
  });
});

describe("the disciple name", () => {
  test("Vega, Hopper's Disciple", () => {
    // USER RULING 2026-08-01, verbatim: "I prefer 'Vega, Hopper's Disciple'."
    expect(discipleName("vega", "hopper")).toBe("Vega, Hopper's Disciple");
  });

  test("a name ending in s takes a bare apostrophe", () => {
    expect(discipleName("vega", "iris")).toBe("Vega, Iris' Disciple");
  });

  test("no lineage is just the name", () => {
    expect(discipleName("vega", "")).toBe("Vega");
  });

  test("a RESUME is not a succession and gets no marking", () => {
    // Same uuid, same transcript, same everything the tool tracks. Marking it
    // would claim a succession that did not happen.
    expect(discipleName("hopper", "hopper")).toBe("Hopper");
    expect(discipleName("Hopper", "hopper")).toBe("Hopper");
  });

  test("the ADDRESSABLE name is untouched — peers still type one word", () => {
    // THE SPLIT THAT MATTERS. `displayName` is what goes after `msg`; if the
    // disciple form leaked into it, every message to a successor would fail.
    const s = {
      name: "traffic-9",
      handle: "vega",
      alias: "",
      lineageFrom: "hopper",
    };
    expect(displayName(s)).toBe("vega");
    expect(lineageName(s)).toBe("Vega, Hopper's Disciple");
    expect(displayName(s)).not.toContain(" ");
  });
});

describe("a live lineage cannot be inherited", () => {
  test("liveHolder finds the agent still answering to that name", () => {
    withStore(`${base}.db`, (store) => {
      const now = 1_000_000;
      // The handle is assigned FROM THE POOL, so the test must ask what this
      // session ended up being called rather than assume it. (Written the other
      // way first, and it failed — `register` does not take a name.)
      const handle = store.register(HOPPER_UUID, "I:/tree", "master", now);
      expect(store.liveHolder(handle, now)?.sessionId).toBe(HOPPER_UUID);
      // Case-insensitively, because a lineage key is lowercased on the way in.
      expect(store.liveHolder(handle.toUpperCase(), now)?.sessionId).toBe(HOPPER_UUID);
    });
  });

  test("a lineage nobody holds is free", () => {
    withStore(`${base}.db`, (store) => {
      expect(store.liveHolder("nobody-by-that-name", 1_000_000)).toBeNull();
    });
  });

  test("a STALE holder does not block inheritance — that is the whole point", () => {
    // Succession happens when the original is gone. If a departed session kept
    // its lineage locked, nothing could ever be inherited.
    withStore(`${base}.db`, (store) => {
      const then = 1_000_000;
      const handle = store.register(HOPPER_UUID, "I:/tree", "master", then);
      expect(store.liveHolder(handle, then)).not.toBeNull();
      // Far past STALE_MS (90 min).
      const later = then + 10 * 60 * 60 * 1000;
      expect(store.liveHolder(handle, later)).toBeNull();
    });
  });

  test("a session that ALREADY took a lineage holds it too", () => {
    // Otherwise a disciple's disciple starts a third writer on one lineage
    // while the second is still working.
    withStore(`${base}.db`, (store) => {
      const now = 1_000_000;
      store.register(VEGA_UUID, "I:/tree", "master", now);
      store.setLineage(VEGA_UUID, "hopper");
      expect(store.liveHolder("hopper", now)?.sessionId).toBe(VEGA_UUID);
    });
  });

  test("dropping a lineage releases it", () => {
    withStore(`${base}.db`, (store) => {
      const now = 1_000_000;
      store.register(VEGA_UUID, "I:/tree", "master", now);
      store.setLineage(VEGA_UUID, "hopper");
      store.setLineage(VEGA_UUID, "");
      expect(store.liveHolder("hopper", now)).toBeNull();
    });
  });
});

describe("the pre-edit offer", () => {
  /** A session, a departed author, and one scoped finding by that author. */
  function ground(): { store: Parameters<Parameters<typeof withStore>[1]>[0]; me: string } {
    return withStore(`${base}.db`, (store) => {
      const me = store.register(VEGA_UUID, "I:/Projects/Traffic", "master", Date.now());
      store.diary.write("uuid-ambrose", "ambrose", {
        title: "moisture settles two-sided",
        body: "",
        topic: "water",
        tags: [],
        kind: "finding",
        scope: "src/sim/water",
      }, Date.now());
      return { store, me };
    });
  }

  test("names a departed author who has knowledge to pass on", () => {
    const { me } = ground();
    withStore(`${base}.db`, (store) => {
      const lines = lineageLines(store, VEGA_UUID, "src/sim/water/flow.ts", new Set(["ambrose"]));
      expect(lines.join("\n")).toContain("crew inherit ambrose");
      // The command must be runnable AS PRINTED, and the offer must say what
      // taking it makes you — a hook naming a command that returns nothing has
      // shipped here twice.
      expect(lines.join("\n")).toContain(discipleName(me, "ambrose"));
    });
  });

  test("says nothing when the author is still LIVE", () => {
    // A live peer is someone to ASK; `inherit` would refuse it anyway, so
    // offering it would be advice that fails when followed.
    ground();
    withStore(`${base}.db`, (store) => {
      store.register("uuid-ambrose", "I:/Projects/Traffic", "master", Date.now());
      const live = store.findBySession("uuid-ambrose");
      const name = displayName(live!).toLowerCase();
      store.diary.write("uuid-ambrose", name, {
        title: "a live author's finding",
        body: "",
        topic: "water",
        tags: [],
        kind: "finding",
        scope: "src/sim/water",
      }, Date.now());
      const lines = lineageLines(store, VEGA_UUID, "src/sim/water/flow.ts", new Set([name]));
      expect(lines).toEqual([]);
    });
  });

  test("says nothing when the author holds NO memories", () => {
    // Nothing to inherit. The diary is the index, but the personal store is
    // what would actually be handed over.
    ground();
    withStore(`${base}.db`, (store) => {
      expect(lineageLines(store, VEGA_UUID, "src/sim/water/flow.ts", new Set())).toEqual([]);
    });
  });

  test("says nothing once this session already has a lineage", () => {
    // It has decided. A hook that argues with a decision is one that gets
    // ignored on the occasion it is right.
    ground();
    withStore(`${base}.db`, (store) => {
      store.setLineage(VEGA_UUID, "hopper");
      expect(
        lineageLines(store, VEGA_UUID, "src/sim/water/flow.ts", new Set(["ambrose"])),
      ).toEqual([]);
    });
  });

  test("never offers you your own name", () => {
    withStore(`${base}.db`, (store) => {
      const me = store.register(VEGA_UUID, "I:/Projects/Traffic", "master", Date.now());
      store.diary.write(VEGA_UUID, me, {
        title: "my own finding",
        body: "",
        topic: "water",
        tags: [],
        kind: "finding",
        scope: "src/sim/water",
      }, Date.now());
      expect(
        lineageLines(store, VEGA_UUID, "src/sim/water/flow.ts", new Set([me.toLowerCase()])),
      ).toEqual([]);
    });
  });

  test("says nothing about a folder nobody has filed against", () => {
    ground();
    withStore(`${base}.db`, (store) => {
      expect(
        lineageLines(store, VEGA_UUID, "src/render/sky.ts", new Set(["ambrose"])),
      ).toEqual([]);
    });
  });

  test("offers ONE lineage, not a menu", () => {
    ground();
    withStore(`${base}.db`, (store) => {
      for (const who of ["alder", "akira"]) {
        store.diary.write(`uuid-${who}`, who, {
        title: `${who} was here too`,
        body: "",
        topic: "water",
        tags: [],
        kind: "finding",
        scope: "src/sim/water",
      }, Date.now());
      }
      const lines = lineageLines(
        store,
        VEGA_UUID,
        "src/sim/water/flow.ts",
        new Set(["ambrose", "alder", "akira"]),
      );
      // A menu at edit time is what gets scrolled past, taking the diary
      // findings above it along with it.
      expect(lines).toHaveLength(1);
    });
  });
});

describe("the column survives a live db", () => {
  test("a db created BEFORE lineage still opens, and old rows stay readable", () => {
    // A fresh db builds the column, so the migration is a no-op and every test
    // passes while every LIVE db throws "no such column" — the exact failure
    // this tool shipped once with `work.plan_doc`.
    withPersonal((p) => {
      p.remember(HOPPER_UUID, "hopper", ok("written before"), "Traffic", false, 1, "hopper");
    });
    withPersonal((p) => {
      (p as unknown as { db: { exec(q: string): void } }).db.exec(
        `DROP INDEX IF EXISTS memories_lineage; ALTER TABLE memories DROP COLUMN lineage`,
      );
    });
    withPersonal((p) => {
      // Migrated on reopen: the old row survives with an empty lineage, and a
      // new write under a lineage works.
      expect(p.get(1)?.title).toBe("written before");
      expect(p.get(1)?.lineage).toBe("");
      p.remember(VEGA_UUID, "vega", ok("written after"), "Traffic", false, 2, "vega");
      expect(p.forLineage("vega", "Traffic").length).toBe(1);
    });
  });
});
