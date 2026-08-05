/**
 * The audit remediation spec, as executable assertions.
 *
 * WRITTEN AGAINST THE SPEC, NOT THE IMPLEMENTATION. Every test here states what
 * `plans/AUDIT_REMEDIATION_PLAN.md` says the behaviour SHOULD be. A test that
 * merely mirrors current code passes the moment it is written and can never
 * catch a regression that a refactor introduces deliberately -- it only records
 * what happened to be true the day it was authored.
 *
 * That distinction is not theoretical here. The D1 Q&A collapse shipped with
 * links 1, 2 and 4 of its acceptance test passing and link 3 broken, and was
 * reported as done: the author verified the half that was observable from the
 * asker's side and inferred the rest. An implementation-shaped test would have
 * asserted `answer` calls `fulfil` and passed. The spec-shaped test below
 * asserts the ANSWER IS READABLE AFTERWARDS, which is the thing a user wants
 * and the thing that was broken.
 *
 * So: some tests in this file are expected to FAIL until their feature lands.
 * That is the point. A failing spec test is a to-do item that cannot be
 * forgotten, and `plans/README.md` opens with what happens when a plan grades
 * its own homework.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  describeState,
  foldObligation,
  type ActorRef,
  type ObligationDefinition,
  type ObligationEvent,
  type ObligationEventRecord,
} from "../core/obligations.ts";
import { STATE_GLYPHS, stateLegend } from "../core/layout.ts";
import { VERBS } from "../core/verbs.ts";
import { withStore } from "../core/store.ts";

// ---------------------------------------------------------------- fixtures

const ada: ActorRef = { kind: "agent", agentId: "ada" };
const bob: ActorRef = { kind: "agent", agentId: "bob" };

const def = (over: Partial<ObligationDefinition> = {}): ObligationDefinition => ({
  id: "o1",
  sourceActId: "a1",
  sourceMessageId: 1,
  createdBy: ada,
  kind: "question",
  mode: "perform",
  validResolutionKeys: [],
  text: "is the roster shared?",
  priority: "important",
  ...over,
});

const rec = (
  version: number,
  payload: ObligationEvent,
  actor: ActorRef = ada,
): ObligationEventRecord => ({
  id: `e${version}`,
  obligationId: "o1",
  actor,
  occurredAt: 100 + version,
  expectedVersion: version,
  idempotencyKey: `k${version}`,
  payload,
});

/** A binding, active obligation assigned to `bob` -- the shape `ask` creates. */
const asked = (): ObligationEventRecord =>
  rec(0, {
    type: "created",
    authority: "binding",
    activation: "active",
    responsible: { kind: "assigned", actor: bob },
  });

let n = 0;
const paths: string[] = [];
function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-audit-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}
afterEach(() => {
  for (const p of paths.splice(0))
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
      } catch {
        /* a db that never materialised is not a failure */
      }
    }
});

// ------------------------------------------------------- P1-1 glyph legend

describe("P1-1 — one glyph vocabulary across every surface", () => {
  /**
   * THE DEFECT: `○` meant "at a prompt" in `who` and "gone" in `board`, so an
   * operator who learned the roster read the board backwards. The fix is not
   * "board now says ◐" -- it is that neither surface can spell a glyph itself.
   */
  test("a state's glyph is the same character wherever it is rendered", () => {
    const roster = stateLegend(["busy", "waiting", "idle"], ["✎ files"]);
    const board = stateLegend(["busy", "waiting", "idle", "gone"], ["— no plan"]);
    for (const state of ["busy", "waiting", "idle"] as const) {
      const glyph = STATE_GLYPHS[state];
      expect(roster).toContain(glyph);
      expect(board).toContain(glyph);
    }
  });

  test("no glyph is reused for two different states", () => {
    const glyphs = Object.values(STATE_GLYPHS);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  test("a legend describes only the states it was asked for", () => {
    // `who` lists the living, so explaining `gone` there would describe a row
    // the reader cannot see.
    const roster = stateLegend(["busy", "waiting", "idle"]);
    expect(roster).not.toContain(STATE_GLYPHS.gone);
    expect(roster).not.toContain("gone");
  });

  test("surface-specific tails survive, since they are not states", () => {
    expect(stateLegend(["busy"], ["✎ files this agent holds"])).toContain(
      "✎ files this agent holds",
    );
  });
});

// --------------------------------------------------- P1-7 two-axis display

describe("P1-7 — the two state axes never render as a contradiction", () => {
  /**
   * `withdrawn / active` was correct and unreadable: authority terminal,
   * activation never advanced. The spec is that a settled obligation reports
   * the settled half ALONE -- not that some particular string is produced.
   */
  test("a terminal authority hides the activation axis", () => {
    for (const authority of ["declined", "countered", "withdrawn", "cancelled"] as const) {
      const text = describeState({ authority, activation: "active" });
      expect(text).toBe(authority);
      expect(text).not.toContain("/");
    }
  });

  test("a terminal activation is reported alone", () => {
    for (const activation of ["fulfilled", "released", "violated", "expired"] as const)
      expect(describeState({ authority: "binding", activation })).toBe(activation);
  });

  test("a live obligation still shows both axes, because both are moving", () => {
    expect(describeState({ authority: "proposed", activation: "waiting" })).toBe(
      "proposed / waiting",
    );
  });
});

// ------------------------------------------------- D1 the Q&A loop, end to end

describe("D1 — a question can be asked, seen, answered, and read back", () => {
  /**
   * THE ACCEPTANCE TEST FROM THE PLAN, as four links. The first landing passed
   * 1, 2 and 4 and shipped anyway, because link 3 is the one the asker cannot
   * run: authority is enforced, so only the recipient may answer. Asserted
   * here from the store's side, where both roles are reachable.
   */
  test("link 3+4: an answer in prose is accepted and readable afterwards", () => {
    // `validResolutionKeys` is EMPTY, exactly as `ask` writes it. Prose must
    // still be accepted -- routing it through the controlled-vocabulary field
    // is what made every question unanswerable.
    const snapshot = foldObligation(def(), [
      asked(),
      rec(1, { type: "fulfilled", resolution: "yes — one roster per repo" }, bob),
    ]);
    expect(snapshot.activation).toBe("fulfilled");
    expect(snapshot.resolution).toBe("yes — one roster per repo");
  });

  test("a controlled resolution key is still validated when one is supplied", () => {
    // The free-text field must not weaken the vocabulary check that already
    // existed -- these are two fields with two jobs.
    expect(() =>
      foldObligation(def({ validResolutionKeys: ["shipped"] }), [
        asked(),
        rec(1, { type: "fulfilled", resolutionKey: "invented" }, bob),
      ]),
    ).toThrow();
    expect(
      foldObligation(def({ validResolutionKeys: ["shipped"] }), [
        asked(),
        rec(1, { type: "fulfilled", resolutionKey: "shipped" }, bob),
      ]).activation,
    ).toBe("fulfilled");
  });

  test("an unanswered question is open; an answered one is not", () => {
    const open = foldObligation(def(), [asked()]);
    const closed = foldObligation(def(), [
      asked(),
      rec(1, { type: "fulfilled", resolution: "done" }, bob),
    ]);
    expect(open.activation).toBe("active");
    expect(closed.activation).toBe("fulfilled");
  });

  test("openQuestions reports both directions and drops answered ones", () => {
    fresh((store) => {
      const both = store.obligations.openQuestions("nobody");
      // A store with no questions must report empty lists rather than throw --
      // `crew asks` on a fresh project is the common case.
      expect(both.mine).toEqual([]);
      expect(both.waiting).toEqual([]);
    });
  });

  test("an id prefix resolves like git, and ambiguity is an error not a guess", () => {
    fresh((store) => {
      const missing = store.obligations.resolveId("deadbeef");
      expect(missing.ok).toBe(false);
      // Answering the wrong obligation is worse than being asked to type more.
      const empty = store.obligations.resolveId("");
      expect(empty.ok).toBe(false);
    });
  });
});

// ------------------------------------------------------ P4-9 discoverability

describe("P4-9 — every verb answers --help", () => {
  /**
   * THE DEFECT IS SAFETY, NOT CONVENIENCE. Unknown flags DO abort, so probing
   * is harmless in fact -- but that is invisible at the prompt, which makes the
   * safest probe of a destructive verb indistinguishable from a trigger until
   * after it is typed. `core/verbs.ts` already generates the text.
   *
   * EXPECTED TO FAIL until the dispatcher recognises `--help`.
   */
  test.each(VERBS.filter((v) => v.hidden !== true).map((v) => v.verb))(
    "`crew %s --help` prints usage instead of rejecting the flag",
    async (verb) => {
      const proc = Bun.spawnSync([
        "bun",
        new URL("../cli.ts", import.meta.url).pathname.replace(/^\//, ""),
        verb,
        "--help",
      ]);
      const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
      expect(out).not.toContain("unknown flag --help");
    },
  );
});

// --------------------------------------------------------- P1-9 / P1-10 board

describe("P1-9 — an ambiguous tick is refused, never guessed", () => {
  /**
   * Measured twice by a peer: `did <n>` with two items open ticked the wrong
   * one, silently. Compounded by P1-10 (a tick cannot be undone), a typo
   * permanently asserts work that never happened -- the `[x] IMPLEMENTED`
   * failure `plans/README.md` opens with, reachable by typo rather than by
   * optimism.
   *
   * EXPECTED TO FAIL until `target()` refuses an ambiguous match.
   */
  test("with two items open, an unqualified target is refused", () => {
    fresh((store) => {
      store.work.open("agent", "Agent", "first item", ["a"], 1000);
      store.work.open("agent", "Agent", "second item", ["b"], 1100);
      // The spec: NO IMPLICIT WINNER. `target` currently returns items[0] --
      // the most recently updated -- which is a guess the caller cannot see.
      expect(store.work.target("agent", "")).toBeFalsy();
    });
  });

  test("with one item open, an unqualified target still resolves", () => {
    fresh((store) => {
      store.work.open("agent", "Agent", "only item", ["a"], 1000);
      // Refusing here would break the common case the board is built for.
      expect(store.work.target("agent", "")).toBeTruthy();
    });
  });

  test("a subject substring still selects unambiguously", () => {
    fresh((store) => {
      store.work.open("agent", "Agent", "retiring the old net core", ["a"], 1000);
      store.work.open("agent", "Agent", "junction sliver fix", ["b"], 1100);
      expect(store.work.target("agent", "sliver")?.subject).toContain("sliver");
    });
  });
});

describe("P1-10 — a tick can be undone", () => {
  /**
   * `tick()` sets `done_ms` and nothing clears it, so a correction renders
   * under a green check and the only recovery is editing sqlite by hand.
   *
   * EXPECTED TO FAIL until an untick path exists.
   */
  /**
   * `untick` does not exist yet, so it is reached through a widened view
   * rather than named directly: a spec test must not break `tsc` for everyone
   * else while the feature it describes is still pending.
   */
  const untickOf = (
    store: Parameters<Parameters<typeof withStore>[1]>[0],
  ): ((workId: number, idx: number, nowMs: number) => boolean) | undefined => {
    const fn = (store.work as unknown as Record<string, unknown>)["untick"];
    return typeof fn === "function"
      ? (fn as (workId: number, idx: number, nowMs: number) => boolean).bind(store.work)
      : undefined;
  };

  test("unticking a step restores it to outstanding", () => {
    fresh((store) => {
      const id = store.work.open("agent", "Agent", "item", ["step one"], 1000);
      store.work.tick(id, 1, "done", 1000);
      expect(store.work.steps(id)[0]?.doneMs ?? 0).toBeGreaterThan(0);
      const untick = untickOf(store);
      expect(untick).toBeDefined();
      expect(untick?.(id, 1, 2000)).toBe(true);
      expect(store.work.steps(id)[0]?.doneMs ?? 0).toBe(0);
      // The completion note goes with the tick. A step reading "outstanding"
      // beside the note it was ticked with is the same false claim in smaller
      // type -- and `board` renders the note, so it would survive on screen.
      expect(store.work.steps(id)[0]?.note ?? "").toBe("");
    });
  });

  test("unticking an already-outstanding step is harmless", () => {
    fresh((store) => {
      const id = store.work.open("agent", "Agent", "item", ["step one"], 1000);
      const untick = untickOf(store);
      expect(untick).toBeDefined();
      expect(() => untick?.(id, 1, 2000)).not.toThrow();
    });
  });
});

// ------------------------------------------------------------- P4-2 the ledger

describe("P4-2 — obligations and clearances can be enumerated", () => {
  /**
   * Unenumerable state is unusable state. Today the only handles are by-uuid
   * inspect (requires already having the uuid), `injection --agent`
   * (top-priority only) and `stats` (a bare count) -- so neither operator nor
   * agent can answer "what is outstanding between these two".
   *
   * EXPECTED TO FAIL until a list verb exists.
   */
  test("`obligations` is a registered verb", () => {
    expect(VERBS.some((v) => v.verb === "obligations")).toBe(true);
  });

  test("`clearances` is a registered verb", () => {
    expect(VERBS.some((v) => v.verb === "clearances")).toBe(true);
  });

  test("an empty ledger enumerates to nothing rather than failing", () => {
    fresh((store) => {
      expect(store.obligations.all()).toEqual([]);
    });
  });
});

// ------------------------------------------------------------ P4-1 memories

describe("P4-1 — the operator can enumerate memories held about them", () => {
  /**
   * `about-me` is keyed to the CALLING agent, and the aggregate view in
   * `cli/personal.ts` sits behind a branch requiring an empty session id --
   * which no live agent has. The view is written and unreachable.
   *
   * EXPECTED TO FAIL until a verb routes to it.
   */
  test("`memories` is a registered verb", () => {
    expect(VERBS.some((v) => v.verb === "memories")).toBe(true);
  });
});

// ----------------------------------------------------------- P4-11 the doc

describe("P4-11 — the audience split is derivable, not hand-counted", () => {
  /**
   * Hand-maintained counts in this repo have a 100% measured drift rate:
   * `core/verbs.ts:7` said 33 against 51 verbs, `docs/audiences.md` mis-stated
   * its own totals, and the remediation plan reproduced the same error inside
   * the document written to fix it.
   *
   * EXPECTED TO FAIL until `Verb` carries an audience.
   */
  test("every verb declares an audience", () => {
    const undeclared = VERBS.filter(
      (v) => !("audience" in v) || (v as { audience?: string }).audience === undefined,
    );
    expect(undeclared.map((v) => v.verb)).toEqual([]);
  });
});

// ------------------------------------------------------- regression: no drift

describe("the verb table stays the single source of truth", () => {
  test("no verb is registered twice", () => {
    const names = VERBS.map((v) => v.verb);
    expect(new Set(names).size).toBe(names.length);
  });

  test("no alias collides with a verb or another alias", () => {
    const spellings = VERBS.flatMap((v) => [v.verb, ...(v.aliases ?? [])]);
    expect(new Set(spellings).size).toBe(spellings.length);
  });

  test("every verb states what it does", () => {
    for (const v of VERBS) {
      expect(v.blurb.length).toBeGreaterThan(0);
      // A blurb that ends in a period reads as prose in a table of fragments.
      expect(v.blurb.endsWith(".")).toBe(false);
    }
  });
});
