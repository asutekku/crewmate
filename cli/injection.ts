import { briefAgo } from "../core/board.ts";
import { bold, dim, green, red, yellow } from "../core/colour.ts";
import { pack, type Envelope, type PackResult } from "../core/injection.ts";
import { baseBranch, baseDistance, worktreeRoot } from "../core/repo.ts";
import { sessionEnvelope } from "../core/sessionBlock.ts";
import { baseStalenessLines } from "../core/shared.ts";
import { displayName, withStore, type InjectionLedgerRow, type Session, type Store } from "../core/store.ts";
import { parseArguments, parseSubjectSelector, type SubjectSelector } from "./args.ts";
import { failCommand } from "./command.ts";
import { resolveLiveName } from "./identity.ts";
import { failure, success, type Result } from "./result.ts";
import { sanitizeTerminalText, TerminalReport } from "./terminal.ts";
import type { CliContext, CommandMap } from "./types.ts";

const INJECTION_HISTORY_LIMIT = 40;
const PREVIEW_WIDTH = 52;
const REPORT_KEY_WIDTH = 18;

interface InjectionView {
  readonly recipientName: string;
  readonly sessionShort: string;
  readonly envelope: Envelope;
  readonly packed: PackResult;
  readonly history: readonly InjectionLedgerRow[];
  readonly nowMs: number;
}

function parseSelector(context: CliContext, command: string, args: readonly string[]): SubjectSelector | undefined {
  const parsed = parseArguments(args, {
    valueFlags: ["--agent", "--session"],
    maxPositionals: 0,
  });
  if (!parsed.ok) {
    failCommand(context, `${command}: ${parsed.error}`);
    return undefined;
  }
  const selector = parseSubjectSelector(parsed.value);
  if (!selector.ok) {
    failCommand(context, `${command}: ${selector.error}`);
    return undefined;
  }
  return selector.value;
}

function resolveSubject(
  store: Store,
  selector: SubjectSelector,
  callerSessionId: string,
  nowMs: number,
): Result<Session> {
  const live = store.liveSessions(nowMs);
  if (selector.session) {
    const hit = live.find((session) => session.sessionId === selector.session);
    return hit ? success(hit) : failure(`no live session with id ${selector.session}`);
  }
  if (selector.agent) {
    const hit = resolveLiveName(live, selector.agent);
    return hit.ok
      ? success(hit.value)
      : failure(
          hit.kind === "ambiguous"
            ? `ambiguous live session ${selector.agent}: ${hit.candidates.join(", ")}`
            : `no live session named ${selector.agent}`,
        );
  }
  if (callerSessionId) {
    const hit = live.find((session) => session.sessionId === callerSessionId);
    return hit
      ? success(hit)
      : failure("this session is not on the roster — pass --agent <name>");
  }
  return live.length === 1
    ? success(live[0]!)
    : failure(`cannot tell which session to report on — pass --agent or --session (${live.length} live)`);
}

function clip(value: string): string {
  const text = sanitizeTerminalText(value).replace(/\s+/g, " ");
  return [...text].length <= PREVIEW_WIDTH
    ? text
    : `${[...text].slice(0, PREVIEW_WIDTH - 1).join("")}…`;
}

function renderInbox(
  context: CliContext,
  omissions: readonly { key: string; reason: string; text: string }[],
  self = true,
  who = "",
): void {
  const whose = self ? "your" : `${who}'s`;
  if (omissions.length === 0) {
    context.log(dim(`nothing was omitted from ${whose} session-start context`));
    return;
  }
  context.log(bold(`${omissions.length} item(s) omitted from ${whose} context for length:`));
  context.log("");
  for (const omission of omissions) {
    context.log(`${bold(sanitizeTerminalText(omission.key))} ${dim(`(${sanitizeTerminalText(omission.reason)})`)}`);
    context.log(sanitizeTerminalText(omission.text, true));
    context.log("");
  }
}

function renderInjection(context: CliContext, view: InjectionView): void {
  const { envelope, packed, history, nowMs } = view;
  context.log(`${dim("recipient")} ${view.recipientName} ${dim(view.sessionShort)}`);
  context.log("");
  context.log(bold("mandatory"));
  for (const line of envelope.mandatoryHeader.filter(Boolean))
    context.log(`  ${green("✓")} ${dim(clip(line))} ${dim(`${[...sanitizeTerminalText(line)].length}`)}`);
  const framed = packed.selected.some((item) => item.candidate.requiresPeerFraming);
  for (const line of envelope.peerFraming)
    context.log(`  ${framed ? green("✓") : dim("–")} ${dim(clip(line))} ${dim(`${[...sanitizeTerminalText(line)].length}`)}${framed ? "" : dim(" (no peer text selected)")}`);
  context.log("");
  context.log(bold("selected"));
  if (packed.selected.length === 0) context.log(dim("  nothing"));
  for (const item of packed.selected)
    context.log(`  ${green("✓")} ${sanitizeTerminalText(item.candidate.key).padEnd(REPORT_KEY_WIDTH)} ${dim(`p${item.candidate.priority}`)} ${dim(`${[...sanitizeTerminalText(item.text, true)].length}`)}${item.form === "compact" ? yellow(" compact") : ""}`);
  context.log("");
  context.log(bold("omitted"));
  if (packed.omitted.length === 0) context.log(dim("  nothing"));
  for (const item of packed.omitted)
    context.log(`  ${dim("–")} ${sanitizeTerminalText(item.candidate.key).padEnd(REPORT_KEY_WIDTH)} ${dim(`p${item.candidate.priority}`)} ${red(sanitizeTerminalText(item.reason))}`);
  if (history.length > 0) {
    const delivery = history[0]?.deliveryId ?? 0;
    const latest = history.filter((entry) => entry.deliveryId === delivery);
    context.log("");
    context.log(bold(`last delivered ${dim(briefAgo(latest[0]?.tsMs ?? nowMs, nowMs))}`));
    for (const entry of latest)
      context.log(`  ${entry.outcome === "selected" ? green("✓") : dim("–")} ${sanitizeTerminalText(entry.key).padEnd(REPORT_KEY_WIDTH)} ${dim(`p${entry.priority}`)}${entry.outcome === "selected" ? `${entry.form === "compact" ? yellow(" compact") : ""} ${dim(`${entry.chars}`)}` : ` ${red(sanitizeTerminalText(entry.reason))}`}`);
    const deliveries = new Set(history.map((entry) => entry.deliveryId)).size;
    if (deliveries > 1) context.log(dim(`  (${deliveries} deliveries in history)`));
  }
  const budget = new TerminalReport()
    .blank()
    .line(bold("budget"))
    .field("target", envelope.targetChars)
    .field("rendered", packed.renderedChars)
    .field("reserved", `${packed.reservedChars} (header + framing)`);
  if (packed.mandatoryOverflow)
    budget.line(`  ${red("mandatory overflow")} — the header alone exceeds the target and renders anyway`);
  budget.emit(context.log);
}

function handleInbox(context: CliContext, args: readonly string[]): void {
  const selector = parseSelector(context, "inbox", args);
  if (!selector) return;
  const now = context.now();
  const snapshot = withStore(context.dbPath, (store) => {
    const recipient = resolveSubject(store, selector, context.sessionId, now);
    return recipient.ok
      ? success({
          omissions: store.injectionOmissions(recipient.value.sessionId),
          // WHOSE inbox this is, so the empty line can say so. Reporting a
          // peer's context as "your session-start context" is the attribution
          // slip the README's `human to traffic-c9` anecdote warns about.
          self: recipient.value.sessionId === context.sessionId,
          who: sanitizeTerminalText(displayName(recipient.value)),
        })
      : recipient;
  });
  if (!snapshot.ok) return failCommand(context, snapshot.error);
  renderInbox(context, snapshot.value.omissions, snapshot.value.self, snapshot.value.who);
}

function handleInjection(context: CliContext, args: readonly string[]): void {
  const selector = parseSelector(context, "injection", args);
  if (!selector) return;
  const now = context.now();
  const recipient = withStore(context.dbPath, (store) =>
    resolveSubject(store, selector, context.sessionId, now),
  );
  if (!recipient.ok) return failCommand(context, recipient.error);
  const session = recipient.value;
  const cwd = session.worktree || context.cwd.replace(/\\/g, "/");
  const tree = worktreeRoot(cwd);
  const inWorktree = context.isGit && tree !== context.projectRoot;
  const base = inWorktree ? baseBranch(cwd) : "";
  const distance = inWorktree ? baseDistance(cwd, base) : null;
  const view = withStore(context.dbPath, (store): InjectionView => {
    const envelope = sessionEnvelope(store, {
      me: sanitizeTerminalText(displayName(session)),
      projectName: context.projectName,
      sessionId: session.sessionId,
      tree,
      now,
      staleness: baseStalenessLines(distance, base, inWorktree),
      lineageFrom: session.lineageFrom,
    });
    return {
      recipientName: sanitizeTerminalText(displayName(session)),
      sessionShort: sanitizeTerminalText(session.sessionId.slice(0, 8)),
      envelope,
      packed: pack(envelope, store.injectionExposures(session.sessionId)),
      history: store.injectionHistory(session.sessionId, INJECTION_HISTORY_LIMIT),
      nowMs: now,
    };
  });
  renderInjection(context, view);
}

export function createInjectionCommands(context: CliContext): CommandMap {
  return {
    inbox: (args) => handleInbox(context, args),
    injection: (args) => handleInjection(context, args),
  };
}
