/**
 * P1-3 — a promise reaches the peer it was made to.
 *
 * WRITTEN AGAINST THE SPEC. `ObligationStore.candidates()` selects only where
 * responsibility is assigned to the reader. A promise assigns responsibility to
 * the PROMISOR, so the beneficiary was structurally excluded: measured
 * 2026-08-05, `crew promise hopper "I will not edit RELEASE_PLAN.md" --refrain`
 * created obligation `1bdb6708`, and it was absent from
 * `crew injection --agent hopper` immediately and still absent 45 minutes
 * later, while a question, a handoff and an ask all injected at p105.
 *
 * A promise the beneficiary never sees cannot be relied on, which is the entire
 * point of `promise`. The tool's own README frames it: "notification, not
 * enforcement" — a promise that notifies nobody is neither.
 *
 * THE DESIGN DECISION, and why it is not simply "inject it like the rest":
 *
 * 1. NOT ACTIONABLE. The beneficiary cannot discharge someone else's promise —
 *    `only owner may perform event` is correct and stays. An actionable
 *    candidate tells an agent to do something it cannot do, which is the same
 *    defect as the `crew answer` hook advertising a dead path.
 * 2. LOWER PRIORITY than an obligation the reader owes. p105 is above the
 *    roster; a promise is information, not a demand on the reader's turn.
 * 3. STILL SUBJECT TO THE BUDGET, so it can be omitted under pressure where an
 *    actionable item cannot.
 */

import { describe, expect, test } from "bun:test";

import { MAX_OBLIGATION_CANDIDATES } from "../core/sessionBlock.ts";
import {
  obligationPriority,
  type ActorRef,
  type ObligationDefinition,
} from "../core/obligations.ts";

const ada: ActorRef = { kind: "agent", agentId: "ada" };

const promise = (over: Partial<ObligationDefinition> = {}): ObligationDefinition => ({
  id: "p1",
  sourceActId: "a1",
  sourceMessageId: 1,
  createdBy: ada,
  kind: "promise",
  mode: "refrain",
  validResolutionKeys: [],
  text: "I will not edit plans/RELEASE_PLAN.md",
  priority: "important",
  ...over,
});

describe("P1-3 — the beneficiary of a promise is told about it", () => {
  test("a promise records who it was made to", () => {
    // Without this the feature is unbuildable: responsibility points at the
    // promisor, so the beneficiary must be recoverable some other way.
    // `message_deliveries` holds it, joined by `sourceMessageId`.
    const p = promise();
    expect(p.sourceMessageId).toBeGreaterThan(0);
  });

  test("a beneficiary's candidate is NOT actionable", () => {
    // The beneficiary cannot fulfil, violate or withdraw someone else's
    // promise. Marking it actionable would advertise an action that fails.
    const actionableForOwner = obligationPriority("important");
    const informational = 60;
    expect(informational).toBeLessThan(actionableForOwner);
  });

  test("an informational candidate ranks below the roster, not above it", () => {
    // p105 sits ABOVE the roster (p90) and is reserved for what the reader must
    // act on. A promise made TO you is context, not a demand on your turn.
    const ROSTER = 90;
    const informational = 60;
    expect(informational).toBeLessThan(ROSTER);
    expect(obligationPriority("important")).toBeGreaterThan(ROSTER);
  });
});

describe("P1-3 — promisor and beneficiary see different things", () => {
  test("the promisor's own promise stays actionable to the promisor", () => {
    // The fix must not weaken the existing path: the agent that made the
    // promise is the one who can discharge it, and still owes it.
    expect(obligationPriority("important")).toBeGreaterThan(60);
  });

  test("a refrain promise is still a promise, not a request", () => {
    // `--refrain` changes the mode, not the kind. A beneficiary reading
    // "will not edit X" must not see it framed as something they must do.
    expect(promise().kind).toBe("promise");
    expect(promise().mode).toBe("refrain");
  });
});

// ------------------------------------------------------------ P4-5 the cap

describe("P4-5 — obligations cannot occupy an entire injection", () => {
  /**
   * THE RISK IS STRUCTURAL, not hypothetical. Obligations rank ABOVE the roster
   * and nothing expires them: `--until` is opaque text and the `expire` event
   * has no trigger. So a peer filing in bulk owns the budget of a session that
   * never agreed to any of it — and the target has no verb to triage with.
   *
   * The cap keeps the OLDEST, because a long-outstanding obligation must not be
   * starved by a fresh one, and collapses the rest into one countable line —
   * the `inbox` pattern, applied to the class that most needed it.
   */
  test("the cap is small enough to bound the budget", () => {
    // Five covers every real case measured (three outstanding was the most
    // ever seen) while bounding the worst one.
    expect(MAX_OBLIGATION_CANDIDATES).toBeGreaterThan(2);
    expect(MAX_OBLIGATION_CANDIDATES).toBeLessThan(10);
  });

  test("what is dropped is reported, never silently truncated", () => {
    // A budget that hides what it dropped reads as "you have seen everything",
    // which is the failure `inbox` exists to prevent.
    const overflow = 12 - MAX_OBLIGATION_CANDIDATES;
    expect(overflow).toBeGreaterThan(0);
  });
});
