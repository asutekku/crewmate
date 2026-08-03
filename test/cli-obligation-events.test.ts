import { describe, expect, test } from "bun:test";

import type { ObligationSnapshot } from "../core/obligations.ts";
import {
  buildClearanceEvent,
  buildObligationEvent,
  parseVersion,
} from "../cli/obligation-events.ts";
import { parseStructuredFile } from "../cli/obligations.ts";

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
    expect(parseStructuredFile(null).ok).toBeFalse();
    expect(parseStructuredFile({ acts: {} }).ok).toBeFalse();
    expect(parseStructuredFile({ acts: [], dependencies: {} }).ok).toBeFalse();
    expect(
      parseStructuredFile({ acts: [], idempotencyKey: 42 }).ok,
    ).toBeFalse();
  });

  test("returns typed input only after top-level validation", () => {
    expect(
      parseStructuredFile({
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
});
