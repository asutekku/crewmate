import {
  agoText,
  displayName,
  operatorNames,
  withStore,
} from "../core/store.ts";
import { bold, cyan, dim, handleColour, red, yellow } from "../core/colour.ts";
import { failUsage } from "./command.ts";
import { failCommand } from "./command.ts";
import { failure, success } from "./result.ts";
import type { CliContext, CommandMap } from "./types.ts";

const HUMAN_HANDLE = "human";

export function createMessagingCommands(context: CliContext): CommandMap {
  return {
    log(args) {
      const limit = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 20) || 20;
      const raw = args.includes("--raw");
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const messages = store.recent(limit);
        if (messages.length === 0) {
          context.log(dim("Log is empty."));
          return;
        }
        const show = raw
          ? (name: string) => name
          : operatorNames(store.liveSessions(now));
        for (const message of messages) {
          const when = dim(agoText(message.tsMs, now).padStart(9));
          const paint = handleColour(message.from);
          if (message.kind === "note")
            context.log(
              `${when} ${yellow(bold("you → everyone"))}: ${message.body}`,
            );
          else if (message.kind === "say") {
            const to = message.to
              ? bold(handleColour(message.to)(show(message.to)))
              : dim("everyone");
            context.log(
              `${when} ${paint(bold(show(message.from)))} ${dim("→")} ${to}: ${message.body}`,
            );
          } else if (message.kind === "claim")
            context.log(
              `${when} ${paint(show(message.from))} ${red("claim")} ${dim(message.body)}`,
            );
          else
            context.log(
              `${when} ${paint(show(message.from))} ${dim(`${message.kind}: ${message.body}`)}`,
            );
        }
      });
    },
    say(args) {
      const text = args.join(" ").trim();
      if (!text) {
        failUsage(context, "say");
        return;
      }
      const from = withStore(context.dbPath, (store) => {
        const now = context.now();
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
        return null;
      });
      const who = from ?? "you";
      context.log(
        `${yellow("broadcast")} to ${bold(context.projectName)} ${dim(`as ${who}`)}: ${text}`,
      );
      context.log(
        dim(`Every agent sees this on its next turn, marked as from ${who}.`),
      );
    },
    msg(args) {
      const fromIndex = args.indexOf("--from");
      let from: string | undefined;
      if (fromIndex >= 0) {
        from = args[fromIndex + 1];
        args.splice(fromIndex, 2);
      }
      const target = args.shift();
      const text = args.join(" ").trim();
      if (!target || !text) {
        failUsage(context, "msg");
        return;
      }
      const result = withStore(context.dbPath, (store) => {
        const now = context.now();
        const to = store.findByName(target, now);
        const liveNames = () =>
          store.liveSessions(now).map(displayName).join(", ");
        if (!to)
          return failure(
            `No live agent "${target}" in ${context.projectName}.${liveNames() ? ` Live agents: ${liveNames()}` : ""}`,
          );
        let handle = HUMAN_HANDLE;
        let fromLabel = "you";
        if (from !== undefined) {
          const sender = store.findByName(from, now);
          if (!sender)
            return failure(
              `No live sender "${from}" in ${context.projectName}.${liveNames() ? ` Live agents: ${liveNames()}` : ""}`,
            );
          handle = sender.handle;
          fromLabel = displayName(sender);
        } else if (context.sessionId) {
          const self = store.findBySession(context.sessionId);
          handle = self
            ? self.handle
            : store.handleForOrRegister(
                context.sessionId,
                context.projectRoot,
                "",
                now,
              );
          fromLabel = self ? displayName(self) : handle;
        }
        store.post(handle, "say", text, now, {
          sessionId: to.sessionId,
          name: displayName(to),
        });
        return success({ to, fromLabel });
      });
      if (!result.ok) {
        failCommand(context, result.error);
        return;
      }
      context.log(
        `${cyan(result.value.fromLabel)} ${dim("→")} ${bold(displayName(result.value.to))}: ${text}`,
      );
      context.log(
        dim(
          `Delivered on their next turn${result.value.to.status === "busy" ? " (busy — will see it after this turn)" : ""}.`,
        ),
      );
    },
  };
}
