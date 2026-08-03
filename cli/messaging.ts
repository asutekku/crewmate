import { bold, cyan, dim, handleColour, red, yellow } from "../core/colour.ts";
import {
  agoText,
  displayName,
  operatorNames,
  type Message,
  type Session,
  type Store,
  withStore,
} from "../core/store.ts";
import {
  booleanFlag,
  parseArguments,
  parseSafeInteger,
  stringFlag,
} from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { resolveLiveName } from "./identity.ts";
import { failure, success, type Result } from "./result.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import type { CliContext, CommandMap } from "./types.ts";

const HUMAN_HANDLE = "human";
const DEFAULT_LOG_RECORD_LIMIT = 20;
const MAX_LOG_RECORD_LIMIT = 2_000;

interface LogInput {
  readonly limit: number;
  readonly raw: boolean;
}

function parseLogInput(argv: readonly string[]): Result<LogInput> {
  const parsed = parseArguments(argv, {
    booleanFlags: ["--raw"],
    maxPositionals: 1,
  });
  if (!parsed.ok) return failure(parsed.error);
  const limit = parseSafeInteger(parsed.value.positionals[0], "log limit", {
    min: 1,
    max: MAX_LOG_RECORD_LIMIT,
  });
  if (!limit.ok) return failure(limit.error);
  return success({
    limit: limit.value ?? DEFAULT_LOG_RECORD_LIMIT,
    raw: booleanFlag(parsed.value, "--raw"),
  });
}

function renderLog(
  messages: readonly Message[],
  sessions: readonly Session[],
  now: number,
  raw: boolean,
): string[] {
  if (messages.length === 0) return [dim("Log is empty.")];
  const show = raw ? (name: string) => name : operatorNames(sessions);
  return messages.map((message) => {
    const when = dim(agoText(message.tsMs, now).padStart(9));
    const from = sanitizeTerminalText(show(message.from));
    const body = sanitizeTerminalText(message.body);
    const paint = handleColour(message.from);
    switch (message.kind) {
      case "note":
        return `${when} ${yellow(bold("you → everyone"))}: ${body}`;
      case "say": {
        const to = message.to
          ? bold(
              handleColour(message.to)(sanitizeTerminalText(show(message.to))),
            )
          : dim("everyone");
        return `${when} ${paint(bold(from))} ${dim("→")} ${to}: ${body}`;
      }
      case "claim":
        return `${when} ${paint(from)} ${red("claim")} ${dim(body)}`;
      case "done":
      case "breaks":
        return `${when} ${paint(from)} ${dim(`${message.kind}: ${body}`)}`;
    }
  });
}

function handleLog(context: CliContext, argv: readonly string[]): void {
  const input = parseLogInput(argv);
  if (!input.ok) return failCommand(context, input.error);
  const now = context.now();
  const view = withStore(context.dbPath, (store) => ({
    messages: store.recent(input.value.limit),
    sessions: store.liveSessions(now),
  }));
  for (const line of renderLog(
    view.messages,
    view.sessions,
    now,
    input.value.raw,
  ))
    context.log(line);
}

function parseText(argv: readonly string[]): string {
  return argv.join(" ").trim();
}

function handleSay(context: CliContext, argv: readonly string[]): void {
  const parsed = parseArguments(argv, {});
  if (!parsed.ok) return failCommand(context, parsed.error);
  const text = parseText(parsed.value.positionals);
  if (!text) return failUsage(context, "say");
  const now = context.now();
  const from = withStore(context.dbPath, (store) => {
    const self = context.sessionId
      ? store.findBySession(context.sessionId)
      : null;
    if (context.sessionId && !self) {
      const handle = store.handleForOrRegister(
        context.sessionId,
        context.projectRoot,
        "",
        now,
      );
      store.post(handle, "say", text, now);
      return handle;
    }
    if (self) {
      store.post(self.handle, "say", text, now);
      return displayName(self);
    }
    store.post(HUMAN_HANDLE, "note", text, now);
    return "you";
  });
  const safeFrom = sanitizeTerminalText(from);
  context.log(
    `${yellow("broadcast")} to ${bold(sanitizeTerminalText(context.projectName))} ${dim(`as ${safeFrom}`)}: ${sanitizeTerminalText(text)}`,
  );
  context.log(
    dim(`Every agent sees this on its next turn, marked as from ${safeFrom}.`),
  );
}

function resolutionFailure(
  role: "agent" | "sender",
  query: string,
  resolution: Extract<ReturnType<typeof resolveLiveName>, { ok: false }>,
): string {
  return resolution.kind === "ambiguous"
    ? `ambiguous ${role} "${query}"; candidates: ${resolution.candidates.join(", ")}`
    : `no live ${role} "${query}"`;
}

function authenticatedSenderPolicy(
  context: CliContext,
  store: Store,
  now: number,
): { readonly handle: string; readonly label: string } {
  if (!context.sessionId) return { handle: HUMAN_HANDLE, label: "you" };
  const self = store.findBySession(context.sessionId);
  if (self) return { handle: self.handle, label: displayName(self) };
  const handle = store.handleForOrRegister(
    context.sessionId,
    context.projectRoot,
    "",
    now,
  );
  return { handle, label: handle };
}

function handleMessage(context: CliContext, argv: readonly string[]): void {
  const parsed = parseArguments(argv, { valueFlags: ["--from"] });
  if (!parsed.ok) return failCommand(context, parsed.error);
  const [target, ...words] = parsed.value.positionals;
  const text = parseText(words);
  if (!target || !text) return failUsage(context, "msg");
  const requestedSender = stringFlag(parsed.value, "--from");
  const now = context.now();
  const result = withStore(
    context.dbPath,
    (store): Result<{ to: Session; fromLabel: string }> => {
      const live = store.liveSessions(now);
      const recipient = resolveLiveName(live, target);
      if (!recipient.ok)
        return failure(resolutionFailure("agent", target, recipient));
      let sender = authenticatedSenderPolicy(context, store, now);
      if (requestedSender !== undefined) {
        const resolved = resolveLiveName(live, requestedSender);
        if (!resolved.ok)
          return failure(
            resolutionFailure("sender", requestedSender, resolved),
          );
        sender = {
          handle: resolved.value.handle,
          label: displayName(resolved.value),
        };
      }
      store.post(sender.handle, "say", text, now, {
        sessionId: recipient.value.sessionId,
        name: displayName(recipient.value),
      });
      return success({ to: recipient.value, fromLabel: sender.label });
    },
  );
  if (!result.ok) return failCommand(context, result.error);
  const from = sanitizeTerminalText(result.value.fromLabel);
  const to = sanitizeTerminalText(displayName(result.value.to));
  context.log(
    `${cyan(from)} ${dim("→")} ${bold(to)}: ${sanitizeTerminalText(text)}`,
  );
  context.log(
    dim(
      `Delivered on their next turn${result.value.to.status === "busy" ? " (busy — will see it after this turn)" : ""}.`,
    ),
  );
}

export function createMessagingCommands(context: CliContext): CommandMap {
  return {
    log: (args) => handleLog(context, args),
    say: (args) => handleSay(context, args),
    msg: (args) => handleMessage(context, args),
  };
}
