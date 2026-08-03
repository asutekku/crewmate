import { bold, cyan, dim, green, red } from "../core/colour.ts";
import { shortAge, terminalWidth, wrap } from "../core/layout.ts";
import { discipleName } from "../core/names.ts";
import { checkMemory, lineageKey, withPersonal } from "../core/personal.ts";
import { displayName, withStore, type Session } from "../core/store.ts";
import { takeFlag } from "./args.ts";
import { failUsage } from "./command.ts";
import { failCommand } from "./command.ts";
import { notAnAgent } from "./identity.ts";
import { failure, success } from "./result.ts";
import type { CliContext, CommandMap } from "./types.ts";

function lineageOf(session: Session): string {
  return session.lineageFrom !== ""
    ? session.lineageFrom
    : lineageKey(displayName(session), session.sessionId);
}

export function createPersonalCommands(context: CliContext): CommandMap {
  return {
    remember(args) {
      const body = takeFlag(args, "--body");
      const tagList = takeFlag(args, "--tags");
      const globalIndex = args.indexOf("--global");
      const isGlobal = globalIndex >= 0;
      if (isGlobal) args.splice(globalIndex, 1);
      const check = checkMemory(
        args.join(" ").trim(),
        body,
        tagList.split(",").filter((tag) => tag.trim() !== ""),
      );
      if (!check.ok) {
        context.error(`${red("✗")} ${check.why}`);
        context.fail();
        return;
      }
      if (context.sessionId === "") return notAnAgent(context, "`remember`");
      const now = context.now();
      const self = withStore(context.dbPath, (store) =>
        store.findBySession(context.sessionId),
      );
      const name = self ? displayName(self) : "";
      const lineage = self
        ? lineageOf(self)
        : lineageKey(name, context.sessionId);
      withPersonal((personal) => {
        const id = personal.remember(
          context.sessionId,
          name,
          check,
          isGlobal ? "" : context.projectName,
          isGlobal,
          now,
          lineage,
        );
        context.log(`${green("✓")} ${bold(`#${id}`)} ${check.title}`);
        context.log(
          dim(
            isGlobal
              ? "  global — you will carry this into every project"
              : `  ${context.projectName} only — add \`--global\` if it is true of them everywhere`,
          ),
        );
      });
    },

    "about-me"(args) {
      const target = takeFlag(args, "--agent");
      const allProjects = args.includes("--all-projects");
      const now = context.now();
      const resolved = withStore(context.dbPath, (store) => {
        if (target) {
          const session = store.findByName(target, now);
          return session
            ? { lineage: lineageOf(session), name: displayName(session) }
            : { lineage: target.trim().toLowerCase(), name: target.trim() };
        }
        if (!context.sessionId) return null;
        const self = store.findBySession(context.sessionId);
        const name = self ? displayName(self) : "";
        return {
          lineage: self ? lineageOf(self) : lineageKey(name, context.sessionId),
          name,
        };
      });
      withPersonal((personal) => {
        if (!resolved) {
          const held = personal.lineages();
          if (held.length === 0) {
            context.log(dim("no agent has recorded anything about you yet."));
            return;
          }
          context.log(bold("lineages holding memories about you"));
          for (const lineage of held) {
            const who = lineage.lineage.startsWith("session:")
              ? lineage.lineage.slice(8, 16)
              : lineage.lineage;
            context.log(
              `  ${cyan(who)} ${dim(`— ${lineage.count}`)}  ${dim(`cli.ts about-me --agent ${who}`)}`,
            );
          }
          return;
        }
        const memories = personal.forLineage(
          resolved.lineage,
          context.projectName,
          { allProjects },
        );
        if (memories.length === 0) {
          context.log(
            dim(
              `${resolved.name || "this agent"} has recorded nothing about you here.`,
            ),
          );
          if (!allProjects)
            context.log(dim("  `--all-projects` looks in every repo."));
          return;
        }
        const now = context.now();
        const width = terminalWidth();
        context.log(
          bold(`what ${resolved.name || "this agent"} remembers about you`),
        );
        for (const memory of memories) {
          const head = `  ${dim(`#${memory.id}`)} `;
          const headLength = `  #${memory.id} `.length;
          for (const [index, line] of wrap(
            memory.title,
            Math.max(20, width - headLength),
          ).entries())
            context.log(
              index === 0 ? head + line : " ".repeat(headLength) + line,
            );
          const where = memory.global
            ? cyan("everywhere")
            : dim(`${memory.project} only`);
          context.log(
            `${" ".repeat(headLength)}${where} ${dim(`· ${shortAge(memory.tsMs, now)}`)}`,
          );
          if (memory.body)
            for (const line of wrap(
              memory.body,
              Math.max(20, width - headLength),
            ))
              context.log(dim(" ".repeat(headLength) + line));
        }
        context.log(dim("  `cli.ts forget <id>` removes one."));
      });
    },

    inherit(args) {
      const target = args.join(" ").trim();
      if (!target) {
        withPersonal((personal) => {
          const held = personal
            .lineages()
            .filter((lineage) => !lineage.lineage.startsWith("session:"));
          if (held.length === 0) {
            context.log(dim("no lineage has recorded anything yet."));
            return;
          }
          const now = context.now();
          const rows = withStore(context.dbPath, (store) =>
            held.map((lineage) => ({
              ...lineage,
              live: store.liveHolder(lineage.lineage, now) !== null,
            })),
          );
          const free = rows.filter((lineage) => !lineage.live);
          const busy = rows.filter((lineage) => lineage.live);
          if (free.length > 0) {
            context.log(bold("lineages you could take up"));
            for (const lineage of free)
              context.log(
                `  ${cyan(lineage.lineage)} ${dim(`${lineage.count} ${lineage.count === 1 ? "memory" : "memories"}`)} ${dim(`· last active ${shortAge(lineage.lastMs, now)}`)}`,
              );
            context.log(dim("  `cli.ts inherit <name>` takes one up."));
          } else context.log(dim("no lineage is free to take up right now."));
          if (busy.length > 0) {
            context.log(bold("\nstill held — ask them instead of inheriting"));
            for (const lineage of busy)
              context.log(
                `  ${cyan(lineage.lineage)} ${dim(`${lineage.count} ${lineage.count === 1 ? "memory" : "memories"}`)}`,
              );
          }
        });
        return;
      }
      if (!context.sessionId) return notAnAgent(context, "`inherit`");
      const key = target.toLowerCase();
      const now = context.now();
      const outcome = withStore(context.dbPath, (store) => {
        const self = store.findBySession(context.sessionId);
        const me = self ? displayName(self) : "";
        if (key === me.toLowerCase()) return failure("that is your own name");
        const holder = store.liveHolder(key, now);
        if (holder)
          return failure(
            `${displayName(holder)} is live and still holds it — inheriting now would fork it`,
          );
        store.setLineage(context.sessionId, key);
        return success(me);
      });
      if (!outcome.ok) {
        failCommand(context, outcome.error);
        return;
      }
      const count = withPersonal(
        (personal) => personal.forLineage(key, context.projectName).length,
      );
      context.log(
        `${green("✓")} you are ${bold(discipleName(outcome.value, key))}`,
      );
      context.log(
        dim(
          count === 0
            ? `  ${key} left no memories in ${context.projectName} — you start clean, under its name`
            : `  ${count} ${count === 1 ? "memory" : "memories"} from ${key}, unverified by you — \`cli.ts about-me\` reads them`,
        ),
      );
    },

    forget(args) {
      const id = Number(args[0]);
      if (!Number.isFinite(id) || id <= 0) {
        failUsage(context, "forget");
        return;
      }
      withPersonal((personal) => {
        const memory = personal.get(id);
        if (!memory || !personal.forget(id)) {
          context.error(`no memory #${id}`);
          context.fail();
          return;
        }
        context.log(`${green("✓")} forgotten: ${dim(memory.title)}`);
      });
    },
  };
}
