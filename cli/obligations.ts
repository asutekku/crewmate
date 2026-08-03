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
import {
  parseArguments,
  stringFlag,
  type ParsedArguments,
} from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import {
  buildClearanceEvent,
  buildObligationEvent,
  parseVersion,
  type ObligationEventInput,
} from "./obligation-events.ts";
import { resolveTrustedPath } from "./paths.ts";
import { resolveLiveName } from "./identity.ts";
import { attempt, failure, success, type Result } from "./result.ts";
import {
  parseStructuredShortcut,
  type StructuredShortcut,
} from "./structured.ts";
import { decodeStructuredFile } from "./structured-json.ts";
import type { CliContext, CommandMap } from "./types.ts";

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
      const recipient = resolveLiveName(store.liveSessions(now), target);
      if (!self) return failure("this session is not registered");
      if (!recipient.ok)
        return failure(
          recipient.kind === "ambiguous"
            ? `ambiguous live agent ${target}: ${recipient.candidates.join(", ")}`
            : `no live agent named ${target}`,
        );
      return attempt(() =>
        store.obligations.createBatch({
          senderSessionId: context.sessionId,
          senderName: displayName(self),
          recipientSessionId: recipient.value.sessionId,
          recipientName: displayName(recipient.value),
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
      const session = resolveLiveName(store.liveSessions(now), input.target);
      if (!session.ok)
        return failure(
          session.kind === "ambiguous"
            ? `ambiguous live agent ${input.target}: ${session.candidates.join(", ")}`
            : `no live agent named ${input.target}`,
        );
      to = { kind: "agent", agentId: session.value.sessionId };
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

const SHORTCUT_COMMANDS = [
  "request",
  "promise",
  "handoff",
  "grant",
  "correct",
  "hazard",
] as const;

function parsedCommand(
  context: CliContext,
  command: string,
  args: readonly string[],
  schema: Parameters<typeof parseArguments>[1],
): { readonly value: ParsedArguments } | undefined {
  const parsed = parseArguments(args, schema);
  if (!parsed.ok) {
    failCommand(context, `${command}: ${parsed.error}`);
    return undefined;
  }
  return parsed;
}

function handleAsk(context: CliContext, args: readonly string[]): void {
  const parsed = parsedCommand(context, "ask", args, {});
  if (!parsed) return;
  const [target, ...words] = parsed.value.positionals;
  const text = words.join(" ").trim();
  if (!target || !text) return failUsage(context, "ask");
  structured(context, target, [{ key: "question", type: "question", text }]);
}

function handleAct(context: CliContext, args: readonly string[]): void {
  const parsed = parsedCommand(context, "act", args, {
    valueFlags: ["--json"],
    maxPositionals: 1,
  });
  if (!parsed) return;
  const target = parsed.value.positionals[0];
  const file = stringFlag(parsed.value, "--json");
  if (!target || !file) return failUsage(context, "act");
  const path = resolveTrustedPath(file, context.projectRoot, {
    requireRealpath: true,
  });
  if (!path.ok) return failCommand(context, path.error);
  const decoded = attempt(
    () => JSON.parse(readFileSync(path.value.absolute, "utf8")) as unknown,
  );
  if (!decoded.ok) return failCommand(context, decoded.error);
  const body = decodeStructuredFile(decoded.value);
  if (!body.ok) return failCommand(context, body.error);
  structured(
    context,
    target,
    body.value.acts,
    body.value.idempotencyKey ?? randomUUID(),
    body.value.dependencies,
  );
}

function handleObligation(context: CliContext, args: readonly string[]): void {
  const parsed = parsedCommand(context, "obligation", args, {
    valueFlags: [
      "--version", "--reason", "--resolution", "--to",
      "--replacement", "--episode", "--key",
    ],
    maxPositionals: 2,
  });
  if (!parsed) return;
  const [id, eventName] = parsed.value.positionals;
  if (!id) return failUsage(context, "obligation");
  obligation(
    context,
    id,
    eventName
      ? {
          id,
          eventName,
          version: stringFlag(parsed.value, "--version") ?? "",
          reason: stringFlag(parsed.value, "--reason") ?? "",
          resolution: stringFlag(parsed.value, "--resolution") ?? "",
          target: stringFlag(parsed.value, "--to"),
          replacement: stringFlag(parsed.value, "--replacement") ?? "",
          episode: stringFlag(parsed.value, "--episode") ?? "",
          idempotencyKey: stringFlag(parsed.value, "--key") ?? "",
        }
      : undefined,
  );
}

function handleClearance(context: CliContext, args: readonly string[]): void {
  const parsed = parsedCommand(context, "clearance", args, {
    valueFlags: ["--version", "--reason", "--key"],
    maxPositionals: 2,
  });
  if (!parsed) return;
  const [id, eventName] = parsed.value.positionals;
  if (!id) return failUsage(context, "clearance");
  clearance(
    context,
    id,
    eventName
      ? {
          eventName,
          version: stringFlag(parsed.value, "--version") ?? "",
          reason: stringFlag(parsed.value, "--reason") ?? "",
          idempotencyKey: stringFlag(parsed.value, "--key") ?? "",
        }
      : undefined,
  );
}

export function createObligationCommands(context: CliContext): CommandMap {
  const shortcuts = Object.fromEntries(
    SHORTCUT_COMMANDS.map((command) => [
      command,
      (args: readonly string[]) => shortcut(context, command, args),
    ]),
  );
  return {
    ...shortcuts,
    ask: (args) => handleAsk(context, args),
    act: (args) => handleAct(context, args),
    obligation: (args) => handleObligation(context, args),
    clearance: (args) => handleClearance(context, args),
  };
}
