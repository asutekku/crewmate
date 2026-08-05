import { briefAgo } from "../core/board.ts";
import { bold, cyan, dim, green } from "../core/colour.ts";
import { loadConfig } from "../core/config.ts";
import { terminalWidth, wrap } from "../core/layout.ts";
import type { Question } from "../core/questions.ts";
import { withStore } from "../core/store.ts";
import { parseArguments, requireSafeInteger } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import type { CliContext, CommandMap } from "./types.ts";

interface QuestionReport {
  readonly mine: readonly Question[];
  readonly waiting: readonly Question[];
  readonly now: number;
  readonly width: number;
}

function handleAnswer(context: CliContext, argv: readonly string[]): void {
  const parsed = parseArguments(argv, {});
  if (!parsed.ok) return failCommand(context, parsed.error);
  const [idRaw, ...words] = parsed.value.positionals;
  const text = words.join(" ").trim();
  if (!idRaw || !text) return failUsage(context, "answer");
  const id = requireSafeInteger(idRaw, "question id", {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (!id.ok) return failCommand(context, id.error);
  const now = context.now();
  const result = withStore(context.dbPath, (store) =>
    store.questions.answerFor(id.value, context.sessionId, text, now),
  );
  if (!result.ok) {
    const message =
      result.kind === "not_found"
        ? `no question #${id.value}`
        : result.kind === "wrong_target"
          ? `question #${id.value} was asked of ${sanitizeTerminalText(result.question?.targetName || "someone else")}`
          : `question #${id.value} is already answered`;
    return failCommand(context, message);
  }
  context.log(
    `${green("✓")} answered ${bold(sanitizeTerminalText(result.question.askerName || "the asker"))}`,
  );
}

export function renderQuestionReport(report: QuestionReport): string[] {
  if (report.mine.length === 0 && report.waiting.length === 0)
    return [dim("No open questions.")];
  const lines: string[] = [];
  for (const question of report.mine) {
    lines.push(
      `${cyan("?")} ${bold(`#${question.id}`)} from ${sanitizeTerminalText(question.askerName)} ${dim(briefAgo(question.askedMs, report.now))}`,
    );
    for (const line of wrap(
      sanitizeTerminalText(question.text),
      Math.max(40, report.width - 6),
    ))
      lines.push(`    ${line}`);
    lines.push(dim(`    crew answer ${question.id} "<your answer>"`));
  }
  for (const question of report.waiting)
    lines.push(
      dim(
        `… #${question.id} to ${sanitizeTerminalText(question.targetName)}: ${sanitizeTerminalText(question.text)}`,
      ),
    );
  return lines;
}

function handleAsks(context: CliContext, argv: readonly string[]): void {
  const parsed = parseArguments(argv, { maxPositionals: 0 });
  if (!parsed.ok) return failCommand(context, parsed.error);
  const now = context.now();
  const width = terminalWidth();
  const snapshot = withStore(context.dbPath, (store) =>
    store.questions.openSnapshot(context.sessionId, now, loadConfig().staleMs),
  );
  for (const line of renderQuestionReport({ ...snapshot, now, width }))
    context.log(line);
}

export function createQuestionCommands(context: CliContext): CommandMap {
  return {
    answer: (args) => handleAnswer(context, args),
    asks: (args) => handleAsks(context, args),
  };
}
