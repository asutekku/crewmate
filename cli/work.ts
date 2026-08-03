import { agentTally, briefAge, itemLines } from "../core/board.ts";
import type { BoardPaint } from "../core/board.ts";
import {
  bold,
  cyan,
  dim,
  green,
  handleColour,
  red,
  yellow,
} from "../core/colour.ts";
import { fit, terminalWidth } from "../core/layout.ts";
import {
  displayName,
  operatorNames,
  rosterName,
  withStore,
  type Store,
} from "../core/store.ts";
import {
  agentKey,
  BOARD_OPEN_SHOWN,
  foldEvents,
  normalisePlanPath,
  parsePlan,
  progress,
} from "../core/work.ts";
import { briefAgo } from "../core/board.ts";
import { takeFlag } from "./args.ts";
import { failUsage } from "./command.ts";
import { callerIdentity, notAnAgent } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

const BOARD_PAINT: BoardPaint = { bold, dim, green, red, cyan, name: cyan };

function noOpenItem(context: CliContext, match: string): void {
  context.error(
    match !== ""
      ? `no open work item matching ${bold(match)}.`
      : "no open work item.",
  );
  context.error(
    dim('  Open one with `cli.ts doing "<subject>" --plan "a; b; c"`.'),
  );
  context.fail();
}

function printProgress(
  context: CliContext,
  store: Store,
  workId: number,
  subject: string,
): void {
  const state = progress(store.work.steps(workId));
  context.log(
    `${green("✓")} ${bold(subject)} ${dim(`${state.done}/${state.total}`)}`,
  );
  if (state.current)
    context.log(
      `  ${dim("next")}  ${state.current.idx}  ${state.current.text}`,
    );
  else if (state.total > 0)
    context.log(dim("  every step ticked — `cli.ts done` to close it"));
}

function resolveAgentId(
  store: Store,
  query: string,
  nowMs: number,
): string | undefined {
  const live = store.findByName(query, nowMs);
  if (live) return agentKey(live.title, live.sessionId);
  const lower = query.toLowerCase();
  return store.work
    .items({ includeClosed: true })
    .find((item) => item.agentName.toLowerCase() === lower)?.agentId;
}

function printHistory(
  context: CliContext,
  store: Store,
  items: readonly { workId: number; subject: string; startedMs: number }[],
  nowMs: number,
  width: number,
): void {
  for (const item of items) {
    context.log("");
    context.log(
      `  ${bold(item.subject)} ${dim(`started ${briefAgo(item.startedMs, nowMs)}`)}`,
    );
    for (const event of store.work.events(item.workId)) {
      const when = dim(briefAge(event.tsMs, nowMs).padStart(6));
      const ref = event.ref !== "" ? ` ${cyan(event.ref)}` : "";
      context.log(
        `  ${when}  ${dim(event.kind.padEnd(8))}${ref} ${fit(event.body, width - 22)}`,
      );
    }
  }
  context.log("");
}

export function createWorkCommands(context: CliContext): CommandMap {
  return {
    doing(args) {
      let plan = "";
      const planIndex = args.indexOf("--plan");
      if (planIndex >= 0) {
        plan = args[planIndex + 1] ?? "";
        args.splice(planIndex, 2);
      }
      const planDoc = takeFlag(args, "--plan-doc");
      const subject = args.join(" ").trim();
      if (!subject) {
        failUsage(context, "doing");
        return;
      }
      withStore(context.dbPath, (store) => {
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`doing`");
        const now = context.now();
        const steps = parsePlan(plan);
        store.work.closeAuto(me.agentId, now);
        const linkPath = normalisePlanPath(planDoc);
        const workId = store.work.open(
          me.agentId,
          me.agentName,
          subject,
          steps,
          now,
          linkPath,
        );
        context.log(
          `${cyan("▸")} ${bold(subject)} ${dim(`— work #${workId}`)}`,
        );
        for (const [index, step] of steps.entries())
          context.log(`    ${dim(String(index + 1))}  ${step}`);
        if (steps.length === 0)
          context.log(
            dim('    no checklist — `cli.ts add "<step>"` if phases appear'),
          );
        if (linkPath !== "") context.log(dim(`    executing ${linkPath}`));
        context.log(
          dim(
            "  Peers see it with `cli.ts board`. Close it with `cli.ts done`.",
          ),
        );
      });
    },

    did(args) {
      const stepNumber = Number(args.shift());
      const match = takeFlag(args, "--item");
      if (!Number.isInteger(stepNumber) || stepNumber < 1) {
        failUsage(context, "did");
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`did`");
        const item = store.work.target(me.agentId, match);
        if (!item) return noOpenItem(context, match);
        if (
          !store.work.tick(item.workId, stepNumber, args.join(" ").trim(), now)
        ) {
          const steps = store.work.steps(item.workId);
          context.error(`${bold(item.subject)} has no step ${stepNumber}.`);
          for (const step of steps)
            context.error(dim(`  ${step.idx}  ${step.text}`));
          if (steps.length === 0)
            context.error(dim('  (no checklist — `cli.ts add "<step>"`)'));
          context.fail();
          return;
        }
        printProgress(context, store, item.workId, item.subject);
      });
    },

    step(args) {
      const stepNumber = Number(args.shift());
      const match = takeFlag(args, "--item");
      const status = args.join(" ").trim();
      if (!Number.isInteger(stepNumber) || stepNumber < 1 || !status) {
        failUsage(context, "step");
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`step`");
        const item = store.work.target(me.agentId, match);
        if (!item) return noOpenItem(context, match);
        store.work.record(item.workId, "step", status, now, String(stepNumber));
        context.log(
          `${cyan("▪")} ${bold(item.subject)} ${dim(`step ${stepNumber}`)}: ${status}`,
        );
      });
    },

    add(args) {
      const match = takeFlag(args, "--item");
      const text = args.join(" ").trim();
      if (!text) {
        failUsage(context, "add");
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`add`");
        const item = store.work.target(me.agentId, match);
        if (!item) return noOpenItem(context, match);
        const index = store.work.addStep(item.workId, text, now);
        context.log(
          `${green("+")} ${bold(item.subject)} ${dim(`step ${index}`)}: ${text}`,
        );
      });
    },

    done(args) {
      const abandonedIndex = args.indexOf("--abandoned");
      const abandoned = abandonedIndex >= 0;
      if (abandoned) args.splice(abandonedIndex, 1);
      const body = takeFlag(args, "--note");
      const match = args.join(" ").trim();
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`done`");
        const item = store.work.target(me.agentId, match);
        if (!item) return noOpenItem(context, match);
        const outcome = abandoned ? "abandoned" : "done";
        const state = progress(store.work.steps(item.workId));
        store.work.close(item.workId, outcome, body, now);
        context.log(
          `${abandoned ? red("✗") : green("✓")} ${bold(item.subject)} ${dim(outcome)}`,
        );
        if (!abandoned && state.outstanding.length > 0) {
          context.log(
            dim(`  ${state.outstanding.length} step(s) were still outstanding`),
          );
        }
        const remaining = store.work.openItems(me.agentId);
        if (remaining.length > 0)
          context.log(
            dim(
              `  still open: ${remaining.map((item) => item.subject).join(", ")}`,
            ),
          );
      });
    },

    link(args) {
      const match = takeFlag(args, "--item");
      const planDoc = args.join(" ").trim();
      if (!planDoc) {
        failUsage(context, "link");
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`link`");
        const item = store.work.target(me.agentId, match);
        if (!item) return noOpenItem(context, match);
        const path = normalisePlanPath(planDoc);
        if (!store.work.link(item.workId, path, now)) {
          context.error(`no work item #${item.workId}`);
          context.fail();
          return;
        }
        context.log(`${green("✓")} ${bold(item.subject)} ${dim("→")} ${path}`);
        context.log(
          dim(
            "  `cli.ts plans` shows what each plan's work has actually shipped.",
          ),
        );
      });
    },

    plans() {
      withStore(context.dbPath, (store) => {
        const rollups = store.work.planRollups();
        if (rollups.length === 0) {
          context.log(dim("No work item names a plan document yet."));
          context.log(
            dim(
              '  `cli.ts doing "<subject>" --plan-doc <path>` opens one against a plan,',
            ),
          );
          context.log(
            dim(
              "  `cli.ts link <path>` points an item that is already open at one.",
            ),
          );
          return;
        }
        const now = context.now();
        for (const rollup of rollups) {
          const progressText =
            rollup.stepsTotal > 0
              ? `${rollup.stepsDone}/${rollup.stepsTotal}`
              : "no steps";
          const state =
            rollup.openItems > 0
              ? cyan("open")
              : rollup.shas.length > 0
                ? green("shipped")
                : dim("closed");
          context.log(
            `${bold(rollup.planDoc)}  ${state} ${dim(`· ${progressText} · ${briefAgo(rollup.updatedMs, now)}`)}`,
          );
          context.log(
            dim(
              `    ${rollup.agents.join(", ")} — ${rollup.items.length} item(s)`,
            ),
          );
          if (rollup.shas.length > 0)
            context.log(`    ${green("landed")} ${rollup.shas.join(" ")}`);
        }
      });
    },

    mine() {
      withStore(context.dbPath, (store) => {
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`mine`");
        const now = context.now();
        const items = store.work.openItems(me.agentId);
        if (items.length === 0) {
          context.log(dim("No open work items."));
          context.log(
            dim('  `cli.ts doing "<subject>" --plan "a; b; c"` opens one.'),
          );
          return;
        }
        for (const item of items) {
          const steps = store.work.steps(item.workId);
          const fold = foldEvents(store.work.events(item.workId));
          for (const line of itemLines(
            item,
            steps,
            fold,
            now,
            terminalWidth(),
            BOARD_PAINT,
          ))
            context.log(line);
        }
      });
    },

    board(args) {
      const historyIndex = args.indexOf("--history");
      const history = historyIndex >= 0;
      if (history) args.splice(historyIndex, 1);
      const allIndex = args.indexOf("--all");
      const all = allIndex >= 0;
      if (all) args.splice(allIndex, 1);
      const rawIndex = args.indexOf("--raw");
      const raw = rawIndex >= 0;
      if (raw) args.splice(rawIndex, 1);
      const who = args.join(" ").trim();
      withStore(context.dbPath, (store) => {
        const now = context.now();
        store.work.pruneWork(now);
        const showName = operatorNames(store.liveSessions(now));
        const target = who !== "" ? resolveAgentId(store, who, now) : undefined;
        if (who !== "" && target === undefined) {
          context.error(`no work records for ${bold(who)}.`);
          context.fail();
          return;
        }
        const items = store.work.items({
          ...(target !== undefined ? { agentId: target } : {}),
          includeClosed: all || history,
        });
        if (items.length === 0) {
          context.log(dim(`No work records in ${context.projectName}.`));
          context.log(
            dim('  Agents open one with `cli.ts doing "<subject>"`.'),
          );
          return;
        }
        const width = terminalWidth();
        if (history) return printHistory(context, store, items, now, width);
        const byAgent = new Map<string, typeof items>();
        for (const item of items) {
          const group = byAgent.get(item.agentId);
          if (group) group.push(item);
          else byAgent.set(item.agentId, [item]);
        }
        for (const [agentId, group] of byAgent) {
          const first = group[0];
          if (!first) continue;
          const open = group.filter((item) => item.closedMs === 0);
          const closed = group.length - open.length;
          const tally = agentTally(open.length, all || history ? closed : 0);
          const stored =
            first.agentName !== "" ? first.agentName : first.agentId;
          const live = agentId.startsWith("session:")
            ? store.findBySession(agentId.slice("session:".length))
            : null;
          const name = raw
            ? stored
            : live
              ? rosterName(live)
              : showName(stored);
          const gap = Math.max(1, width - 2 - [...name].length - tally.length);
          context.log("");
          context.log(
            `  ${bold(handleColour(name)(name))}${" ".repeat(gap)}${dim(tally)}`,
          );
          const shown = group.slice(0, BOARD_OPEN_SHOWN + closed);
          for (const item of shown) {
            const steps = store.work.steps(item.workId);
            const fold = foldEvents(store.work.events(item.workId));
            for (const line of itemLines(
              item,
              steps,
              fold,
              now,
              width,
              BOARD_PAINT,
            ))
              context.log(line);
          }
          const hidden = group.length - shown.length;
          if (hidden > 0) context.log(dim(`    +${hidden} more`));
        }
        context.log("");
        if (!all) {
          const withClosed = store.work.items({
            ...(target !== undefined ? { agentId: target } : {}),
            includeClosed: true,
          });
          const closed = withClosed.length - items.length;
          if (closed > 0)
            context.log(
              dim(`  ${closed} closed — \`board --all\` to include them`),
            );
        }
      });
    },

    breaks: (args) => flag(context, "breaks", args),
    needs: (args) => flag(context, "needs", args),
  };
}

function flag(
  context: CliContext,
  kind: "breaks" | "needs",
  args: string[],
): void {
  const match = takeFlag(args, "--item");
  const text = args.join(" ").trim();
  if (!text) {
    context.error(`usage: cli.ts ${kind} "<what>" [--item <subject match>]`);
    context.error(
      dim(
        kind === "breaks"
          ? "  Recorded on your item AND messaged to agents who have edited the same files."
          : "  Recorded on your item, for whoever reads the board.",
      ),
    );
    context.fail();
    return;
  }
  withStore(context.dbPath, (store) => {
    const me = callerIdentity(context, store);
    if (!me) return notAnAgent(context, `\`${kind}\``);
    const now = context.now();
    const item = store.work.target(me.agentId, match);
    if (!item) {
      context.error(`${red("✗")} no open work item to attach this to`);
      context.error(dim('  `cli.ts doing "<subject>"` opens one.'));
      context.fail();
      return;
    }
    store.work.record(item.workId, kind, text, now);
    context.log(
      `${kind === "breaks" ? red("⚠") : yellow("•")} ${bold(item.subject)} ${dim(`— ${kind}`)}`,
    );
    context.log(`  ${text}`);
    if (kind !== "breaks") {
      context.log(
        dim(
          "  recorded on the board; `needs` tells the reader, not the roster",
        ),
      );
      return;
    }
    const since = now - 24 * 60 * 60 * 1000;
    const ownPaths = new Set(
      store.editsBy(context.sessionId, since).map((edit) => edit.path),
    );
    const reached: string[] = [];
    for (const peer of store.liveSessions(now)) {
      if (peer.sessionId === context.sessionId) continue;
      if (
        !store
          .editsBy(peer.sessionId, since)
          .some((edit) => ownPaths.has(edit.path))
      )
        continue;
      store.post(
        me.agentName,
        "breaks",
        `${text} (in "${item.subject}")`,
        now,
        { sessionId: peer.sessionId, name: displayName(peer) },
      );
      reached.push(displayName(peer));
    }
    context.log(
      reached.length > 0
        ? dim(`  told ${reached.join(", ")} — they have edited files you have`)
        : dim(
            "  nobody else has been in your files today, so nobody was messaged",
          ),
    );
  });
}
