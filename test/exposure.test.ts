/**
 * Injection suppression and the omission inbox, through the STORE.
 *
 * WHY THIS FILE EXISTS. `test/injection.test.ts` proves the pure allocator
 * suppresses an unchanged candidate when handed a `seen` map. It cannot prove
 * anybody hands it one — and for a while nobody did: `pack` defaults `seen` to
 * an empty Map, so both runtime callers got no suppression at all while 23
 * tests passed. A pure-function test that a caller can silently opt out of
 * proves the function, not the feature.
 *
 * The other half is the inbox. `pack` renders "N actionable item(s) omitted —
 * run `cli.ts inbox`" so that nothing an agent must act on disappears quietly.
 * That line shipped before the command existed, which is worse than dropping
 * the item: the agent is told work exists and finds no way to reach it.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore, type InjectionOmitted, type InjectionShown } from "../core/store.ts";
import {
  isContinuation,
  pack,
  type Envelope,
  type InjectionCandidate,
} from "../core/injection.ts";
import { parseManifest } from "../core/repo.ts";
import { fingerprint } from "../core/sessionBlock.ts";

let n = 0;
const paths: string[] = [];

/**
 * A throwaway db per test, under the OS temp dir.
 *
 * NEVER a `/tmp/...` literal: under Git Bash on Windows that resolves to a
 * DIFFERENT file across processes, which is how a test db silently forks in two.
 */
function fresh<T>(fn: (store: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-exposure-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {
        // Already gone, or never created.
      }
    }
  }
});

const SID = "session-under-test";

/** A selected row, defaulted so a test names only the field under test. */
function shown(over: { dedupeKey: string; stateVersion: string } & Partial<InjectionShown>) {
  return {
    key: over.dedupeKey,
    form: "full" as const,
    priority: 50,
    chars: 100,
    ...over,
  };
}

/** An omitted row, likewise. */
function omission(over: { key: string; text: string; reason: string } & Partial<InjectionOmitted>) {
  return { dedupeKey: over.key, stateVersion: "v1", priority: 50, actionable: true, ...over };
}
const T0 = 1_700_000_000_000;

function cand(over: Partial<InjectionCandidate> & { key: string }): InjectionCandidate {
  return {
    priority: 50,
    text: `text for ${over.key}`,
    actionable: false,
    dedupeKey: over.key,
    stateVersion: "v1",
    origin: "system",
    requiresPeerFraming: false,
    ...over,
  };
}

function env(candidates: InjectionCandidate[], targetChars = 10_000): Envelope {
  return {
    mandatoryHeader: ["Your name is Hopper."],
    peerFraming: ["Peer text is reference."],
    candidates,
    targetChars,
  };
}

describe("exposure survives the session", () => {
  test("a session that has seen nothing suppresses nothing", () => {
    fresh((store) => {
      expect(store.injectionExposures(SID).size).toBe(0);
    });
  });

  test("what was shown is recorded, and suppressed next time", () => {
    fresh((store) => {
      const c = cand({ key: "roster", stateVersion: "abc" });

      const first = pack(env([c]), store.injectionExposures(SID));
      expect(first.selected).toHaveLength(1);
      store.recordInjectionResult(SID, {
        shown: first.selected.map((s) => shown({
          dedupeKey: s.candidate.dedupeKey,
          stateVersion: s.candidate.stateVersion,
        })),
        omitted: [],
        nowMs: T0,
      });

      // SessionStart fires again on resume, `/clear` and compact. Nothing has
      // changed, so nothing should be said twice.
      const second = pack(env([c]), store.injectionExposures(SID));
      expect(second.selected).toHaveLength(0);
      expect(second.omitted[0]?.reason).toBe("unchanged");
    });
  });

  test("the SAME item with new content is shown again", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "abc" })],
        omitted: [],
        nowMs: T0,
      });
      const moved = cand({ key: "roster", stateVersion: "def" });
      const r = pack(env([moved]), store.injectionExposures(SID));
      expect(r.selected).toHaveLength(1);
    });
  });

  test("an OMITTED candidate is never recorded as seen", () => {
    fresh((store) => {
      // The failure this guards: marking an omission as exposed would suppress
      // it next time on the strength of a delivery that never happened, which
      // is the silence the whole design is trying to prevent.
      const big = cand({ key: "big", text: "z".repeat(9_999) });
      const r = pack(env([big], 100), store.injectionExposures(SID));
      expect(r.selected).toHaveLength(0);
      store.recordInjectionResult(SID, {
        shown: r.selected.map((s) => shown({
          dedupeKey: s.candidate.dedupeKey,
          stateVersion: s.candidate.stateVersion,
        })),
        omitted: [],
        nowMs: T0,
      });
      expect(store.injectionExposures(SID).size).toBe(0);
    });
  });

  test("a compact selection records the CANDIDATE's version, not the compact text", () => {
    fresh((store) => {
      // Otherwise the item reappears every session: the recorded fingerprint
      // would never match the full candidate it is meant to suppress.
      const c = cand({
        key: "ob",
        text: "z".repeat(400),
        compact: "1 item — `cli.ts inbox`",
        stateVersion: "v7",
      });
      const r = pack(env([c], 120), store.injectionExposures(SID));
      expect(r.selected[0]?.form).toBe("compact");
      store.recordInjectionResult(SID, {
        shown: r.selected.map((s) => shown({
          dedupeKey: s.candidate.dedupeKey,
          stateVersion: s.candidate.stateVersion,
        })),
        omitted: [],
        nowMs: T0,
      });
      expect(store.injectionExposures(SID).get("ob")).toBe("v7");
    });
  });

  test("exposure is per session, never shared", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "abc" })],
        omitted: [],
        nowMs: T0,
      });
      expect(store.injectionExposures("someone-else").size).toBe(0);
    });
  });

  test("re-showing a changed item leaves ONE row, not two", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "abc" })],
        omitted: [],
        nowMs: T0,
      });
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "def" })],
        omitted: [],
        nowMs: T0 + 1,
      });
      const seen = store.injectionExposures(SID);
      expect(seen.size).toBe(1);
      expect(seen.get("roster")).toBe("def");
    });
  });
});

describe("the inbox holds what did not fit", () => {
  test("nothing omitted, nothing owed", () => {
    fresh((store) => {
      expect(store.injectionOmissions(SID)).toHaveLength(0);
    });
  });

  test("an omitted candidate is retrievable IN FULL", () => {
    fresh((store) => {
      // The point of the promise: the agent gets the whole item, not the
      // one-line pointer it saw instead of it.
      const text = `a real obligation, ${"z".repeat(500)}`;
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: [omission({ key: "ob", text, reason: "no room", stateVersion: "v9" })],
        nowMs: T0,
      });
      const owed = store.injectionOmissions(SID);
      expect(owed).toHaveLength(1);
      expect(owed[0]?.text).toBe(text);
      // WHICH version was withheld, so a key whose content later moves can
      // still say what the agent actually missed.
      expect(owed[0]?.stateVersion).toBe("v9");
    });
  });

  test("the record is REPLACED per session, not appended", () => {
    fresh((store) => {
      // What a session is missing is a current fact. An item that fitted this
      // time is no longer owed, and a growing log would keep offering it.
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: [omission({ key: "a", text: "one", reason: "no room" })],
        nowMs: T0,
      });
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: [omission({ key: "b", text: "two", reason: "no room" })],
        nowMs: T0 + 1,
      });
      const owed = store.injectionOmissions(SID);
      expect(owed.map((o) => o.key)).toEqual(["b"]);
    });
  });

  test("clearing to empty leaves nothing owed", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: [omission({ key: "a", text: "one", reason: "no room" })],
        nowMs: T0,
      });
      store.recordInjectionResult(SID, { shown: [], omitted: [], nowMs: T0 + 1 });
      expect(store.injectionOmissions(SID)).toHaveLength(0);
    });
  });

  test("the count in the block matches what the inbox will hand back", () => {
    fresh((store) => {
      // The number the agent is told, and the number it can actually read, are
      // the same number — otherwise the fallback line is a lie about a lie.
      const big = (k: string) => cand({ key: k, text: "z".repeat(900), actionable: true });
      const r = pack(env([big("a"), big("b")], 200), store.injectionExposures(SID));
      const lost = r.omitted.filter((o) => o.reason === "no room");
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: lost.map((o) =>
          omission({ key: o.candidate.key, text: o.candidate.text, reason: o.reason }),
        ),
        nowMs: T0,
      });
      const claimed = r.lines[r.lines.length - 1] ?? "";
      expect(claimed).toContain(`${lost.length} actionable item(s) omitted`);
      expect(store.injectionOmissions(SID)).toHaveLength(lost.length);
    });
  });

  test("a SUPPRESSED candidate is not owed to the inbox", () => {
    fresh((store) => {
      // It was dropped because the session already has it, which is the
      // opposite of something missing.
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0,
      });
      const r = pack(
        env([cand({ key: "roster", stateVersion: "v1", actionable: true })]),
        store.injectionExposures(SID),
      );
      const lost = r.omitted.filter((o) => o.reason === "no room");
      expect(lost).toHaveLength(0);
      store.recordInjectionResult(SID, { shown: [], omitted: [], nowMs: T0 });
      expect(store.injectionOmissions(SID)).toHaveLength(0);
    });
  });
});

describe("the manifest validates rather than coerces", () => {
  const good = {
    installedAt: T0,
    sourceRevision: "9f1c2b4e5d6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c",
    contentHash: "abc12345",
    schemaVersion: 1,
    featureSetVersion: 1,
    featureSet: ["roster", "stats"],
  };

  test("a well-formed manifest parses", () => {
    expect(parseManifest(good)).toEqual({ ...good, featureSet: ["roster", "stats"] });
  });

  test.each([
    ["not an object", 42],
    ["null", null],
    ["an array", [good]],
    ["a non-numeric timestamp", { ...good, installedAt: "yesterday" }],
    ["NaN by coercion", { ...good, installedAt: Number.NaN }],
    ["a negative timestamp", { ...good, installedAt: -1 }],
    ["an object where a number belongs", { ...good, schemaVersion: {} }],
    ["a fractional schema version", { ...good, schemaVersion: 1.5 }],
    ["a missing revision", { installedAt: T0, schemaVersion: 1, featureSet: [] }],
    ["an empty content hash", { ...good, contentHash: "" }],
    ["a missing content hash", { ...good, contentHash: undefined }],
    ["a non-numeric featureSetVersion", { ...good, featureSetVersion: "1" }],
    ["a missing featureSetVersion", { ...good, featureSetVersion: undefined }],
    ["a non-string in featureSet", { ...good, featureSet: [false, {}, 42] }],
    ["a featureSet that is not an array", { ...good, featureSet: "roster" }],
  ])("rejects %s", (_label, raw) => {
    // Coercion would have turned every one of these into a confident wrong
    // answer to "did this build have the feature?".
    expect(parseManifest(raw)).toBeNull();
  });

  test("an EMPTY sourceRevision is valid — install can run outside a checkout", () => {
    // The one field where empty is a fact rather than corruption: a build with
    // no traceable commit still has to be describable.
    expect(parseManifest({ ...good, sourceRevision: "" })?.sourceRevision).toBe("");
  });

  test("an empty featureSet is valid — a build may claim nothing", () => {
    expect(parseManifest({ ...good, featureSet: [] })?.featureSet).toEqual([]);
  });
});

describe("fingerprints frame their lines", () => {
  test("the same characters regrouped are a DIFFERENT fingerprint", () => {
    // Without a delimiter these feed the hash identical characters in identical
    // order with an identical line count — so a roster whose entries regrouped
    // would read as unchanged and be suppressed.
    expect(fingerprint(["ab", "c"])).not.toBe(fingerprint(["a", "bc"]));
  });

  test("identical input is a stable fingerprint", () => {
    expect(fingerprint(["alpha", "beta"])).toBe(fingerprint(["alpha", "beta"]));
  });

  test("order matters", () => {
    expect(fingerprint(["alpha", "beta"])).not.toBe(fingerprint(["beta", "alpha"]));
  });
});

describe("exposure is bounded by the context, not the session row", () => {
  test("only `resume` continues a context", () => {
    // MEASURED, 2026-08-02: 19 identity injections after one compact boundary
    // in this tool's own transcript, under an unchanged session_id. The row
    // survives; the conversation does not.
    expect(isContinuation("resume")).toBe(true);
    for (const source of ["startup", "clear", "compact", "fork", undefined]) {
      expect(isContinuation(source)).toBe(false);
    }
  });

  test("a fresh context generation forgets what the old one saw", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0,
      });
      expect(store.injectionExposures(SID).size).toBe(1);

      // What `/clear` and compact do: same id, wiped context.
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "diary", stateVersion: "d1" })],
        omitted: [],
        nowMs: T0 + 1,
        clearFirst: true,
      });
      const seen = store.injectionExposures(SID);
      expect(seen.size).toBe(1);
      expect(seen.has("roster")).toBe(false);
    });
  });

  test("clearInjectionExposures empties the session's record", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0,
      });
      store.clearInjectionExposures(SID);
      expect(store.injectionExposures(SID).size).toBe(0);
    });
  });
});

describe("one packed block is one transaction", () => {
  test("exposures and omissions land together", () => {
    fresh((store) => {
      // Two calls were two transactions, and a failure between them marked
      // content delivered whose inbox was empty — the exact disappearance this
      // feature exists to prevent.
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [omission({ key: "ob", text: "the full obligation", reason: "no room" })],
        nowMs: T0,
      });
      expect(store.injectionExposures(SID).get("roster")).toBe("v1");
      expect(store.injectionOmissions(SID)[0]?.text).toBe("the full obligation");
    });
  });

  test("a later block replaces the previous omissions", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: [omission({ key: "a", text: "one", reason: "no room" })],
        nowMs: T0,
      });
      store.recordInjectionResult(SID, { shown: [], omitted: [], nowMs: T0 + 1 });
      expect(store.injectionOmissions(SID)).toHaveLength(0);
    });
  });
});

describe("only actionable omissions are owed", () => {
  test("the inbox holds what the block's count promised, and no more", () => {
    // The hook filters on `actionable`; the fallback line counts on it too. A
    // mismatch would advertise "1 actionable item" and hand back three blocks
    // of dropped help text.
    const big = (k: string, actionable: boolean) =>
      cand({ key: k, text: "z".repeat(900), actionable });
    const r = pack(
      env([big("ob", true), big("help-a", false), big("help-b", false)], 200),
      new Map(),
    );
    const lostAll = r.omitted.filter((o) => o.reason === "no room");
    const owed = lostAll.filter((o) => o.candidate.actionable);
    expect(lostAll).toHaveLength(3);
    expect(owed).toHaveLength(1);

    const claimed = r.lines[r.lines.length - 1] ?? "";
    expect(claimed).toContain("1 actionable item(s) omitted");

    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: owed.map((o) =>
          omission({ key: o.candidate.key, text: o.candidate.text, reason: o.reason }),
        ),
        nowMs: T0,
      });
      const back = store.injectionOmissions(SID);
      expect(back).toHaveLength(1);
      expect(back[0]?.key).toBe("ob");
    });
  });
});

describe("injection state is pruned", () => {
  test("rows older than the horizon go; newer ones stay", () => {
    fresh((store) => {
      store.recordInjectionResult("old", {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [omission({ key: "ob", text: "x", reason: "no room" })],
        nowMs: T0,
      });
      store.recordInjectionResult("new", {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0 + 10_000,
      });
      // A horizon that covers the newer row and not the older one.
      store.pruneInjectionState(T0 + 10_000, 5_000);
      expect(store.injectionExposures("old").size).toBe(0);
      expect(store.injectionOmissions("old")).toHaveLength(0);
      expect(store.injectionExposures("new").size).toBe(1);
    });
  });
});

describe("the ledger records which candidates a delivery contained", () => {
  test("a delivery records form, rank and size per candidate", () => {
    fresh((store) => {
      // Suppression state cannot answer this: it keeps one latest-version row
      // per key and is dropped whenever the context is wiped, so "what was this
      // agent shown an hour ago" had no row to read.
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "r1", priority: 90, chars: 76 })],
        omitted: [omission({ key: "ob", text: "z".repeat(900), reason: "no room" })],
        nowMs: T0,
      });
      const history = store.injectionHistory(SID);
      expect(history).toHaveLength(2);

      const sel = history.find((h) => h.outcome === "selected");
      expect(sel?.key).toBe("roster");
      expect(sel?.stateVersion).toBe("r1");
      expect(sel?.form).toBe("full");
      expect(sel?.priority).toBe(90);
      expect(sel?.chars).toBe(76);

      const drop = history.find((h) => h.outcome === "omitted");
      expect(drop?.key).toBe("ob");
      expect(drop?.reason).toBe("no room");
      expect(drop?.chars).toBe(900);
    });
  });

  test("a compact delivery is distinguishable from a full one", () => {
    fresh((store) => {
      // "It was shown the roster" and "it was shown one line saying a roster
      // exists" are different facts, and only one of them explains a confused
      // agent.
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "recent", stateVersion: "x", form: "compact", chars: 40 })],
        omitted: [],
        nowMs: T0,
      });
      expect(store.injectionHistory(SID)[0]?.form).toBe("compact");
    });
  });

  test("the ledger APPENDS while suppression state is replaced", () => {
    fresh((store) => {
      for (const v of ["v1", "v2", "v3"]) {
        store.recordInjectionResult(SID, {
          shown: [shown({ dedupeKey: "roster", stateVersion: v })],
          omitted: [],
          nowMs: T0 + Number(v.slice(1)),
        });
      }
      // One live suppression row, three deliveries of history.
      expect(store.injectionExposures(SID).size).toBe(1);
      expect(store.injectionHistory(SID)).toHaveLength(3);
    });
  });

  test("a wiped context clears suppression but KEEPS the history", () => {
    fresh((store) => {
      // `/clear` means "say it all again", not "it was never said". Dropping
      // the ledger too would erase the record of a delivery that happened.
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0,
      });
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0 + 1,
        clearFirst: true,
      });
      expect(store.injectionExposures(SID).size).toBe(1);
      expect(store.injectionHistory(SID)).toHaveLength(2);
    });
  });

  test("newest delivery first, and history is per session", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "old", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0,
      });
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "new", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0 + 5_000,
      });
      expect(store.injectionHistory(SID)[0]?.key).toBe("new");
      expect(store.injectionHistory("elsewhere")).toHaveLength(0);
    });
  });

  test("the ledger is pruned on the same horizon as the rest", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0,
      });
      store.pruneInjectionState(T0 + 10_000, 5_000);
      expect(store.injectionHistory(SID)).toHaveLength(0);
    });
  });
});

describe("the ledger records EVERY outcome, the inbox only what is owed", () => {
  test("duplicate and unchanged omissions reach history but never the inbox", () => {
    fresh((store) => {
      // The filter that fed both consumers was the inbox's, so `duplicate` and
      // `unchanged` never reached the record at all — and "why was this agent
      // never told?" is most often answered by `unchanged`, the outcome least
      // likely to be there.
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: [
          omission({ key: "dup", text: "x", reason: "duplicate" }),
          omission({ key: "same", text: "y", reason: "unchanged" }),
          omission({ key: "chatter", text: "z", reason: "no room", actionable: false }),
          omission({ key: "ob", text: "w", reason: "no room", actionable: true }),
        ],
        nowMs: T0,
      });
      const reasons = store.injectionHistory(SID).map((h) => h.reason).sort();
      expect(reasons).toEqual(["duplicate", "no room", "no room", "unchanged"]);
      // Only the actionable no-room one is OWED.
      expect(store.injectionOmissions(SID).map((o) => o.key)).toEqual(["ob"]);
    });
  });

  test("a suppressed candidate is history, not a debt", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [],
        omitted: [omission({ key: "roster", text: "x", reason: "unchanged", actionable: true })],
        nowMs: T0,
      });
      expect(store.injectionHistory(SID)).toHaveLength(1);
      expect(store.injectionOmissions(SID)).toHaveLength(0);
    });
  });
});

describe("one packed block is one delivery", () => {
  test("every row from a block shares an id", () => {
    fresh((store) => {
      store.recordInjectionResult(SID, {
        shown: [
          shown({ dedupeKey: "roster", stateVersion: "v1" }),
          shown({ dedupeKey: "diary", stateVersion: "v1" }),
        ],
        omitted: [omission({ key: "ob", text: "x", reason: "no room" })],
        nowMs: T0,
      });
      const ids = new Set(store.injectionHistory(SID).map((h) => h.deliveryId));
      expect(ids.size).toBe(1);
    });
  });

  test("two blocks in the SAME millisecond stay separate", () => {
    fresh((store) => {
      // Grouping by `(session_id, ts_ms)` merged these into one delivery and
      // reported a candidate list that was never injected together.
      for (const v of ["v1", "v2"]) {
        store.recordInjectionResult(SID, {
          shown: [shown({ dedupeKey: "roster", stateVersion: v })],
          omitted: [],
          nowMs: T0,
        });
      }
      const history = store.injectionHistory(SID);
      expect(history).toHaveLength(2);
      expect(new Set(history.map((h) => h.deliveryId)).size).toBe(2);
      // Newest delivery first, independent of the identical timestamps.
      expect(history[0]?.stateVersion).toBe("v2");
    });
  });

  test("delivery ids are unique across sessions", () => {
    fresh((store) => {
      store.recordInjectionResult("a", {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0,
      });
      store.recordInjectionResult("b", {
        shown: [shown({ dedupeKey: "roster", stateVersion: "v1" })],
        omitted: [],
        nowMs: T0,
      });
      const a = store.injectionHistory("a")[0]?.deliveryId;
      const b = store.injectionHistory("b")[0]?.deliveryId;
      expect(a).not.toBe(b);
    });
  });
});
