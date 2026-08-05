import { briefAgo } from "../core/board.ts";
import { bold, cyan, dim } from "../core/colour.ts";
import { terminalWidth, wrap } from "../core/layout.ts";
import { displayName, withStore } from "../core/store.ts";
import { parseArguments } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { obligation } from "./obligations.ts";
import { failure, success, type Result } from "./result.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import type { CliContext, CommandMap } from "./types.ts";

/**
 * One open question, flattened for rendering.
 *
 * Deliberately NOT `core/questions.ts`'s `Question`: ids here are obligation
 * uuids, not integers, and the rows come from the obligation ledger. The old
 * type is what let `asks` and `answer` compile against a table `ask` had never
 * written to.
 */
interface QuestionRow {
  readonly id: string;
  readonly text: string;
  readonly askedMs: number;
  readonly askerName: string;
  readonly targetName: string;
}

interface QuestionReport {
  readonly mine: readonly QuestionRow[];
  readonly waiting: readonly QuestionRow[];
  readonly now: number;
  readonly width: number;
}

/**
 * `answer <id-prefix> "<text>"` — files the reply as a `fulfil` event.
 *
 * READS THE OBLIGATION LEDGER, NOT `questions`. `ask` writes an obligation and
 * always has; `answer` used to require an integer id from a table `ask` never
 * populated, so it rejected the very uuid `ask` had just printed. The ledger
 * already carries the state machine an answer needs — `fulfil --resolution` is
 * the same event `crew obligation … fulfil` files, so a question answered here
 * and one discharged there fold identically.
 */
function handleAnswer(context: CliContext, argv: readonly string[]): void {
  const parsed = parseArguments(argv, {});
  if (!parsed.ok) return failCommand(context, parsed.error);
  const [idRaw, ...words] = parsed.value.positionals;
  const text = words.join(" ").trim();
  if (!idRaw || !text) return failUsage(context, "answer");
  const target = withStore(context.dbPath, (store): Result<string> => {
    const found = store.obligations.resolveId(idRaw);
    if (!found.ok) return failure(found.error);
    const definition = store.obligations.definition(found.id);
    if (!definition) return failure(`no obligation ${idRaw}`);
    // A `request` or `handoff` is discharged the same way, but through the verb
    // that names what it is doing -- `answer` claiming to answer a handoff
    // would be the kind of mislabelling this whole collapse exists to remove.
    return definition.kind === "question"
      ? success(found.id)
      : failure(
          `${found.id.slice(0, 8)} is a ${definition.kind}, not a question — ` +
            `\`crew obligation ${found.id.slice(0, 8)} fulfil\` discharges it`,
        );
  });
  if (!target.ok) return failCommand(context, target.error);
  obligation(context, target.value, {
    id: target.value,
    eventName: "fulfil",
    version: "",
    reason: "",
    // FREE TEXT, not `resolutionKey`. An answer is prose; `resolutionKey` is
    // validated against the obligation's vocabulary, which `ask` leaves empty.
    resolution: text,
    resolutionKey: "",
    replacement: "",
    episode: "",
    idempotencyKey: "",
  });
}

export function renderQuestionReport(report: QuestionReport): string[] {
  if (report.mine.length === 0 && report.waiting.length === 0)
    return [dim("No open questions.")];
  const lines: string[] = [];
  for (const question of report.mine) {
    // SHORT ID, because it is what the reader types back. The full uuid is one
    // `crew obligation <prefix>` away and nobody retypes 36 characters.
    lines.push(
      `${cyan("?")} ${bold(question.id.slice(0, 8))} from ${sanitizeTerminalText(question.askerName)} ${dim(briefAgo(question.askedMs, report.now))}`,
    );
    for (const line of wrap(
      sanitizeTerminalText(question.text),
      Math.max(40, report.width - 6),
    ))
      lines.push(`    ${line}`);
    lines.push(dim(`    crew answer ${question.id.slice(0, 8)} "<your answer>"`));
  }
  for (const question of report.waiting)
    lines.push(
      dim(
        `… ${question.id.slice(0, 8)} to ${sanitizeTerminalText(question.targetName)}: ${sanitizeTerminalText(question.text)}`,
      ),
    );
  return lines;
}

function handleAsks(context: CliContext, argv: readonly string[]): void {
  const parsed = parseArguments(argv, { maxPositionals: 0 });
  if (!parsed.ok) return failCommand(context, parsed.error);
  const now = context.now();
  const width = terminalWidth();
  const snapshot = withStore(context.dbPath, (store) => {
    const open = store.obligations.openQuestions(context.sessionId);
    const live = store.liveSessions(now);
    // Actor ids are conversation uuids; the reader wants the name on the
    // roster. A departed peer keeps its id as the label rather than vanishing —
    // a question from someone who has gone is still owed.
    const name = (id: string): string => {
      const hit = live.find((s) => s.sessionId === id);
      return hit ? displayName(hit) : id.slice(0, 8);
    };
    return {
      mine: open.mine.map((o) => ({
        id: o.id,
        text: o.text,
        askedMs: o.askedMs,
        askerName: o.asker === "" ? "the operator" : name(o.asker),
        targetName: "",
      })),
      waiting: open.waiting.map((o) => ({
        id: o.id,
        text: o.text,
        askedMs: o.askedMs,
        askerName: "",
        targetName: o.responsible === "" ? "someone" : name(o.responsible),
      })),
    };
  });
  for (const line of renderQuestionReport({ ...snapshot, now, width }))
    context.log(line);
}

export function createQuestionCommands(context: CliContext): CommandMap {
  return {
    answer: (args) => handleAnswer(context, args),
    asks: (args) => handleAsks(context, args),
  };
}
