import { briefAgo } from "../core/board.ts";
import { bold, cyan, dim, green } from "../core/colour.ts";
import { terminalWidth, wrap } from "../core/layout.ts";
import { withStore } from "../core/store.ts";
import { loadConfig } from "../core/config.ts";
import { failUsage } from "./command.ts";
import type { CliContext, CommandMap } from "./types.ts";

export function createQuestionCommands(context: CliContext): CommandMap {
  return {
    answer(args) {
      const idRaw = args.shift();
      const text = args.join(" ").trim();
      if (!idRaw || !text) {
        failUsage(context, "answer");
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const id = Number(idRaw);
        if (!Number.isFinite(id) || id <= 0) {
          failUsage(context, "answer");
          return;
        }
        const question = store.questions.get(id);
        if (!question) {
          context.error(`no question #${id}`);
          context.fail();
          return;
        }
        if (question.targetSession !== context.sessionId) {
          context.error(
            `question #${id} was asked of ${question.targetName || "someone else"}.`,
          );
          context.fail();
          return;
        }
        if (!store.questions.answer(id, text, now)) {
          context.error(`question #${id} is already answered.`);
          context.fail();
          return;
        }
        context.log(
          `${green("✓")} answered ${bold(question.askerName || "the asker")}`,
        );
      });
    },

    asks() {
      withStore(context.dbPath, (store) => {
        const now = context.now();
        store.questions.expireStale(now, loadConfig().staleMs);
        const mine = store.questions.openFor(context.sessionId);
        const waiting = store.questions.pendingFrom(context.sessionId);
        if (mine.length === 0 && waiting.length === 0) {
          context.log(dim("No open questions."));
          return;
        }
        for (const question of mine) {
          context.log(
            `${cyan("?")} ${bold(`#${question.id}`)} from ${question.askerName} ${dim(briefAgo(question.askedMs, now))}`,
          );
          for (const line of wrap(
            question.text,
            Math.max(40, terminalWidth() - 6),
          ))
            context.log(`    ${line}`);
          context.log(dim(`    cli.ts answer ${question.id} "<your answer>"`));
        }
        for (const question of waiting)
          context.log(
            dim(
              `… #${question.id} to ${question.targetName}: ${question.text}`,
            ),
          );
      });
    },
  };
}
