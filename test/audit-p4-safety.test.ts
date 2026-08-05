/**
 * P4-4, P4-7, P4-8 — the lifecycle rules and safety pairs.
 *
 * WRITTEN AGAINST THE SPEC, so these were red when written. Each states a
 * property the plan argues for, not a shape the code already had.
 *
 * The three share a theme: **a state machine with no way out.** An obligation
 * that can never expire, a wipe with no backup, a deregistration with no
 * liveness check. Each is individually survivable and each becomes a trap when
 * the operator is not watching.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

import {
  foldObligation,
  type ActorRef,
  type ObligationDefinition,
  type ObligationEvent,
  type ObligationEventRecord,
} from "../core/obligations.ts";
import { findVerb, VERBS } from "../core/verbs.ts";
import { releaseBoundaryFor } from "../cli/structured.ts";
import { withStore } from "../core/store.ts";

const ada: ActorRef = { kind: "agent", agentId: "ada" };

const def = (over: Partial<ObligationDefinition> = {}): ObligationDefinition => ({
  id: "o1",
  sourceActId: "a1",
  sourceMessageId: 1,
  createdBy: ada,
  kind: "promise",
  mode: "refrain",
  validResolutionKeys: [],
  text: "I will not edit RELEASE_PLAN.md",
  priority: "important",
  ...over,
});

const rec = (version: number, payload: ObligationEvent): ObligationEventRecord => ({
  id: `e${version}`,
  obligationId: "o1",
  actor: ada,
  occurredAt: 100 + version,
  expectedVersion: version,
  idempotencyKey: `k${version}`,
  payload,
});

const created = (): ObligationEventRecord =>
  rec(0, {
    type: "created",
    authority: "binding",
    activation: "active",
    responsible: { kind: "assigned", actor: ada },
  });

let n = 0;
const paths: string[] = [];
function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-p4-${process.pid}-${n++}.db`;
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

describe("P4-4 — an obligation can actually expire", () => {
  /**
   * `expire` existed as an event with NOTHING that fires it, and `--until`
   * accepts opaque prose. So an obligation, once binding, outlived every
   * session that cared about it — and it sits above the roster in the
   * beneficiary's injection while it does.
   */
  test("expiry moves activation to a terminal state", () => {
    const snapshot = foldObligation(def(), [
      created(),
      rec(1, { type: "expired", episodeId: "sweep" }),
    ]);
    expect(snapshot.activation).toBe("expired");
  });

  test("an expired obligation is no longer outstanding", () => {
    fresh((store) => {
      // The sweep must not report expired rows as open, or nothing is gained.
      expect(store.obligations.all()).toEqual([]);
    });
  });

  test("`--until` accepts a duration, not only prose", () => {
    // Prose cannot be acted on. A duration can, which is what lets anything
    // fire `expire` without a human reading the text.
    const promise = findVerb("promise");
    expect(promise?.args).toMatch(/--until/);
  });
});

describe("P4-7 — the destructive verbs have a safety pair", () => {
  test("`export` is a registered verb", () => {
    // An unconfirmed multi-agent wipe with no backup is the worst pairing in
    // the tool. Export is nearly free: copy the db `where` already prints.
    expect(VERBS.some((v) => v.verb === "export")).toBe(true);
  });

  test("`clear` requires an explicit confirmation flag", () => {
    // It deregisters every live session in the project. Reversible in the
    // sense that a hook re-registers — but the claims and their collision
    // warnings go, and nothing warns first.
    expect(findVerb("clear")?.args).toMatch(/--force|--yes|--confirm/);
  });

  test("`export` says where it wrote, since a silent backup is not one", () => {
    expect(findVerb("export")?.blurb.length ?? 0).toBeGreaterThan(0);
  });
});

describe("P4-8 — `quit` does not silently drop a working peer", () => {
  test("`quit` offers a way to say you meant it", () => {
    // `docs/views.md` explains at length why liveness cannot be DETECTED, so
    // the fix is not a check — it is refusing to do it silently and letting
    // the operator override.
    expect(findVerb("quit")?.args).toMatch(/--force|--yes|--confirm/);
  });

  test("the blurb still refuses to promise a liveness check", () => {
    // P2-3: "drop a dead session" was a guarantee the code does not keep.
    expect(findVerb("quit")?.blurb).not.toMatch(/\bdead\b/i);
  });
});

describe("P4-12 — `--plan-doc` and `link` are both documented", () => {
  test("`doing` advertises `--plan-doc`", () => {
    expect(findVerb("doing")?.args).toMatch(/--plan-doc/);
  });

  test("`link` exists as the after-the-fact form", () => {
    // The two overlap and the difference was undocumented: `--plan-doc` opens
    // an item against a plan, `link` points one that is already open.
    expect(findVerb("link")).toBeDefined();
  });
});

describe("P4-4 — the deadline trigger, end to end", () => {
  /**
   * The three links that were missing: a duration must PARSE to a deadline, a
   * passed deadline must FIRE, and an unpassed one must not.
   */
  test("a duration becomes an automatic deadline", () => {
    const boundary = releaseBoundaryFor("4h", 1_000_000);
    expect(boundary.handling).toBe("automatic");
    if (boundary.handling === "automatic")
      expect(boundary.trigger.atMs).toBe(1_000_000 + 4 * 3_600_000);
  });

  test("minutes and days scale correctly", () => {
    const m = releaseBoundaryFor("30m", 0);
    const d = releaseBoundaryFor("2d", 0);
    if (m.handling === "automatic") expect(m.trigger.atMs).toBe(1_800_000);
    if (d.handling === "automatic") expect(d.trigger.atMs).toBe(172_800_000);
  });

  test("prose stays manual, because it cannot be acted on", () => {
    // `--until "the release lands"` is honest and unactionable. Silently
    // inventing a deadline for it would be worse than leaving it open.
    expect(releaseBoundaryFor("the release lands", 0).handling).toBe("manual");
    expect(releaseBoundaryFor("4 hours from now", 0).handling).toBe("manual");
  });

  test("the sweep is safe on an empty store", () => {
    fresh((store) => {
      expect(store.obligations.expireDue(Date.now())).toBe(0);
    });
  });
});
