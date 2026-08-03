import { describe, expect, test } from "bun:test";

import type { ObligationSnapshot } from "../core/obligations.ts";
import {
  buildClearanceEvent,
  buildObligationEvent,
  parseVersion,
} from "../cli/obligation-events.ts";
import { decodeStructuredFile } from "../cli/structured-json.ts";

const assigned: ObligationSnapshot = {
  obligationId: "obligation-1",
  authority: "binding",
  activation: "active",
  currentResponsible: {
    kind: "assigned",
    actor: { kind: "agent", agentId: "agent-1" },
  },
  version: 3,
  lastEventId: "event-3",
};

describe("obligation CLI domain construction", () => {
  test.each(["NaN", "1.5", "-1", "Infinity"])(
    "rejects invalid version %s before persistence",
    (raw) => {
      expect(parseVersion(raw, 3)).toEqual({
        ok: false,
        error: "version must be a non-negative integer",
      });
    },
  );

  test("accepts zero and uses the snapshot version only when omitted", () => {
    expect(parseVersion("0", 3)).toEqual({ ok: true, value: 0 });
    expect(parseVersion("", 3)).toEqual({ ok: true, value: 3 });
  });

  test("constructs events without a store dependency", () => {
    expect(
      buildObligationEvent(
        { id: "obligation-1", eventName: "relinquish", reason: "handoff" },
        assigned,
      ),
    ).toEqual({
      ok: true,
      value: {
        type: "relinquished",
        from: { kind: "agent", agentId: "agent-1" },
        reason: "handoff",
      },
    });
    expect(buildClearanceEvent("expire", "")).toEqual({
      ok: true,
      value: { type: "expired", reason: "expired explicitly" },
    });
  });
});

describe("structured JSON boundary", () => {
  test("validates every consumed top-level field", () => {
    expect(decodeStructuredFile(null).ok).toBeFalse();
    expect(decodeStructuredFile({ acts: {} }).ok).toBeFalse();
    expect(decodeStructuredFile({ acts: [], dependencies: {} }).ok).toBeFalse();
    expect(
      decodeStructuredFile({ acts: [], idempotencyKey: 42 }).ok,
    ).toBeFalse();
  });

  test("returns typed input only after top-level validation", () => {
    expect(
      decodeStructuredFile({
        acts: [{ key: "request", type: "request", text: "review" }],
        dependencies: [],
        idempotencyKey: "batch-1",
      }),
    ).toEqual({
      ok: true,
      value: {
        acts: [{ key: "request", type: "request", text: "review" }],
        dependencies: [],
        idempotencyKey: "batch-1",
      },
    });
  });

  test("validates nested acts, dependencies, conditions, and canonical enums", () => {
    expect(
      decodeStructuredFile({
        acts: [
          {
            key: "promise",
            type: "promise",
            text: "ship it",
            mode: "perform",
            priority: "urgent",
            condition: {
              text: "after step two",
              handling: "automatic",
              trigger: {
                kind: "work_step_completed",
                workId: "work-1",
                step: 2,
              },
            },
          },
          {
            key: "request",
            type: "request",
            text: "review it",
          },
        ],
        dependencies: [
          {
            sourceKey: "promise",
            targetKey: "request",
            effect: "activate",
          },
        ],
      }).ok,
    ).toBeTrue();
  });

  test.each([
    {
      acts: [{ key: "x", type: "promise", text: "x", mode: "perhaps" }],
    },
    {
      acts: [{ key: "x", type: "handoff", text: "x", subject: 12 }],
    },
    {
      acts: [
        {
          key: "x",
          type: "promise",
          text: "x",
          mode: "perform",
          condition: {
            text: "after step",
            handling: "automatic",
            trigger: { kind: "work_step_completed", workId: "w", step: 1.5 },
          },
        },
      ],
    },
    {
      acts: [{ key: "x", type: "question", text: "x", surprise: true }],
    },
    {
      acts: [{ key: "x", type: "question", text: "x" }],
      dependencies: [{ sourceKey: "x", targetKey: "y", effect: "eventually" }],
    },
  ])("rejects malformed complete structures %#", (value) => {
    expect(decodeStructuredFile(value).ok).toBeFalse();
  });
});
