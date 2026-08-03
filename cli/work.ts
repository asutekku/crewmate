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
  type WorkEvent,
  type WorkItem,
  type WorkStep,
} from "../core/work.ts";
import { briefAgo } from "../core/board.ts";
import {
  booleanFlag,
  parseArguments,
  requireSafeInteger,
  stringFlag,
  type ParsedArguments,
} from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { callerIdentity, notAnAgent, resolveLiveName } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

const BOARD_PAINT: BoardPaint = { bold, dim, green, red, cyan, name: cyan };
const BREAK_NOTIFICATION_WINDOW_MS = 24 * 60 * 60 * 1000;

function commandArguments(
  context: CliContext,
  command: string,
  argv: readonly string[],
  schema: Parameters<typeof parseArguments>[1],
): ParsedArguments | undefined {
  const parsed = parseArguments(argv, schema);
  if (parsed.ok) return parsed.value;
  failCommand(context, `${command}: ${parsed.error}`);
  return undefined;
}

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

interface WorkItemView {
  readonly item: WorkItem;
  readonly steps: readonly WorkStep[];
  readonly events: readonly WorkEvent[];
}

function renderMine(
  context: CliContext,
  views: readonly WorkItemView[],
  nowMs: number,
  width: number,
): void {
  if (views.length === 0) {
    context.log(dim("No open work items."));
    context.log(dim('  `cli.ts doing "<subject>" --plan "a; b; c"` opens one.'));
    return;
  }
  for (const view of views) {
    const fold = foldEvents(view.events);
    for (const line of itemLines(view.item, view.steps, fold, nowMs, width, BOARD_PAINT))
      context.log(line);
  }
}

type AgentResolution =
  | { readonly ok: true; readonly agentId: string }
  | {
      readonly ok: false;
      readonly kind: "not_found" | "ambiguous";
      readonly candidates: readonly string[];
    };

function resolveAgentId(
  store: Store,
  query: string,
  nowMs: number,
): AgentResolution {
  const live = resolveLiveName(store.liveSessions(nowMs), query);
  if (live.ok)
    return { ok: true, agentId: agentKey(live.value.title, live.value.sessionId) };
  if (live.kind === "ambiguous") return live;
  const lower = query.toLowerCase();
  const historical = store.work
    .items({ includeClosed: true })
    .filter((item) => item.agentName.toLowerCase() === lower);
  const byAgent = new Map(historical.map((item) => [item.agentId, item]));
  if (byAgent.size === 1)
    return { ok: true, agentId: byAgent.keys().next().value! };
  if (byAgent.size === 0)
    return { ok: false, kind: "not_found", candidates: [] };
  return {
    ok: false,
    kind: "ambiguous",
    candidates: [...byAgent.values()]
      .map((item) => `${item.agentName} (${item.agentId.slice(-6)})`)
      .sort((a, b) => a.localeCompare(b)),
  };
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
      const input = commandArguments(context, "doing", args, {
        valueFlags: ["--plan", "--plan-doc"],
      });
      if (!input) return;
      const plan = stringFlag(input, "--plan") ?? "";
      const planDoc = stringFlag(input, "--plan-doc") ?? "";
      const subject = input.positionals.join(" ").trim();
      if (!subject) {
        failUsage(context, "doing");
        return;
      }
      withStore(context.dbPath, (store) => {
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`doing`");
        const now = context.now();
        const steps = parsePlan(plan);
        const linkPath = normalisePlanPath(planDoc);
        const workId = store.work.replaceAutoWithWork(
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
      const input = commandArguments(context, "did", args, {
        valueFlags: ["--item"],
      });
      if (!input) return;
      const parsedStep = requireSafeInteger(input.positionals[0], "step", {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      if (!parsedStep.ok)
        return failCommand(context, `did: ${parsedStep.error}`);
      const stepNumber = parsedStep.value;
      const match = stringFlag(input, "--item") ?? "";
      const note = input.positionals.slice(1).join(" ").trim();
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`did`");
        const item = store.work.target(me.agentId, match);
        if (!item) return noOpenItem(context, match);
        if (
          !store.work.tick(item.workId, stepNumber, note, now)
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
      const input = commandArguments(context, "step", args, {
        valueFlags: ["--item"],
      });
      if (!input) return;
      const parsedStep = requireSafeInteger(input.positionals[0], "step", {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      if (!parsedStep.ok)
        return failCommand(context, `step: ${parsedStep.error}`);
      const stepNumber = parsedStep.value;
      const match = stringFlag(input, "--item") ?? "";
      const status = input.positionals.slice(1).join(" ").trim();
      if (!status) {
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
      const input = commandArguments(context, "add", args, {
        valueFlags: ["--item"],
      });
      if (!input) return;
      const match = stringFlag(input, "--item") ?? "";
      const text = input.positionals.join(" ").trim();
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
      const input = commandArguments(context, "done", args, {
        valueFlags: ["--note"],
        booleanFlags: ["--abandoned"],
      });
      if (!input) return;
      const abandoned = booleanFlag(input, "--abandoned");
      const body = stringFlag(input, "--note") ?? "";
      const match = input.positionals.join(" ").trim();
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
      const input = commandArguments(context, "link", args, {
        valueFlags: ["--item"],
      });
      if (!input) return;
      const match = stringFlag(input, "--item") ?? "";
      const planDoc = input.positionals.join(" ").trim();
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

    plans(args) {
      const input = commandArguments(context, "plans", args, {
        maxPositionals: 0,
      });
      if (!input) return;
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

    mine(args) {
      const input = commandArguments(context, "mine", args, {
        maxPositionals: 0,
      });
      if (!input) return;
      const now = context.now();
      const width = terminalWidth();
      const views = withStore(context.dbPath, (store): WorkItemView[] | null => {
        const me = callerIdentity(context, store);
        if (!me) {
          notAnAgent(context, "`mine`");
          return null;
        }
        const items = store.work.openItems(me.agentId);
        return items.map((item) => ({
          item,
          steps: store.work.steps(item.workId),
          events: store.work.events(item.workId),
        }));
      });
      if (views) renderMine(context, views, now, width);
    },

    board(args) {
      const input = commandArguments(context, "board", args, {
        booleanFlags: ["--history", "--all", "--raw"],
      });
      if (!input) return;
      const history = booleanFlag(input, "--history");
      const all = booleanFlag(input, "--all");
      const raw = booleanFlag(input, "--raw");
      const who = input.positionals.join(" ").trim();
      withStore(context.dbPath, (store) => {
        const now = context.now();
        store.work.pruneWork(now);
        const showName = operatorNames(store.liveSessions(now));
        const resolution =
          who !== "" ? resolveAgentId(store, who, now) : undefined;
        if (resolution && !resolution.ok) {
          context.error(
            resolution.kind === "ambiguous"
              ? `ambiguous agent ${bold(who)}: ${resolution.candidates.join(", ")}`
              : `no work records for ${bold(who)}.`,
          );
          context.fail();
          return;
        }
        const target = resolution?.agentId;
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
  const input = commandArguments(context, kind, args, {
    valueFlags: ["--item"],
  });
  if (!input) return;
  const match = stringFlag(input, "--item") ?? "";
  const text = input.positionals.join(" ").trim();
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
    const since = now - BREAK_NOTIFICATION_WINDOW_MS;
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
