/** Explicit message semantics and durable obligations (COURT_PLAN P2). */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { InjectionCandidate } from "./injection.ts";
import { featureForAct, type FeatureId } from "./features.ts";

export type ActorRef =
  | { kind: "agent"; agentId: string }
  | { kind: "operator" }
  | { kind: "system"; component: string }
  | { kind: "legacy_uncertain"; label: string };
export type ResponsibleActorRef = Extract<
  ActorRef,
  { kind: "agent" | "operator" }
>;
export type Responsibility =
  { kind: "assigned"; actor: ResponsibleActorRef } | { kind: "unassigned" };
export type Priority = "normal" | "important" | "urgent";
export type AuthorityState =
  "proposed" | "binding" | "declined" | "countered" | "withdrawn" | "cancelled";
export type ActivationState =
  "waiting" | "active" | "fulfilled" | "released" | "violated" | "expired";
export type TriggerSpec =
  /**
   * A wall-clock deadline, in epoch milliseconds.
   *
   * THE ONLY TRIGGER NOTHING ELSE HAS TO OBSERVE. Every other kind waits for
   * an event some agent must produce; if that agent never returns, the
   * obligation is immortal — and it sits above the roster in its target's
   * injection while it waits. `--until 4h` is what lets `expire` finally fire.
   */
  | { kind: "deadline"; atMs: number }
  | { kind: "commit_reachable"; commitSha: string; branch: string }
  | { kind: "work_completed"; workId: string }
  | { kind: "work_step_completed"; workId: string; step: number }
  | {
      kind: "obligation_resolved";
      obligationId: string;
      resolutionKey?: string;
    };
export type RelatedEventSpec =
  | { kind: "work_updated"; workId: string }
  | { kind: "obligation_updated"; obligationId: string };
export type ObligationCondition =
  | { text: string; handling: "automatic"; trigger: TriggerSpec }
  | {
      text: string;
      handling: "resurface_on_related_event";
      event: RelatedEventSpec;
    }
  | { text: string; handling: "manual" };
export type CommitmentMode = "perform" | "refrain";
export type CorrectionType =
  "self_erratum" | "peer_correction" | "implementation_correction";
export const PRIORITIES = [
  "normal",
  "important",
  "urgent",
] as const satisfies readonly Priority[];
export const COMMITMENT_MODES = [
  "perform",
  "refrain",
] as const satisfies readonly CommitmentMode[];
export const CORRECTION_TYPES = [
  "self_erratum",
  "peer_correction",
  "implementation_correction",
] as const satisfies readonly CorrectionType[];
export const STRUCTURED_ACT_TYPES = [
  "question",
  "request",
  "promise",
  "handoff",
  "grant",
  "correction",
  "hazard",
] as const;
export const DEPENDENCY_EFFECTS = ["activate", "release"] as const;

/**
 * What was chosen over what, read out of the obligation events rather than
 * stored. There is no `decisions` table and no write path — a decision is a
 * VIEW, so it cannot drift from the events it describes.
 *
 * `chosen` is empty for a plain decline: an option was turned down and nothing
 * replaced it, which is still worth knowing.
 */
export interface Decision {
  obligationId: string;
  decidedBy: ActorRef;
  decidedAtMs: number;
  rejected: string;
  chosen: string;
  chosenObligationId: string;
  rationale: string;
}
export interface ObligationDefinition {
  id: string;
  sourceActId: string;
  sourceMessageId: number;
  createdBy: ActorRef;
  kind: "question" | "request" | "promise" | "handoff" | "unassigned_work";
  mode?: CommitmentMode;
  condition?: ObligationCondition;
  releaseBoundary?: ObligationCondition;
  validResolutionKeys: string[];
  text: string;
  priority: Priority;
}
export type ObligationEvent =
  | {
      type: "created";
      authority: "proposed" | "binding";
      activation: "waiting" | "active";
      responsible: Responsibility;
    }
  | { type: "accepted" }
  | { type: "declined"; reason?: string }
  | { type: "countered"; replacementId: string }
  | { type: "withdrawn"; reason?: string }
  | { type: "cancelled"; reason: string }
  | { type: "relinquished"; from: ResponsibleActorRef; reason?: string }
  | { type: "assigned"; to: ResponsibleActorRef }
  | { type: "reassigned"; from: ResponsibleActorRef; to: ResponsibleActorRef }
  | { type: "returned"; from: ResponsibleActorRef; to: ResponsibleActorRef }
  | { type: "activated"; trigger: TriggerSpec }
  | { type: "released"; why: string }
  | { type: "expired"; episodeId: string }
  // `resolutionKey` is a CONTROLLED VOCABULARY, checked against the
  // obligation's `validResolutionKeys`. `resolution` is FREE TEXT, checked
  // against nothing. The distinction is load-bearing: `crew answer` files
  // prose, and prose put in `resolutionKey` failed validation against an empty
  // vocabulary -- every `ask`-created question was unanswerable. Measured
  // 2026-08-05 by hopper, one hour after the Q&A collapse shipped.
  | {
      type: "fulfilled";
      resolutionKey?: string;
      resolution?: string;
      evidenceMessageId?: number;
    }
  | { type: "violated"; evidenceMessageId?: number };

export const OBLIGATION_COMMAND_EVENTS = [
  "accept", "decline", "counter", "withdraw", "cancel", "fulfil", "violate",
  "activate", "release", "expire", "relinquish", "assign", "reassign", "return",
] as const;
export type ObligationCommandEventName = typeof OBLIGATION_COMMAND_EVENTS[number];
export interface ObligationEventRecord {
  id: string;
  obligationId: string;
  actor: ActorRef;
  occurredAt: number;
  expectedVersion: number;
  idempotencyKey: string;
  payload: ObligationEvent;
}
export interface ObligationSnapshot {
  obligationId: string;
  authority: AuthorityState;
  activation: ActivationState;
  currentResponsible: Responsibility;
  version: number;
  lastEventId: string;
  /**
   * Free-text outcome from the `fulfilled` event, when there was one.
   *
   * ON THE FOLD rather than read from the event log by callers: `crew answer`
   * files prose, and an answer nobody can read back is a message that was
   * accepted and lost. `cli/obligations.ts` is barred from touching
   * `obligations.events(` (see `test/cli-architecture.test.ts`), so current
   * state has to arrive here or not at all.
   */
  resolution?: string;
}
/** One unanswered question, flattened for `asks`. Ids are obligation uuids. */
export interface OpenQuestion {
  readonly id: string;
  readonly text: string;
  readonly askedMs: number;
  /** Conversation id of the asker, or "" when the operator asked. */
  readonly asker: string;
  /** Conversation id of whoever owes the answer, or "" if unassigned. */
  readonly responsible: string;
}
export interface Dependency {
  sourceObligationId: string;
  resolutionKey?: string;
  targetObligationId: string;
  effect: "activate" | "release";
}
export interface ClearanceDefinition {
  id: string;
  sourceActId: string;
  sourceMessageId: number;
  scopeText: string;
  grantedBy: ActorRef;
  grantedTo: ResponsibleActorRef;
  releaseBoundary?: ObligationCondition;
}
export type ClearanceEvent =
  | { type: "granted" }
  | { type: "revoked"; reason?: string }
  | { type: "expired"; reason: string };
export const CLEARANCE_COMMAND_EVENTS = ["revoke", "expire"] as const;
export type ClearanceCommandEventName = typeof CLEARANCE_COMMAND_EVENTS[number];
export interface ClearanceEventRecord {
  id: string;
  clearanceId: string;
  actor: ActorRef;
  occurredAt: number;
  expectedVersion: number;
  idempotencyKey: string;
  payload: ClearanceEvent;
}
export interface ClearanceSnapshot {
  clearanceId: string;
  state: "active" | "revoked" | "expired";
  version: number;
}

export class ObligationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ObligationError";
  }
}
const fail = (code: string, message: string): never => {
  throw new ObligationError(code, message);
};
const nonempty = (value: string, label: string): string => {
  const v = value.trim();
  if (!v) fail("invalid", `${label} must not be empty`);
  return v;
};
const actorKey = (a: ActorRef): string =>
  a.kind === "agent"
    ? `agent:${a.agentId}`
    : a.kind === "system"
      ? `system:${a.component}`
      : a.kind === "legacy_uncertain"
        ? `legacy:${a.label}`
        : "operator";
const sameActor = (a: ActorRef, b: ActorRef): boolean =>
  actorKey(a) === actorKey(b);
const validateActor = (a: ActorRef): void => {
  if (a.kind === "agent") nonempty(a.agentId, "agent id");
  else if (a.kind === "system") nonempty(a.component, "system component");
  else if (a.kind === "legacy_uncertain")
    nonempty(a.label, "legacy actor label");
};
export const terminalAuthority = (x: AuthorityState): boolean =>
  ["declined", "countered", "withdrawn", "cancelled"].includes(x);
const terminalActivation = (x: ActivationState): boolean =>
  ["fulfilled", "released", "violated", "expired"].includes(x);

/**
 * The two-axis state, rendered so it cannot read as a contradiction.
 *
 * `AuthorityState` and `ActivationState` are genuinely orthogonal -- authority
 * is what the PARTIES have settled, activation is whether the duty is live --
 * so `withdrawn / active` was correct and unreadable: authority reached a
 * terminal state while activation was never advanced past its default.
 *
 * Once authority is terminal the activation axis carries no information: a
 * withdrawn obligation obliges nobody whatever its condition says. So the pair
 * collapses to the settled half, and only a live obligation shows both.
 */
export function describeState(s: {
  readonly authority: AuthorityState;
  readonly activation: ActivationState;
}): string {
  if (terminalAuthority(s.authority)) return s.authority;
  return terminalActivation(s.activation)
    ? s.activation
    : `${s.authority} / ${s.activation}`;
}

export function validateCondition(c: ObligationCondition | undefined): void {
  if (!c) return;
  nonempty(c.text, "condition text");
  if (c.handling === "automatic") {
    if (c.trigger.kind === "commit_reachable") {
      nonempty(c.trigger.commitSha, "commit sha");
      nonempty(c.trigger.branch, "branch");
    }
    if (
      c.trigger.kind === "work_completed" ||
      c.trigger.kind === "work_step_completed"
    )
      nonempty(c.trigger.workId, "work id");
    if (
      c.trigger.kind === "work_step_completed" &&
      (!Number.isInteger(c.trigger.step) || c.trigger.step < 1)
    )
      fail("invalid", "work step must be positive");
    if (c.trigger.kind === "obligation_resolved")
      nonempty(c.trigger.obligationId, "trigger obligation id");
  } else if (c.handling === "resurface_on_related_event") {
    nonempty(
      c.event.kind === "work_updated" ? c.event.workId : c.event.obligationId,
      "related id",
    );
  }
}

export function foldObligation(
  def: ObligationDefinition,
  events: readonly ObligationEventRecord[],
): ObligationSnapshot {
  if (events.length === 0) fail("corrupt", "obligation has no created event");
  let state: ObligationSnapshot | undefined;
  for (let i = 0; i < events.length; i++) {
    const r = events[i]!;
    if (r.obligationId !== def.id)
      fail("corrupt", "event belongs to another obligation");
    if (r.expectedVersion !== i)
      fail(
        "corrupt",
        `event ${r.id} expected version ${r.expectedVersion}, wanted ${i}`,
      );
    const e = r.payload;
    if (i === 0) {
      if (e.type !== "created") fail("corrupt", "first event must be created");
      const seed = e as Extract<ObligationEvent, { type: "created" }>;
      state = {
        obligationId: def.id,
        authority: seed.authority,
        activation: seed.activation,
        currentResponsible: seed.responsible,
        version: 1,
        lastEventId: r.id,
      };
      continue;
    }
    if (e.type === "created") fail("transition", "created may occur only once");
    const s = state!;
    switch (e.type) {
      case "accepted":
        if (s.authority !== "proposed")
          fail("transition", "accept requires proposed");
        s.authority = "binding";
        break;
      case "declined":
        if (s.authority !== "proposed")
          fail("transition", "decline requires proposed");
        s.authority = "declined";
        break;
      case "countered":
        if (s.authority !== "proposed")
          fail("transition", "counter requires proposed");
        nonempty(e.replacementId, "replacement id");
        s.authority = "countered";
        break;
      case "withdrawn":
        if (s.authority !== "proposed")
          fail("transition", "withdraw requires proposed");
        s.authority = "withdrawn";
        break;
      case "cancelled":
        if (s.authority !== "proposed" && s.authority !== "binding")
          fail("transition", "cancel requires proposed or binding");
        nonempty(e.reason, "cancel reason");
        s.authority = "cancelled";
        break;
      case "activated":
        if (s.authority !== "binding" || s.activation !== "waiting")
          fail("transition", "activate requires binding + waiting");
        s.activation = "active";
        break;
      case "fulfilled":
        if (s.authority !== "binding" || s.activation !== "active")
          fail("transition", "fulfil requires binding + active");
        if (
          e.resolutionKey &&
          !def.validResolutionKeys.includes(e.resolutionKey)
        )
          fail("resolution", "unknown resolution key");
        s.activation = "fulfilled";
        if (e.resolution) s.resolution = e.resolution;
        break;
      case "released":
        if (s.authority !== "binding" || s.activation !== "waiting")
          fail("transition", "release requires binding + waiting");
        nonempty(e.why, "release reason");
        s.activation = "released";
        break;
      case "violated":
        if (s.authority !== "binding" || s.activation !== "active")
          fail("transition", "violate requires binding + active");
        s.activation = "violated";
        break;
      case "expired":
        if (
          s.authority !== "binding" ||
          (s.activation !== "waiting" && s.activation !== "active")
        )
          fail("transition", "expire requires binding + waiting/active");
        nonempty(e.episodeId, "episode id");
        s.activation = "expired";
        break;
      case "relinquished":
        if (
          s.authority !== "binding" ||
          terminalActivation(s.activation) ||
          s.currentResponsible.kind !== "assigned" ||
          !sameActor(s.currentResponsible.actor, e.from)
        )
          fail(
            "transition",
            "relinquish requires matching assigned owner on live work",
          );
        s.currentResponsible = { kind: "unassigned" };
        break;
      case "assigned":
        if (
          s.authority !== "binding" ||
          terminalActivation(s.activation) ||
          s.currentResponsible.kind !== "unassigned"
        )
          fail("transition", "assign requires live binding + unassigned");
        s.currentResponsible = { kind: "assigned", actor: e.to };
        break;
      case "reassigned":
      case "returned":
        if (
          s.authority !== "binding" ||
          terminalActivation(s.activation) ||
          s.currentResponsible.kind !== "assigned" ||
          !sameActor(s.currentResponsible.actor, e.from)
        )
          fail(
            "transition",
            `${e.type} requires matching assigned owner on live work`,
          );
        s.currentResponsible = { kind: "assigned", actor: e.to };
        break;
    }
    s.version = i + 1;
    s.lastEventId = r.id;
  }
  return state!;
}

export function stateVersion(snapshot: ObligationSnapshot): string {
  const canonical = JSON.stringify({
    authority: snapshot.authority,
    activation: snapshot.activation,
    responsible: snapshot.currentResponsible,
    version: snapshot.version,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
export const obligationPriority = (p: Priority): number =>
  p === "urgent" ? 110 : p === "important" ? 105 : 100;

export function createObligationTables(db: Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS message_acts (
    act_id TEXT PRIMARY KEY, source_message_id INTEGER NOT NULL, act_type TEXT NOT NULL,
    author_json TEXT NOT NULL, recipients_json TEXT NOT NULL, text TEXT NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS message_acts_message ON message_acts(source_message_id,act_id);
  CREATE TABLE IF NOT EXISTS semantic_batches (
    idempotency_key TEXT PRIMARY KEY, input_json TEXT NOT NULL, result_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS obligations (
    obligation_id TEXT PRIMARY KEY, source_act_id TEXT NOT NULL UNIQUE, source_message_id INTEGER NOT NULL,
    created_by_json TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL DEFAULT '', condition_json TEXT NOT NULL DEFAULT '',
    release_json TEXT NOT NULL DEFAULT '', resolution_keys_json TEXT NOT NULL DEFAULT '[]', text TEXT NOT NULL, priority TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS obligation_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, obligation_id TEXT NOT NULL,
    actor_json TEXT NOT NULL, occurred_ms INTEGER NOT NULL, expected_version INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL, payload_json TEXT NOT NULL,
    UNIQUE(obligation_id,idempotency_key), UNIQUE(obligation_id,expected_version)
  );
  CREATE INDEX IF NOT EXISTS obligation_events_item ON obligation_events(obligation_id,seq);
  CREATE TABLE IF NOT EXISTS obligation_dependencies (
    source_obligation_id TEXT NOT NULL, resolution_key TEXT NOT NULL DEFAULT '', target_obligation_id TEXT NOT NULL,
    effect TEXT NOT NULL, PRIMARY KEY(source_obligation_id,resolution_key,target_obligation_id,effect)
  );
  CREATE TABLE IF NOT EXISTS clearances (
    clearance_id TEXT PRIMARY KEY, source_act_id TEXT NOT NULL UNIQUE, source_message_id INTEGER NOT NULL,
    scope_text TEXT NOT NULL, granted_by_json TEXT NOT NULL, granted_to_json TEXT NOT NULL, release_json TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS clearance_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,clearance_id TEXT NOT NULL,actor_json TEXT NOT NULL,
    occurred_ms INTEGER NOT NULL,expected_version INTEGER NOT NULL,idempotency_key TEXT NOT NULL,payload_json TEXT NOT NULL,
    UNIQUE(clearance_id,idempotency_key),UNIQUE(clearance_id,expected_version)
  );
  CREATE TABLE IF NOT EXISTS hazard_notices (
    hazard_id TEXT PRIMARY KEY,source_message_id INTEGER NOT NULL,related_act_ids_json TEXT NOT NULL,summary TEXT NOT NULL,subject TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS message_deliveries (
    source_message_id INTEGER NOT NULL,recipient_json TEXT NOT NULL,priority TEXT NOT NULL,
    PRIMARY KEY(source_message_id,recipient_json)
  );
`);
}

const parse = <T>(s: string): T => JSON.parse(s) as T;
const definitionFromRow = (
  r: Record<string, string | number>,
): ObligationDefinition => ({
  id: String(r.obligation_id),
  sourceActId: String(r.source_act_id),
  sourceMessageId: Number(r.source_message_id),
  createdBy: parse(String(r.created_by_json)),
  kind: String(r.kind) as ObligationDefinition["kind"],
  mode: (String(r.mode) || undefined) as CommitmentMode | undefined,
  condition: String(r.condition_json)
    ? parse(String(r.condition_json))
    : undefined,
  releaseBoundary: String(r.release_json)
    ? parse(String(r.release_json))
    : undefined,
  validResolutionKeys: parse(String(r.resolution_keys_json)),
  text: String(r.text),
  priority: String(r.priority) as Priority,
});
const eventFromRow = (
  r: Record<string, string | number>,
): ObligationEventRecord => ({
  id: String(r.event_id),
  obligationId: String(r.obligation_id),
  actor: parse(String(r.actor_json)),
  occurredAt: Number(r.occurred_ms),
  expectedVersion: Number(r.expected_version),
  idempotencyKey: String(r.idempotency_key),
  payload: parse(String(r.payload_json)),
});
const clearanceFromRow = (
  r: Record<string, string | number>,
): ClearanceDefinition => ({
  id: String(r.clearance_id),
  sourceActId: String(r.source_act_id),
  sourceMessageId: Number(r.source_message_id),
  scopeText: String(r.scope_text),
  grantedBy: parse(String(r.granted_by_json)),
  grantedTo: parse(String(r.granted_to_json)),
  releaseBoundary: String(r.release_json)
    ? parse(String(r.release_json))
    : undefined,
});
const clearanceEventFromRow = (
  r: Record<string, string | number>,
): ClearanceEventRecord => ({
  id: String(r.event_id),
  clearanceId: String(r.clearance_id),
  actor: parse(String(r.actor_json)),
  occurredAt: Number(r.occurred_ms),
  expectedVersion: Number(r.expected_version),
  idempotencyKey: String(r.idempotency_key),
  payload: parse(String(r.payload_json)),
});

export function foldClearance(
  def: ClearanceDefinition,
  events: readonly ClearanceEventRecord[],
): ClearanceSnapshot {
  if (events.length === 0 || events[0]!.payload.type !== "granted")
    fail("corrupt", "clearance must start granted");
  let state: ClearanceSnapshot = {
    clearanceId: def.id,
    state: "active",
    version: 0,
  };
  for (let i = 0; i < events.length; i++) {
    const r = events[i]!;
    if (r.clearanceId !== def.id || r.expectedVersion !== i)
      fail("corrupt", "invalid clearance event sequence");
    if (i > 0) {
      if (state.state !== "active") fail("transition", "clearance is terminal");
      if (r.payload.type === "granted")
        fail("transition", "grant may occur only once");
      if (r.payload.type === "revoked") state.state = "revoked";
      else {
        nonempty(
          (r.payload as Extract<ClearanceEvent, { type: "expired" }>).reason,
          "expiry reason",
        );
        state.state = "expired";
      }
    }
    state.version = i + 1;
  }
  return state;
}

export interface CreateObligationInput extends Omit<
  ObligationDefinition,
  "id"
> {
  id?: string;
  initial: {
    authority: "proposed" | "binding";
    activation: "waiting" | "active";
    responsible: Responsibility;
  };
  actor: ActorRef;
  idempotencyKey: string;
  nowMs: number;
}
type ActCommon = {
  key: string;
  text: string;
  condition?: ObligationCondition;
  priority?: Priority;
  resolutionKeys?: string[];
};
export type StructuredActInput =
  | (ActCommon & { type: "question" })
  | (ActCommon & { type: "request"; unassigned?: boolean })
  | (ActCommon & {
      type: "promise";
      mode: CommitmentMode;
      releaseBoundary?: ObligationCondition;
    })
  | (ActCommon & { type: "handoff"; subject: string })
  | (ActCommon & {
      type: "grant";
      scopeText: string;
      releaseBoundary?: ObligationCondition;
    })
  | (ActCommon & {
      type: "correction";
      correctionType: CorrectionType;
      contradictsActId?: string;
    })
  | (ActCommon & {
      type: "hazard";
      subject: string;
      relatedActKeys?: string[];
    });
export interface StructuredDependencyInput {
  sourceKey: string;
  resolutionKey?: string;
  targetKey: string;
  effect: "activate" | "release";
}
export interface StructuredBatchInput {
  senderSessionId: string;
  senderName: string;
  recipientSessionId: string;
  recipientName: string;
  acts: StructuredActInput[];
  dependencies?: StructuredDependencyInput[];
  idempotencyKey: string;
  nowMs: number;
  surface?: "cli" | "api";
}
export interface StructuredBatchResult {
  messageId: number;
  actIds: Record<string, string>;
  obligationIds: Record<string, string>;
  clearanceIds: Record<string, string>;
}
export interface HazardNotice {
  id: string;
  sourceMessageId: number;
  relatedActIds: string[];
  summary: string;
  subject: string;
}

export class ObligationStore {
  constructor(
    private readonly db: Database,
    private readonly observe?: (input: {
      sessionId: string;
      feature: FeatureId;
      stage: "use";
      surface: "cli" | "api";
      opportunityId: string;
      sourceKey: string;
      nowMs: number;
      eventId: string;
    }) => void,
  ) {}
  definition(id: string): ObligationDefinition | null {
    const r = this.db
      .query(`SELECT * FROM obligations WHERE obligation_id=?`)
      .get(id) as Record<string, string | number> | null;
    return r ? definitionFromRow(r) : null;
  }
  events(id: string): ObligationEventRecord[] {
    return (
      this.db
        .query(
          `SELECT * FROM obligation_events WHERE obligation_id=? ORDER BY seq`,
        )
        .all(id) as Record<string, string | number>[]
    ).map(eventFromRow);
  }
  snapshot(id: string): ObligationSnapshot | null {
    const d = this.definition(id);
    return d ? foldObligation(d, this.events(id)) : null;
  }
  all(): Array<{
    definition: ObligationDefinition;
    snapshot: ObligationSnapshot;
  }> {
    const rows = this.db
      .query(`SELECT * FROM obligations ORDER BY rowid`)
      .all() as Record<string, string | number>[];
    return rows.map((r) => {
      const definition = definitionFromRow(r);
      return {
        definition,
        snapshot: foldObligation(definition, this.events(definition.id)),
      };
    });
  }
  hazards(messageId: number): HazardNotice[] {
    return (
      this.db
        .query(
          `SELECT * FROM hazard_notices WHERE source_message_id=? ORDER BY rowid`,
        )
        .all(messageId) as Record<string, string | number>[]
    ).map((r) => ({
      id: String(r.hazard_id),
      sourceMessageId: Number(r.source_message_id),
      relatedActIds: parse(String(r.related_act_ids_json)),
      summary: String(r.summary),
      subject: String(r.subject),
    }));
  }
  /**
   * Decisions already recorded, folded out of the events that turned a proposal
   * down. Reads only; appends nothing.
   *
   * A `countered` event IS a decision: the rejected option is this obligation,
   * the chosen one is `replacementId`. A `declined` with a reason is the same
   * shape without a replacement — an option considered and dropped. Nobody
   * retypes an argument they just finished having, which is the whole point:
   * the manual path (`--kind decision` in the diary) exists for choices made
   * without an obligation behind them, not for these.
   */
  /**
   * Open questions in both directions for one conversation id.
   *
   * THE QUESTION LOOP LIVES HERE, NOT IN `questions`. `ask` has always written
   * an obligation (`kind: "question"`, binding, responsible = the recipient),
   * while `asks` and `answer` read a separate `questions` table that `ask`
   * never wrote to. Measured 2026-08-05: 5 obligations, 0 question rows — so
   * `asks` reported "No open questions" with three outstanding and `answer`
   * rejected the uuid it had just been handed. Two ledgers, one of them empty
   * and both advertised.
   *
   * `mine` is what this session must answer; `waiting` is what it is owed. A
   * question is open until its activation is terminal — `fulfil` is what
   * `answer` files, so an answered question drops out of both lists.
   */
  openQuestions(agentId: string): {
    mine: OpenQuestion[];
    waiting: OpenQuestion[];
  } {
    const mine: OpenQuestion[] = [];
    const waiting: OpenQuestion[] = [];
    for (const { definition: d, snapshot: s } of this.all()) {
      if (d.kind !== "question") continue;
      if (terminalAuthority(s.authority) || terminalActivation(s.activation)) continue;
      // The `created` event IS the ask. `ObligationSnapshot` is a fold and
      // carries no timestamp, so the age a reader needs comes from the event
      // log rather than from the snapshot.
      const askedMs = this.events(d.id)[0]?.occurredAt ?? 0;
      const r = s.currentResponsible;
      const responsible =
        r.kind === "assigned" && r.actor.kind === "agent" ? r.actor.agentId : "";
      const asker = d.createdBy.kind === "agent" ? d.createdBy.agentId : "";
      const row: OpenQuestion = { id: d.id, text: d.text, askedMs, asker, responsible };
      if (responsible === agentId) mine.push(row);
      else if (asker === agentId) waiting.push(row);
    }
    return { mine, waiting };
  }

  /**
   * Fires `expire` for every obligation whose deadline has passed.
   *
   * WHY A SWEEP AND NOT A TIMER. Nothing here runs when no agent is working —
   * there is no daemon, and a hook only fires because its own session did
   * something. So expiry is checked opportunistically, on the paths that
   * already read this table. An obligation may therefore outlive its deadline
   * by however long the project is idle, which is correct: nobody was there to
   * be misled by it.
   *
   * Idempotent by construction — a terminal activation is skipped, and
   * `expired` is terminal — so calling it on every read is safe.
   */
  expireDue(nowMs: number): number {
    let fired = 0;
    for (const { definition: d, snapshot: s } of this.all()) {
      if (terminalAuthority(s.authority) || terminalActivation(s.activation)) continue;
      const boundary = d.releaseBoundary;
      if (
        !boundary ||
        boundary.handling !== "automatic" ||
        boundary.trigger.kind !== "deadline" ||
        boundary.trigger.atMs > nowMs
      )
        continue;
      this.append({
        id: randomUUID(),
        obligationId: d.id,
        actor: { kind: "system", component: "expiry" },
        occurredAt: nowMs,
        expectedVersion: s.version,
        idempotencyKey: `expire:${d.id}`,
        payload: { type: "expired", episodeId: `deadline:${boundary.trigger.atMs}` },
      });
      fired += 1;
    }
    return fired;
  }

  /**
   * Resolve a git-style id prefix to one obligation id.
   *
   * Uuids are 36 characters and nobody retypes one. `ask` hands the asker a
   * full uuid and the peer sees it in an injected line; requiring both to be
   * copied exactly is what made `answer` feel unusable even before the table
   * split was found. Ambiguity is an error rather than a guess — answering the
   * wrong obligation is worse than being asked to type two more characters.
   */
  resolveId(prefix: string): { ok: true; id: string } | { ok: false; error: string } {
    const needle = prefix.trim().toLowerCase();
    if (needle === "") return { ok: false, error: "empty obligation id" };
    const hits = this.all()
      .map((o) => o.definition.id)
      .filter((id) => id.toLowerCase().startsWith(needle));
    if (hits.length === 1) return { ok: true, id: hits[0]! };
    return {
      ok: false,
      error:
        hits.length === 0
          ? `no obligation matching ${prefix}`
          : `ambiguous obligation ${prefix}: ${hits.map((h) => h.slice(0, 8)).join(", ")}`,
    };
  }

  decisions(): Decision[] {
    const byId = new Map(this.all().map((o) => [o.definition.id, o]));
    const out: Decision[] = [];
    for (const { definition } of byId.values()) {
      for (const record of this.events(definition.id)) {
        const e = record.payload;
        if (e.type !== "countered" && e.type !== "declined") continue;
        // The replacement may be missing: an obligation can be countered by one
        // that was later deleted, and a decision naming a dangling id is worse
        // than one that says only what was turned down.
        const chosen =
          e.type === "countered"
            ? (byId.get(e.replacementId)?.definition.text ?? "")
            : "";
        out.push({
          obligationId: definition.id,
          decidedBy: record.actor,
          decidedAtMs: record.occurredAt,
          rejected: definition.text,
          chosen,
          chosenObligationId: e.type === "countered" ? e.replacementId : "",
          // `declined` carries an optional reason and `countered` carries none:
          // the replacement's own text is the argument in that case.
          rationale: e.type === "declined" ? (e.reason ?? "") : "",
        });
      }
    }
    return out.sort((a, b) => a.decidedAtMs - b.decidedAtMs);
  }
  /** P0 candidates for one authenticated conversation id. */
  /**
   * Who an obligation was addressed TO, which is not who owes it.
   *
   * A promise assigns responsibility to the PROMISOR, so `currentResponsible`
   * cannot answer "was this made to me?". The recipient is on the message that
   * carried it (`message_deliveries`), joined by `source_message_id`.
   */
  private recipientsOf(sourceMessageId: number): Set<string> {
    const rows = this.db
      .query(`SELECT recipient_json FROM message_deliveries WHERE source_message_id = ?`)
      .all(sourceMessageId) as Array<{ recipient_json: string }>;
    const out = new Set<string>();
    for (const row of rows) {
      const actor = parse<ActorRef>(row.recipient_json);
      if (actor.kind === "agent") out.add(actor.agentId);
    }
    return out;
  }

  candidates(agentId: string, operator = false): InjectionCandidate[] {
    const mine = (r: Responsibility): boolean =>
      r.kind === "assigned" &&
      r.actor.kind === "agent" &&
      r.actor.agentId === agentId;
    return this.all().flatMap(({ definition: d, snapshot: s }) => {
      let actionable = false;
      let relevant = false;
      if (s.authority === "proposed" && mine(s.currentResponsible)) {
        actionable = true;
        relevant = true;
      } else if (
        s.authority === "binding" &&
        s.currentResponsible.kind === "unassigned" &&
        operator
      ) {
        actionable = true;
        relevant = true;
      } else if (s.authority === "binding" && mine(s.currentResponsible)) {
        relevant = true;
        actionable = s.activation === "active";
      } else if (
        // A PROMISE MADE TO YOU. Responsibility sits with the promisor, so this
        // is the only branch that can reach the beneficiary -- without it a
        // promise was invisible to the one peer it was for, which is the whole
        // point of making one. Measured 2026-08-05: still absent after 45
        // minutes while every other kind injected.
        d.kind === "promise" &&
        s.authority === "binding" &&
        s.activation === "active" &&
        !mine(s.currentResponsible) &&
        this.recipientsOf(d.sourceMessageId).has(agentId)
      ) {
        relevant = true;
        // NEVER ACTIONABLE: `only owner may perform event` is correct and
        // stays, so telling the beneficiary to act would advertise a command
        // that fails -- the same defect as the `crew answer` hook did.
        actionable = false;
      }
      if (
        !relevant ||
        terminalAuthority(s.authority) ||
        terminalActivation(s.activation)
      )
        return [];
      const who =
        s.currentResponsible.kind === "unassigned"
          ? "unassigned"
          : s.currentResponsible.actor.kind === "agent"
            ? s.currentResponsible.actor.agentId
            : "operator";
      const status =
        s.authority === "proposed"
          ? "awaiting your response"
          : s.activation === "waiting"
            ? "waiting on its condition"
            : // A non-actionable candidate is one you are TOLD about, not one
              // you owe -- a promise made to you. "needs action" there would
              // ask for something the ledger will refuse.
              actionable
              ? "needs action"
              : "made to you; nothing owed";
      return [
        {
          key: `obligation:${d.id}`,
          dedupeKey: `obligation:${d.id}`,
          stateVersion: stateVersion(s),
          priority: actionable ? obligationPriority(d.priority) : 60,
          text: `Obligation ${d.id} (${status}, ${who}): ${d.text}`,
          compact: `${d.id}: ${status}`,
          actionable,
          origin: "peer" as const,
          requiresPeerFraming: true,
        },
      ];
    });
  }
  create(input: CreateObligationInput): ObligationDefinition {
    validateDefinition(input);
    const id = input.id ?? randomUUID();
    nonempty(id, "obligation id");
    nonempty(input.idempotencyKey, "idempotency key");
    const run = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO obligations(obligation_id,source_act_id,source_message_id,created_by_json,kind,mode,condition_json,release_json,resolution_keys_json,text,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.sourceActId,
          input.sourceMessageId,
          JSON.stringify(input.createdBy),
          input.kind,
          input.mode ?? "",
          input.condition ? JSON.stringify(input.condition) : "",
          input.releaseBoundary ? JSON.stringify(input.releaseBoundary) : "",
          JSON.stringify(input.validResolutionKeys),
          input.text,
          input.priority,
        );
      const event: ObligationEventRecord = {
        id: randomUUID(),
        obligationId: id,
        actor: input.actor,
        occurredAt: input.nowMs,
        expectedVersion: 0,
        idempotencyKey: input.idempotencyKey,
        payload: { type: "created", ...input.initial },
      };
      this.insertEvent(event);
      return this.definition(id)!;
    });
    try {
      return run.immediate();
    } catch (e) {
      throw mapSqlError(e);
    }
  }
  createBatch(input: StructuredBatchInput): StructuredBatchResult {
    nonempty(input.senderSessionId, "sender session");
    nonempty(input.senderName, "sender name");
    nonempty(input.recipientSessionId, "recipient session");
    nonempty(input.recipientName, "recipient name");
    nonempty(input.idempotencyKey, "batch idempotency key");
    if (input.acts.length === 0)
      fail("invalid", "batch requires at least one act");
    const keys = input.acts.map((a) => nonempty(a.key, "act key"));
    if (new Set(keys).size !== keys.length)
      fail("invalid", "act keys must be unique");
    const common = new Set([
      "key",
      "type",
      "text",
      "condition",
      "priority",
      "resolutionKeys",
    ]);
    const specific: Record<string, string[]> = {
      question: [],
      request: ["unassigned"],
      promise: ["mode", "releaseBoundary"],
      handoff: ["subject"],
      grant: ["scopeText", "releaseBoundary"],
      correction: ["correctionType", "contradictsActId"],
      hazard: ["subject", "relatedActKeys"],
    };
    for (const a of input.acts) {
      if (!specific[a.type]) fail("invalid", "unknown structured act type");
      for (const k of Object.keys(a))
        if (!common.has(k) && !specific[a.type]!.includes(k))
          fail("invalid", `field ${k} is not allowed on ${a.type}`);
      nonempty(a.text, "act text");
      validateCondition(a.condition);
      if (a.type === "promise") {
        if (a.mode !== "perform" && a.mode !== "refrain")
          fail("invalid", "unsupported commitment mode");
        if (a.mode === "refrain" && !a.releaseBoundary)
          fail("invalid", "refrain requires release boundary");
        validateCondition(a.releaseBoundary);
      }
      if (a.type === "handoff") nonempty(a.subject, "handoff subject");
      if (a.type === "grant") {
        nonempty(a.scopeText, "grant scope");
        validateCondition(a.releaseBoundary);
      }
      if (
        a.type === "correction" &&
        ![
          "self_erratum",
          "peer_correction",
          "implementation_correction",
        ].includes(a.correctionType)
      )
        fail("invalid", "unsupported correction subtype");
      if (a.type === "hazard") nonempty(a.subject, "hazard subject");
    }
    for (const d of input.dependencies ?? [])
      if (
        !keys.includes(d.sourceKey) ||
        !keys.includes(d.targetKey) ||
        d.sourceKey === d.targetKey
      )
        fail("invalid", "dependency keys must name distinct acts in the batch");
    for (const a of input.acts)
      if (a.type === "hazard")
        for (const key of a.relatedActKeys ?? [])
          if (!keys.includes(key))
            fail("invalid", `hazard related act ${key} is not in the batch`);
    const actor: ActorRef = { kind: "agent", agentId: input.senderSessionId };
    const recipient: ResponsibleActorRef = {
      kind: "agent",
      agentId: input.recipientSessionId,
    };
    const run = this.db.transaction(() => {
      const canonical = JSON.stringify(input);
      const prior = this.db
        .query(
          `SELECT input_json,result_json FROM semantic_batches WHERE idempotency_key=?`,
        )
        .get(input.idempotencyKey) as {
        input_json: string;
        result_json: string;
      } | null;
      if (prior) {
        if (prior.input_json !== canonical)
          fail(
            "idempotency_conflict",
            "batch idempotency key reused with different input",
          );
        return parse<StructuredBatchResult>(prior.result_json);
      }
      const body = input.acts
        .map((a) => `${a.type.toUpperCase()}: ${a.text}`)
        .join("\n");
      this.db
        .query(
          `INSERT INTO messages(ts_ms,handle,kind,body,to_session,from_name,to_name) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          input.nowMs,
          input.senderName,
          "say",
          body,
          input.recipientSessionId,
          input.senderName,
          input.recipientName,
        );
      const messageId = Number(
        (this.db.query(`SELECT last_insert_rowid() id`).get() as { id: number })
          .id,
      );
      const actIds: Record<string, string> = Object.fromEntries(
          input.acts.map((a) => [a.key, randomUUID()]),
        ),
        obligationIds: Record<string, string> = {},
        clearanceIds: Record<string, string> = {};
      for (const a of input.acts)
        if (
          a.type === "correction" &&
          a.contradictsActId &&
          !Object.values(actIds).includes(a.contradictsActId) &&
          !this.db
            .query(`SELECT 1 FROM message_acts WHERE act_id=?`)
            .get(a.contradictsActId)
        )
          fail("not_found", "correction target act not found");
      for (const a of input.acts) {
        const actId = actIds[a.key]!;
        let obligationId: string | undefined, clearanceId: string | undefined;
        const priority = a.priority ?? "important";
        if (["question", "request", "promise", "handoff"].includes(a.type)) {
          obligationId = randomUUID();
          obligationIds[a.key] = obligationId;
          const kind = a.type as ObligationDefinition["kind"];
          const unassigned = a.type === "request" && a.unassigned === true;
          const authority =
            kind === "question" || kind === "promise" || unassigned
              ? "binding"
              : "proposed";
          const responsibleState: Responsibility = unassigned
            ? { kind: "unassigned" }
            : {
                kind: "assigned",
                actor:
                  kind === "promise"
                    ? (actor as ResponsibleActorRef)
                    : recipient,
              };
          const activation = a.condition ? "waiting" : "active";
          this.db
            .query(
              `INSERT INTO obligations(obligation_id,source_act_id,source_message_id,created_by_json,kind,mode,condition_json,release_json,resolution_keys_json,text,priority) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              obligationId,
              actId,
              messageId,
              JSON.stringify(actor),
              unassigned ? "unassigned_work" : kind,
              a.type === "promise" ? a.mode : "",
              a.condition ? JSON.stringify(a.condition) : "",
              a.type === "promise" && a.releaseBoundary
                ? JSON.stringify(a.releaseBoundary)
                : "",
              JSON.stringify(a.resolutionKeys ?? []),
              a.text,
              priority,
            );
          this.insertEvent({
            id: randomUUID(),
            obligationId,
            actor,
            occurredAt: input.nowMs,
            expectedVersion: 0,
            idempotencyKey: `${input.idempotencyKey}:${a.key}:created`,
            payload: {
              type: "created",
              authority,
              activation,
              responsible: responsibleState,
            },
          });
        }
        if (a.type === "grant") {
          clearanceId = randomUUID();
          clearanceIds[a.key] = clearanceId;
          this.db
            .query(
              `INSERT INTO clearances(clearance_id,source_act_id,source_message_id,scope_text,granted_by_json,granted_to_json,release_json) VALUES(?,?,?,?,?,?,?)`,
            )
            .run(
              clearanceId,
              actId,
              messageId,
              a.scopeText,
              JSON.stringify(actor),
              JSON.stringify(recipient),
              a.releaseBoundary ? JSON.stringify(a.releaseBoundary) : "",
            );
          this.insertClearanceEvent({
            id: randomUUID(),
            clearanceId,
            actor,
            occurredAt: input.nowMs,
            expectedVersion: 0,
            idempotencyKey: `${input.idempotencyKey}:${a.key}:granted`,
            payload: { type: "granted" },
          });
        }
        const payload = {
          ...a,
          key: a.key,
          batchIdempotencyKey: input.idempotencyKey,
          obligationId,
          clearanceId,
        };
        this.db
          .query(
            `INSERT INTO message_acts(act_id,source_message_id,act_type,author_json,recipients_json,text,payload_json) VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            actId,
            messageId,
            a.type,
            JSON.stringify(actor),
            JSON.stringify([recipient]),
            a.text,
            JSON.stringify(payload),
          );
        if (a.type === "hazard")
          this.db
            .query(
              `INSERT INTO hazard_notices(hazard_id,source_message_id,related_act_ids_json,summary,subject) VALUES(?,?,?,?,?)`,
            )
            .run(
              randomUUID(),
              messageId,
              JSON.stringify(
                (a.relatedActKeys ?? []).map((k) => actIds[k]).filter(Boolean),
              ),
              a.text,
              a.subject,
            );
      }
      this.db
        .query(
          `INSERT INTO message_deliveries(source_message_id,recipient_json,priority) VALUES(?,?,?)`,
        )
        .run(
          messageId,
          JSON.stringify(recipient),
          input.acts.reduce<Priority>(
            (p, a) =>
              obligationPriority(a.priority ?? "important") >
              obligationPriority(p)
                ? (a.priority ?? "important")
                : p,
            "normal",
          ),
        );
      for (const d of input.dependencies ?? [])
        this.addDependency({
          sourceObligationId:
            obligationIds[d.sourceKey] ??
            fail("invalid", "dependency source is not an obligation"),
          resolutionKey: d.resolutionKey,
          targetObligationId:
            obligationIds[d.targetKey] ??
            fail("invalid", "dependency target is not an obligation"),
          effect: d.effect,
        });
      const used = new Set(input.acts.map((a) => featureForAct(a.type)));
      for (const feature of used)
        this.observe?.({
          sessionId: input.senderSessionId,
          feature,
          stage: "use",
          surface: input.surface ?? "api",
          opportunityId: input.senderSessionId,
          sourceKey: input.idempotencyKey,
          nowMs: input.nowMs,
          eventId: `${input.senderSessionId}\u0000${feature}\u0000use\u0000${input.surface ?? "api"}\u0000${input.idempotencyKey}`,
        });
      const result = { messageId, actIds, obligationIds, clearanceIds };
      this.db
        .query(
          `INSERT INTO semantic_batches(idempotency_key,input_json,result_json) VALUES(?,?,?)`,
        )
        .run(input.idempotencyKey, canonical, JSON.stringify(result));
      return result;
    });
    try {
      return run.immediate();
    } catch (e) {
      if (e instanceof ObligationError) throw e;
      throw mapSqlError(e);
    }
  }
  append(record: ObligationEventRecord): ObligationSnapshot {
    nonempty(record.id, "event id");
    nonempty(record.idempotencyKey, "idempotency key");
    const run = this.db.transaction(() => {
      const def = this.definition(record.obligationId);
      if (!def) fail("not_found", "obligation not found");
      const found = def!;
      const prior = this.events(record.obligationId);
      const duplicate = prior.find(
        (x) => x.idempotencyKey === record.idempotencyKey,
      );
      if (duplicate) {
        if (
          JSON.stringify(duplicate.payload) !==
            JSON.stringify(record.payload) ||
          !sameActor(duplicate.actor, record.actor)
        )
          fail(
            "idempotency_conflict",
            "idempotency key reused with different event",
          );
        return foldObligation(found, prior);
      }
      if (record.expectedVersion !== prior.length)
        fail(
          "stale_version",
          `expected ${record.expectedVersion}, current ${prior.length}`,
        );
      authorize(
        found,
        foldObligation(found, prior),
        record.actor,
        record.payload,
      );
      const next = foldObligation(found, [...prior, record]);
      this.insertEvent(record);
      if (record.payload.type === "fulfilled")
        this.applyDependencies(record, record.payload.resolutionKey);
      return next;
    });
    try {
      return run.immediate();
    } catch (e) {
      if (e instanceof ObligationError) throw e;
      throw mapSqlError(e);
    }
  }
  addDependency(dep: Dependency): void {
    nonempty(dep.sourceObligationId, "source obligation id");
    nonempty(dep.targetObligationId, "target obligation id");
    if (dep.sourceObligationId === dep.targetObligationId)
      fail("dependency_cycle", "dependency cannot target itself");
    const source = this.definition(dep.sourceObligationId),
      target = this.definition(dep.targetObligationId);
    if (!source || !target)
      fail("not_found", "dependency obligation not found");
    if (
      dep.resolutionKey &&
      !source!.validResolutionKeys.includes(dep.resolutionKey)
    )
      fail("resolution", "dependency resolution key is not declared");
    const rows = this.db
      .query(
        `SELECT source_obligation_id,target_obligation_id FROM obligation_dependencies`,
      )
      .all() as Array<{
      source_obligation_id: string;
      target_obligation_id: string;
    }>;
    const conflict = this.db
      .query(
        `SELECT effect FROM obligation_dependencies WHERE source_obligation_id=? AND resolution_key=? AND target_obligation_id=?`,
      )
      .get(
        dep.sourceObligationId,
        dep.resolutionKey ?? "",
        dep.targetObligationId,
      ) as { effect: string } | null;
    if (conflict && conflict.effect !== dep.effect)
      fail(
        "dependency_conflict",
        "one resolution cannot both activate and release the same target",
      );
    const edges = [
      ...rows.map(
        (r) => [r.source_obligation_id, r.target_obligation_id] as const,
      ),
      [dep.sourceObligationId, dep.targetObligationId] as const,
    ];
    const reaches = (
      from: string,
      want: string,
      seen = new Set<string>(),
    ): boolean =>
      from === want ||
      (!seen.has(from) &&
        (seen.add(from),
        edges
          .filter(([a]) => a === from)
          .some(([, b]) => reaches(b, want, seen))));
    if (reaches(dep.targetObligationId, dep.sourceObligationId))
      fail("dependency_cycle", "dependency graph must be acyclic");
    try {
      this.db
        .query(
          `INSERT INTO obligation_dependencies(source_obligation_id,resolution_key,target_obligation_id,effect) VALUES(?,?,?,?)`,
        )
        .run(
          dep.sourceObligationId,
          dep.resolutionKey ?? "",
          dep.targetObligationId,
          dep.effect,
        );
    } catch (e) {
      throw mapSqlError(e);
    }
  }
  dependencies(sourceId: string): Dependency[] {
    return (
      this.db
        .query(
          `SELECT * FROM obligation_dependencies WHERE source_obligation_id=? ORDER BY target_obligation_id,effect`,
        )
        .all(sourceId) as Record<string, string>[]
    ).map((r) => ({
      sourceObligationId: r.source_obligation_id!,
      resolutionKey: r.resolution_key || undefined,
      targetObligationId: r.target_obligation_id!,
      effect: r.effect as Dependency["effect"],
    }));
  }
  private applyDependencies(
    source: ObligationEventRecord,
    resolutionKey: string | undefined,
  ): void {
    for (const dep of this.dependencies(source.obligationId).filter(
      (d) => (d.resolutionKey ?? "") === (resolutionKey ?? ""),
    )) {
      const d = this.definition(dep.targetObligationId)!;
      const prior = this.events(d.id);
      const payload: ObligationEvent =
        dep.effect === "activate"
          ? {
              type: "activated",
              trigger: {
                kind: "obligation_resolved",
                obligationId: source.obligationId,
                resolutionKey,
              },
            }
          : {
              type: "released",
              why: `dependency ${source.obligationId} resolved`,
            };
      const derived: ObligationEventRecord = {
        id: randomUUID(),
        obligationId: d.id,
        actor: { kind: "system", component: "obligation-dependencies" },
        occurredAt: source.occurredAt,
        expectedVersion: prior.length,
        idempotencyKey: `dependency:${source.id}:${d.id}:${dep.effect}`,
        payload,
      };
      authorize(d, foldObligation(d, prior), derived.actor, payload);
      foldObligation(d, [...prior, derived]);
      this.insertEvent(derived);
    }
  }
  private insertEvent(r: ObligationEventRecord): void {
    this.db
      .query(
        `INSERT INTO obligation_events(event_id,obligation_id,actor_json,occurred_ms,expected_version,idempotency_key,payload_json) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.obligationId,
        JSON.stringify(r.actor),
        r.occurredAt,
        r.expectedVersion,
        r.idempotencyKey,
        JSON.stringify(r.payload),
      );
  }
  /**
   * Every clearance with its folded state — the shape a list needs.
   *
   * Mirrors `all()` for obligations, and exists for the same reason: the only
   * handle was by-uuid inspect, which requires already having the uuid. Neither
   * operator nor agent could answer "what is outstanding between these two",
   * and unenumerable state is unusable state.
   */
  allClearances(): Array<{
    definition: ClearanceDefinition;
    snapshot: ClearanceSnapshot;
  }> {
    const rows = this.db
      .query(`SELECT clearance_id FROM clearances ORDER BY rowid`)
      .all() as Array<{ clearance_id: string }>;
    const out: Array<{ definition: ClearanceDefinition; snapshot: ClearanceSnapshot }> = [];
    for (const row of rows) {
      const definition = this.clearance(row.clearance_id);
      const snapshot = this.clearanceSnapshot(row.clearance_id);
      if (definition && snapshot) out.push({ definition, snapshot });
    }
    return out;
  }

  clearance(id: string): ClearanceDefinition | null {
    const r = this.db
      .query(`SELECT * FROM clearances WHERE clearance_id=?`)
      .get(id) as Record<string, string | number> | null;
    return r ? clearanceFromRow(r) : null;
  }
  clearanceEvents(id: string): ClearanceEventRecord[] {
    return (
      this.db
        .query(
          `SELECT * FROM clearance_events WHERE clearance_id=? ORDER BY seq`,
        )
        .all(id) as Record<string, string | number>[]
    ).map(clearanceEventFromRow);
  }
  clearanceSnapshot(id: string): ClearanceSnapshot | null {
    const d = this.clearance(id);
    return d ? foldClearance(d, this.clearanceEvents(id)) : null;
  }
  createClearance(
    input: Omit<ClearanceDefinition, "id"> & {
      id?: string;
      actor: ActorRef;
      idempotencyKey: string;
      nowMs: number;
    },
  ): ClearanceDefinition {
    const id = input.id ?? randomUUID();
    nonempty(id, "clearance id");
    nonempty(input.sourceActId, "source act id");
    nonempty(input.scopeText, "scope text");
    nonempty(input.idempotencyKey, "idempotency key");
    validateCondition(input.releaseBoundary);
    if (
      input.grantedBy.kind === "legacy_uncertain" ||
      !sameActor(input.grantedBy, input.actor)
    )
      fail("attribution", "grant requires authenticated trustworthy author");
    const run = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO clearances(clearance_id,source_act_id,source_message_id,scope_text,granted_by_json,granted_to_json,release_json) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.sourceActId,
          input.sourceMessageId,
          input.scopeText,
          JSON.stringify(input.grantedBy),
          JSON.stringify(input.grantedTo),
          input.releaseBoundary ? JSON.stringify(input.releaseBoundary) : "",
        );
      this.insertClearanceEvent({
        id: randomUUID(),
        clearanceId: id,
        actor: input.actor,
        occurredAt: input.nowMs,
        expectedVersion: 0,
        idempotencyKey: input.idempotencyKey,
        payload: { type: "granted" },
      });
      return this.clearance(id)!;
    });
    try {
      return run.immediate();
    } catch (e) {
      if (e instanceof ObligationError) throw e;
      throw mapSqlError(e);
    }
  }
  appendClearance(r: ClearanceEventRecord): ClearanceSnapshot {
    nonempty(r.idempotencyKey, "idempotency key");
    const run = this.db.transaction(() => {
      const d = this.clearance(r.clearanceId);
      if (!d) fail("not_found", "clearance not found");
      const found = d!;
      const prior = this.clearanceEvents(r.clearanceId);
      const duplicate = prior.find(
        (x) => x.idempotencyKey === r.idempotencyKey,
      );
      if (duplicate) {
        if (
          JSON.stringify(duplicate.payload) !== JSON.stringify(r.payload) ||
          !sameActor(duplicate.actor, r.actor)
        )
          fail("idempotency_conflict", "clearance retry differs");
        return foldClearance(found, prior);
      }
      if (r.expectedVersion !== prior.length)
        fail(
          "stale_version",
          `expected ${r.expectedVersion}, current ${prior.length}`,
        );
      if (r.payload.type === "granted")
        fail("transition", "grant may occur only once");
      if (
        r.payload.type === "revoked" &&
        !sameActor(r.actor, found.grantedBy) &&
        r.actor.kind !== "operator"
      )
        fail("forbidden", "only grantor or operator may revoke");
      if (
        r.payload.type === "expired" &&
        r.actor.kind !== "operator" &&
        r.actor.kind !== "system"
      )
        fail("forbidden", "only system or operator may expire");
      foldClearance(found, [...prior, r]);
      this.insertClearanceEvent(r);
      return foldClearance(found, [...prior, r]);
    });
    try {
      return run.immediate();
    } catch (e) {
      if (e instanceof ObligationError) throw e;
      throw mapSqlError(e);
    }
  }
  private insertClearanceEvent(r: ClearanceEventRecord): void {
    this.db
      .query(
        `INSERT INTO clearance_events(event_id,clearance_id,actor_json,occurred_ms,expected_version,idempotency_key,payload_json) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.clearanceId,
        JSON.stringify(r.actor),
        r.occurredAt,
        r.expectedVersion,
        r.idempotencyKey,
        JSON.stringify(r.payload),
      );
  }
}

function validateDefinition(x: CreateObligationInput): void {
  nonempty(x.sourceActId, "source act id");
  if (!Number.isInteger(x.sourceMessageId) || x.sourceMessageId < 1)
    fail("invalid", "source message id must be positive");
  nonempty(x.text, "obligation text");
  validateCondition(x.condition);
  validateCondition(x.releaseBoundary);
  if (
    new Set(x.validResolutionKeys).size !== x.validResolutionKeys.length ||
    x.validResolutionKeys.some((k) => !k.trim())
  )
    fail("invalid", "resolution keys must be unique and nonempty");
  if (x.kind === "promise" && !x.mode) fail("invalid", "promise requires mode");
  if (x.kind !== "promise" && x.mode)
    fail("invalid", "mode applies only to promise");
  if (x.mode === "refrain" && !x.releaseBoundary)
    fail("invalid", "refrain requires release boundary");
  validateActor(x.createdBy);
  validateActor(x.actor);
  if (x.initial.responsible.kind === "assigned")
    validateActor(x.initial.responsible.actor);
  if (x.createdBy.kind === "legacy_uncertain")
    fail("attribution", "new obligation requires trustworthy author");
  if (x.actor.kind === "legacy_uncertain")
    fail("attribution", "legacy actor cannot create obligation");
  if (x.initial.activation === "waiting" && !x.condition)
    fail("invalid", "waiting obligation requires a condition");
  if (x.kind === "question" && x.initial.authority !== "binding")
    fail("invalid", "question starts binding");
  if (x.kind === "promise" && x.initial.authority !== "binding")
    fail("invalid", "promise starts binding");
  if (
    x.kind === "unassigned_work" &&
    (x.initial.authority !== "binding" ||
      x.initial.responsible.kind !== "unassigned")
  )
    fail("invalid", "unassigned work starts binding and unassigned");
  if (
    x.kind === "promise" &&
    (x.initial.responsible.kind !== "assigned" ||
      !sameActor(x.initial.responsible.actor, x.createdBy))
  )
    fail("invalid", "promise responsibility must be its author");
  if (
    x.kind === "request" &&
    x.initial.responsible.kind === "unassigned" &&
    x.initial.authority !== "binding"
  )
    fail("invalid", "unassigned work starts binding");
}

function authorize(
  def: ObligationDefinition,
  s: ObligationSnapshot,
  actor: ActorRef,
  e: ObligationEvent,
): void {
  validateActor(actor);
  if (
    actor.kind === "system" &&
    !new Set(["conditions", "obligation-dependencies"]).has(actor.component)
  )
    fail("forbidden", "unknown system component");
  const owner =
    s.currentResponsible.kind === "assigned" &&
    sameActor(s.currentResponsible.actor, actor);
  const creator = sameActor(def.createdBy, actor);
  const operator = actor.kind === "operator";
  switch (e.type) {
    case "accepted":
    case "declined":
    case "countered":
      if (!owner) fail("forbidden", "only proposed recipient may respond");
      return;
    case "withdrawn":
      if (!creator) fail("forbidden", "only creator may withdraw");
      return;
    case "fulfilled":
    case "relinquished":
      if (!owner) fail("forbidden", "only owner may perform event");
      return;
    case "assigned":
      if (!operator) fail("forbidden", "only operator may assign unowned work");
      return;
    case "reassigned":
      if (!owner && !operator)
        fail("forbidden", "only owner or operator may reassign");
      return;
    case "returned":
      if (!owner) fail("forbidden", "only owner may return work");
      return;
    case "cancelled":
      if (!creator && !operator)
        fail("forbidden", "only creator or operator may cancel");
      return;
    case "violated":
      if (!owner && !operator && actor.kind !== "system")
        fail("forbidden", "violation actor not authorized");
      return;
    case "activated":
    case "released":
    case "expired":
      if (!operator && actor.kind !== "system")
        fail("forbidden", "condition transition requires system or operator");
      return;
    case "created":
      fail("transition", "created may occur only once");
  }
}
function mapSqlError(e: unknown): ObligationError {
  const m = e instanceof Error ? e.message : String(e);
  return new ObligationError(m.includes("UNIQUE") ? "conflict" : "storage", m);
}
