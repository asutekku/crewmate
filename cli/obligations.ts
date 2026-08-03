import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type {
  ActorRef,
  ClearanceDefinition,
  ClearanceSnapshot,
  ObligationDefinition,
  ObligationSnapshot,
  StructuredActInput,
  StructuredDependencyInput,
} from "../core/obligations.ts";
import { bold, green } from "../core/colour.ts";
import { displayName, type Store, withStore } from "../core/store.ts";
import { takeFlag } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import {
  buildClearanceEvent,
  buildObligationEvent,
  parseVersion,
  type ObligationEventInput,
} from "./obligation-events.ts";
import { attempt, failure, success, type Result } from "./result.ts";
import {
  parseStructuredShortcut,
  type StructuredShortcut,
} from "./structured.ts";
import type { CliContext, CommandMap } from "./types.ts";

interface StructuredFile {
  readonly acts: StructuredActInput[];
  readonly dependencies?: StructuredDependencyInput[];
  readonly idempotencyKey?: string;
}

interface ObligationCommandInput extends ObligationEventInput {
  readonly version: string;
  readonly idempotencyKey: string;
  readonly target?: string;
}

interface ClearanceCommandInput {
  readonly eventName: string;
  readonly version: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

type ObligationView = {
  readonly definition: ObligationDefinition;
  readonly snapshot: ObligationSnapshot;
};

type ClearanceView = {
  readonly definition: ClearanceDefinition;
  readonly snapshot: ClearanceSnapshot;
};

function actor(store: Store, sessionId: string): ActorRef {
  return sessionId && store.findBySession(sessionId)
    ? { kind: "agent", agentId: sessionId }
    : { kind: "operator" };
}

function structured(
  context: CliContext,
  target: string,
  acts: StructuredActInput[],
  idempotencyKey: string = randomUUID(),
  dependencies?: StructuredDependencyInput[],
): void {
  if (!context.sessionId) {
    failCommand(
      context,
      "structured acts identifies its sender from CLAUDE_CODE_SESSION_ID; run it from an agent session.",
    );
    return;
  }

  const now = context.now();
  const result = withStore(
    context.dbPath,
    (store): Result<ReturnType<Store["obligations"]["createBatch"]>> => {
      const self = store.findBySession(context.sessionId);
      const recipient = store.findByName(target, now);
      if (!self) return failure("this session is not registered");
      if (!recipient) return failure(`no live agent named ${target}`);
      return attempt(() =>
        store.obligations.createBatch({
          senderSessionId: context.sessionId,
          senderName: displayName(self),
          recipientSessionId: recipient.sessionId,
          recipientName: displayName(recipient),
          acts,
          dependencies,
          idempotencyKey,
          nowMs: now,
          surface: "cli",
        }),
      );
    },
  );
  if (!result.ok) {
    failCommand(context, result.error);
    return;
  }
  context.log(`${green("✓")} structured message #${result.value.messageId}`);
  for (const [key, id] of Object.entries(result.value.obligationIds))
    context.log(`  ${key}: obligation ${id}`);
  for (const [key, id] of Object.entries(result.value.clearanceIds))
    context.log(`  ${key}: clearance ${id}`);
}

function shortcut(
  context: CliContext,
  command: StructuredShortcut,
  args: readonly string[],
): void {
  const parsed = parseStructuredShortcut(command, args);
  if (!parsed.matched || !parsed.result.ok) {
    failUsage(context, command);
    return;
  }
  structured(context, parsed.result.value.target, [
    ...parsed.result.value.acts,
  ]);
}

function readObligation(store: Store, id: string): Result<ObligationView> {
  const definition = store.obligations.definition(id);
  const snapshot = store.obligations.snapshot(id);
  return definition && snapshot
    ? success({ definition, snapshot })
    : failure(`no obligation ${id}`);
}

function obligation(
  context: CliContext,
  id: string,
  input?: ObligationCommandInput,
): void {
  const now = context.now();
  const outcome = withStore(context.dbPath, (store): Result<ObligationView> => {
    const current = readObligation(store, id);
    if (!current.ok || !input) return current;

    const version = parseVersion(input.version, current.value.snapshot.version);
    if (!version.ok) return version;

    let to: ActorRef | undefined;
    if (input.target) {
      const session = store.findByName(input.target, now);
      if (!session) return failure(`no live agent named ${input.target}`);
      to = { kind: "agent", agentId: session.sessionId };
    }
    const payload = buildObligationEvent(
      { ...input, to },
      current.value.snapshot,
    );
    if (!payload.ok) return payload;

    const appended = attempt(() =>
      store.obligations.append({
        id: randomUUID(),
        obligationId: id,
        actor: actor(store, context.sessionId),
        occurredAt: now,
        expectedVersion: version.value,
        idempotencyKey: input.idempotencyKey || randomUUID(),
        payload: payload.value,
      }),
    );
    return appended.ok
      ? success({
          definition: current.value.definition,
          snapshot: appended.value,
        })
      : appended;
  });
  if (!outcome.ok) {
    failCommand(context, outcome.error);
    return;
  }
  context.log(
    `${bold(id)}  ${outcome.value.snapshot.authority} / ${outcome.value.snapshot.activation}  v${outcome.value.snapshot.version}`,
  );
  context.log(`  ${outcome.value.definition.text}`);
}

function readClearance(store: Store, id: string): Result<ClearanceView> {
  const definition = store.obligations.clearance(id);
  const snapshot = store.obligations.clearanceSnapshot(id);
  return definition && snapshot
    ? success({ definition, snapshot })
    : failure(`no clearance ${id}`);
}

function clearance(
  context: CliContext,
  id: string,
  input?: ClearanceCommandInput,
): void {
  const now = context.now();
  const outcome = withStore(context.dbPath, (store): Result<ClearanceView> => {
    const current = readClearance(store, id);
    if (!current.ok || !input) return current;
    const version = parseVersion(input.version, current.value.snapshot.version);
    if (!version.ok) return version;
    const payload = buildClearanceEvent(input.eventName, input.reason);
    if (!payload.ok) return payload;
    const appended = attempt(() =>
      store.obligations.appendClearance({
        id: randomUUID(),
        clearanceId: id,
        actor: actor(store, context.sessionId),
        occurredAt: now,
        expectedVersion: version.value,
        idempotencyKey: input.idempotencyKey || randomUUID(),
        payload: payload.value,
      }),
    );
    return appended.ok
      ? success({
          definition: current.value.definition,
          snapshot: appended.value,
        })
      : appended;
  });
  if (!outcome.ok) {
    failCommand(context, outcome.error);
    return;
  }
  context.log(
    `${bold(id)}  ${outcome.value.snapshot.state}  v${outcome.value.snapshot.version}`,
  );
  context.log(`  ${outcome.value.definition.scopeText}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStructuredFile(value: unknown): Result<StructuredFile> {
  if (!isRecord(value)) return failure("JSON must contain an object");
  if (!Array.isArray(value["acts"])) return failure("JSON requires acts[]");
  if (
    value["dependencies"] !== undefined &&
    !Array.isArray(value["dependencies"])
  )
    return failure("JSON dependencies must be an array");
  if (
    value["idempotencyKey"] !== undefined &&
    typeof value["idempotencyKey"] !== "string"
  )
    return failure("JSON idempotencyKey must be a string");
  return success({
    acts: value["acts"] as StructuredActInput[],
    ...(value["dependencies"] === undefined
      ? {}
      : { dependencies: value["dependencies"] as StructuredDependencyInput[] }),
    ...(value["idempotencyKey"] === undefined
      ? {}
      : { idempotencyKey: value["idempotencyKey"] }),
  });
}

const SHORTCUT_COMMANDS = [
  "request",
  "promise",
  "handoff",
  "grant",
  "correct",
  "hazard",
] as const;

export function createObligationCommands(context: CliContext): CommandMap {
  const shortcuts = Object.fromEntries(
    SHORTCUT_COMMANDS.map((command) => [
      command,
      (args: string[]) => shortcut(context, command, args),
    ]),
  );
  return {
    ...shortcuts,
    ask: (args) => {
      const target = args.shift();
      const text = args.join(" ").trim();
      if (!target || !text) return failUsage(context, "ask");
      structured(context, target, [
        { key: "question", type: "question", text },
      ]);
    },
    act: (args) => {
      const target = args.shift();
      const file = takeFlag(args, "--json");
      if (!target || !file) return failUsage(context, "act");
      const decoded = attempt(
        () => JSON.parse(readFileSync(file, "utf8")) as unknown,
      );
      if (!decoded.ok) return failCommand(context, decoded.error);
      const body = parseStructuredFile(decoded.value);
      if (!body.ok) return failCommand(context, body.error);
      structured(
        context,
        target,
        body.value.acts,
        body.value.idempotencyKey ?? randomUUID(),
        body.value.dependencies,
      );
    },
    obligation: (args) => {
      const id = args.shift();
      const eventName = args.shift();
      if (!id) return failUsage(context, "obligation");
      const input = eventName
        ? {
            id,
            eventName,
            version: takeFlag(args, "--version"),
            reason: takeFlag(args, "--reason"),
            resolution: takeFlag(args, "--resolution"),
            target: takeFlag(args, "--to") || undefined,
            replacement: takeFlag(args, "--replacement"),
            episode: takeFlag(args, "--episode"),
            idempotencyKey: takeFlag(args, "--key"),
          }
        : undefined;
      obligation(context, id, input);
    },
    clearance: (args) => {
      const id = args.shift();
      const eventName = args.shift();
      if (!id) return failUsage(context, "clearance");
      const input = eventName
        ? {
            eventName,
            version: takeFlag(args, "--version"),
            reason: takeFlag(args, "--reason"),
            idempotencyKey: takeFlag(args, "--key"),
          }
        : undefined;
      clearance(context, id, input);
    },
  };
}
