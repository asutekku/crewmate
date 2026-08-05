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
import { CLI } from "../core/verbs.ts";
import {
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
import { sanitizeTerminalText } from "./terminal.ts";
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
    dim('  Open one with `crew doing "<subject>" --plan "a; b; c"`.'),
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
    context.log(dim("  every step ticked — `crew done` to close it"));
}

interface WorkItemView {
  readonly item: WorkItem;
  readonly steps: readonly WorkStep[];
  readonly events: readonly WorkEvent[];
}

function workItemView(
  store: Store,
  item: WorkItem,
): WorkItemView {
  return {
    item: {
      ...item,
      agentName: sanitizeTerminalText(item.agentName),
      subject: sanitizeTerminalText(item.subject),
      planDoc: sanitizeTerminalText(item.planDoc),
    },
    steps: store.work.steps(item.workId).map((step) => ({
      ...step,
      text: sanitizeTerminalText(step.text),
      note: sanitizeTerminalText(step.note),
    })),
    events: store.work.events(item.workId).map((event) => ({
      ...event,
      body: sanitizeTerminalText(event.body),
      ref: sanitizeTerminalText(event.ref),
    })),
  };
}

interface BoardAgentView {
  readonly name: string;
  readonly tally: string;
  readonly items: readonly WorkItemView[];
  readonly hidden: number;
}

interface BoardView {
  readonly agents: readonly BoardAgentView[];
  readonly history: readonly WorkItemView[];
  readonly closedHidden: number;
}

type BoardSnapshotResult =
  | { readonly ok: true; readonly view: BoardView }
  | {
      readonly ok: false;
      readonly kind: "not_found" | "ambiguous";
      readonly candidates: readonly string[];
    };

function renderMine(
  context: CliContext,
  views: readonly WorkItemView[],
  nowMs: number,
  width: number,
): void {
  if (views.length === 0) {
    context.log(dim("No open work items."));
    context.log(dim('  `crew doing "<subject>" --plan "a; b; c"` opens one.'));
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

function renderHistory(
  context: CliContext,
  views: readonly WorkItemView[],
  nowMs: number,
  width: number,
): void {
  for (const { item, events } of views) {
    context.log("");
    context.log(
      `  ${bold(item.subject)} ${dim(`started ${briefAgo(item.startedMs, nowMs)}`)}`,
    );
    for (const event of events) {
      const when = dim(briefAge(event.tsMs, nowMs).padStart(6));
      const ref = event.ref !== "" ? ` ${cyan(event.ref)}` : "";
      context.log(
        `  ${when}  ${dim(event.kind.padEnd(8))}${ref} ${fit(event.body, width - 22)}`,
      );
    }
  }
  context.log("");
}

function collectBoardView(
  store: Store,
  who: string,
  nowMs: number,
  options: { readonly all: boolean; readonly history: boolean; readonly raw: boolean },
): BoardSnapshotResult {
  const liveSessions = store.liveSessions(nowMs);
  const showName = operatorNames(liveSessions);
  const liveBySession = new Map(liveSessions.map((session) => [session.sessionId, session]));
  const resolution = who !== "" ? resolveAgentId(store, who, nowMs) : undefined;
  if (resolution && !resolution.ok) return resolution;
  const target = resolution?.agentId;
  const allItems = store.work.items({
    ...(target !== undefined ? { agentId: target } : {}),
    includeClosed: true,
  });
  const visibleItems =
    options.all || options.history
      ? allItems
      : allItems.filter((item) => item.closedMs === 0);
  const views = visibleItems.map((item) => workItemView(store, item));
  const groups = new Map<
    string,
    { name: string; open: number; closed: number; items: WorkItemView[] }
  >();
  for (const view of views) {
    const { item } = view;
    let group = groups.get(item.agentId);
    if (!group) {
      const stored = item.agentName !== "" ? item.agentName : item.agentId;
      const sessionId = item.agentId.startsWith("session:")
        ? item.agentId.slice("session:".length)
        : "";
      const live = sessionId !== "" ? liveBySession.get(sessionId) : undefined;
      group = {
        name: sanitizeTerminalText(
          options.raw ? stored : live ? rosterName(live) : showName(stored),
        ),
        open: 0,
        closed: 0,
        items: [],
      };
      groups.set(item.agentId, group);
    }
    if (item.closedMs === 0) group.open += 1;
    else group.closed += 1;
    group.items.push(view);
  }
  return {
    ok: true,
    view: {
      history: views,
      closedHidden: options.all || options.history ? 0 : allItems.length - views.length,
      agents: [...groups.values()].map((group) => {
        const shown = group.items.slice(0, BOARD_OPEN_SHOWN + group.closed);
        return {
          name: group.name,
          tally: agentTally(group.open, options.all || options.history ? group.closed : 0),
          items: shown,
          hidden: group.items.length - shown.length,
        };
      }),
    },
  };
}

function renderBoard(
  context: CliContext,
  view: BoardView,
  nowMs: number,
  width: number,
): void {
  if (view.agents.length === 0) {
    context.log(dim(`No work records in ${context.projectName}.`));
    context.log(dim('  Agents open one with `crew doing "<subject>"`.'));
    return;
  }
  for (const agent of view.agents) {
    const gap = Math.max(1, width - 2 - [...agent.name].length - agent.tally.length);
    context.log("");
    context.log(
      `  ${bold(handleColour(agent.name)(agent.name))}${" ".repeat(gap)}${dim(agent.tally)}`,
    );
    for (const item of agent.items) {
      const fold = foldEvents(item.events);
      for (const line of itemLines(item.item, item.steps, fold, nowMs, width, BOARD_PAINT))
        context.log(line);
    }
    if (agent.hidden > 0) context.log(dim(`    +${agent.hidden} more`));
  }
  context.log("");
  if (view.closedHidden > 0)
    context.log(dim(`  ${view.closedHidden} closed — \`board --all\` to include them`));
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
            dim('    no checklist — `crew add "<step>"` if phases appear'),
          );
        if (linkPath !== "") context.log(dim(`    executing ${linkPath}`));
        context.log(
          dim(
            "  Peers see it with `crew board`. Close it with `crew done`.",
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
            context.error(dim('  (no checklist — `crew add "<step>"`)'));
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
            "  `crew plans` shows what each plan's work has actually shipped.",
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
              '  `crew doing "<subject>" --plan-doc <path>` opens one against a plan,',
            ),
          );
          context.log(
            dim(
              "  `crew link <path>` points an item that is already open at one.",
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
        return items.map((item) => workItemView(store, item));
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
      const now = context.now();
      const width = terminalWidth();
      withStore(context.dbPath, (store) => store.work.pruneWork(now));
      const snapshot = withStore(context.dbPath, (store) =>
        collectBoardView(store, who, now, { all, history, raw }),
      );
      if (!snapshot.ok) {
        failCommand(
          context,
          snapshot.kind === "ambiguous"
            ? `ambiguous agent ${who}: ${snapshot.candidates.join(", ")}`
            : `no work records for ${who}`,
        );
        return;
      }
      if (history) renderHistory(context, snapshot.view.history, now, width);
      else renderBoard(context, snapshot.view, now, width);
    },

    breaks: (args) => flag(context, "breaks", args),
    needs: (args) => flag(context, "needs", args),
  };
}

function flag(
  context: CliContext,
  kind: "breaks" | "needs",
  args: readonly string[],
): void {
  const input = commandArguments(context, kind, args, {
    valueFlags: ["--item"],
  });
  if (!input) return;
  const match = stringFlag(input, "--item") ?? "";
  const text = input.positionals.join(" ").trim();
  if (!text) {
    context.error(`usage: ${CLI} ${kind} "<what>" [--item <subject match>]`);
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
      context.error(dim('  `crew doing "<subject>"` opens one.'));
      context.fail();
      return;
    }
    const reached = store.recordWorkFlag({
      workId: item.workId,
      kind,
      text,
      subject: item.subject,
      senderSessionId: context.sessionId,
      senderName: me.agentName,
      sinceMs: now - BREAK_NOTIFICATION_WINDOW_MS,
      nowMs: now,
    });
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
    context.log(
      reached.length > 0
        ? dim(`  told ${reached.join(", ")} — they have edited files you have`)
        : dim(
            "  nobody else has been in your files today, so nobody was messaged",
          ),
    );
  });
}
