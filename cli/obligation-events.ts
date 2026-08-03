import type {
  ActorRef,
  ClearanceEvent,
  ObligationEvent,
  ObligationSnapshot,
  ResponsibleActorRef,
} from "../core/obligations.ts";
import {
  CLEARANCE_COMMAND_EVENTS,
  OBLIGATION_COMMAND_EVENTS,
} from "../core/obligations.ts";
import { failure, success, type Result } from "./result.ts";

export interface ObligationEventInput {
  readonly id: string;
  readonly eventName: string;
  readonly reason?: string;
  readonly resolution?: string;
  readonly replacement?: string;
  readonly episode?: string;
  readonly to?: ActorRef;
}

export function parseVersion(raw: string, fallback: number): Result<number> {
  if (raw === "") return success(fallback);
  const version = Number(raw);
  return Number.isInteger(version) && version >= 0
    ? success(version)
    : failure("version must be a non-negative integer");
}

function responsible(
  actor: ActorRef | undefined,
): ResponsibleActorRef | undefined {
  return actor?.kind === "agent" || actor?.kind === "operator"
    ? actor
    : undefined;
}

/** Builds and validates a domain event without performing database work. */
export function buildObligationEvent(
  input: ObligationEventInput,
  snapshot: ObligationSnapshot,
): Result<ObligationEvent> {
  const reason = input.reason || undefined;
  const eventName = OBLIGATION_COMMAND_EVENTS.find((name) => name === input.eventName);
  if (!eventName) return failure(`unknown obligation event ${input.eventName}`);
  switch (eventName) {
    case "accept":
      return success({ type: "accepted" });
    case "decline":
      return success({ type: "declined", reason });
    case "counter":
      return input.replacement
        ? success({ type: "countered", replacementId: input.replacement })
        : failure("counter requires --replacement <id>");
    case "withdraw":
      return success({ type: "withdrawn", reason });
    case "cancel":
      return success({
        type: "cancelled",
        reason: input.reason || "cancelled explicitly",
      });
    case "fulfil":
      return success({
        type: "fulfilled",
        resolutionKey: input.resolution || undefined,
      });
    case "violate":
      return success({ type: "violated" });
    case "activate":
      return success({
        type: "activated",
        trigger: { kind: "obligation_resolved", obligationId: input.id },
      });
    case "release":
      return success({
        type: "released",
        why: input.reason || "released explicitly",
      });
    case "expire":
      return success({
        type: "expired",
        episodeId: input.episode || "operator",
      });
    case "relinquish":
      return snapshot.currentResponsible.kind === "assigned"
        ? success({
            type: "relinquished",
            from: snapshot.currentResponsible.actor,
            reason,
          })
        : failure("obligation is unassigned");
    case "assign": {
      const to = responsible(input.to);
      return to
        ? success({ type: "assigned", to })
        : failure("assign requires --to <agent>");
    }
    case "reassign":
    case "return": {
      const to = responsible(input.to);
      if (snapshot.currentResponsible.kind !== "assigned" || !to) {
        return failure(`${eventName} requires assigned owner and --to`);
      }
      return eventName === "return"
        ? success({
            type: "returned",
            from: snapshot.currentResponsible.actor,
            to,
          })
        : success({
            type: "reassigned",
            from: snapshot.currentResponsible.actor,
            to,
          });
    }
  }
}

export function buildClearanceEvent(
  eventName: string,
  reason: string,
): Result<Exclude<ClearanceEvent, { type: "granted" }>> {
  const parsed = CLEARANCE_COMMAND_EVENTS.find((name) => name === eventName);
  if (!parsed) return failure(`unknown clearance event ${eventName}`);
  switch (parsed) {
    case "revoke":
      return success({ type: "revoked", reason: reason || undefined });
    case "expire":
      return success({ type: "expired", reason: reason || "expired explicitly" });
  }
}
