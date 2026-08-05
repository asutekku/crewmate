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
import { fit, STATE_GLYPHS, stateLegend, terminalWidth } from "../core/layout.ts";
import { CLI } from "../core/verbs.ts";
import {
  operatorNames,
  rosterName,
  withStore,
  type Store,
} from "../core/store.ts";
import {
  agentKey,
  agentState,
  BOARD_OPEN_SHOWN,
  foldEvents,
  normalisePlanPath,
  parsePlan,
  progress,
  type WorkEvent,
  type WorkItem,
  type AgentState,
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

/**
 * Why a bare command found no item — which is two different failures.
 *
 * AMBIGUITY IS NOT ABSENCE. `target` refuses to guess between several open
 * items, so the honest message names the choices rather than claiming there is
 * nothing open. Reporting "no open work item" to an agent holding two would be
 * a worse lie than the guess this refusal replaced: it is wrong AND it hides
 * the fix, which is one `--item` away.
 */
function noOpenItem(context: CliContext, match: string, open: readonly WorkItem[] = []): void {
  if (open.length > 1) {
    context.error(
      match !== ""
        ? `${bold(match)} matches ${open.length} open items — name one.`
        : `${open.length} open work items — say which with \`--item <match>\`.`,
    );
    for (const item of open) context.error(dim(`  ${item.subject}`));
    context.fail();
    return;
  }
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
  /** Set when this item's work can be picked up; see `ItemContext`. */
  readonly resumeId?: string;
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
  readonly state: AgentState;
}

/**
 * Section order, and what each glyph claims.
 *
 * `waiting` leads because it is the only state that asks something OF YOU. Then
 * running, then the two that need a decision. There is no `stalled`: see
 * `agentState` for why the tool cannot honestly report one.
 */
const STATE_SECTIONS: ReadonlyArray<{
  readonly state: AgentState;
  readonly title: string;
  readonly glyph: string;
}> = [
  // Glyphs come from `STATE_GLYPHS` (`core/layout.ts`), never spelled out here:
  // this table and `who`'s legend disagreed about `○` until they shared a
  // source. Titles stay local -- they are board-specific framing, not meaning.
  { state: "waiting", title: "NEEDS YOU", glyph: STATE_GLYPHS.waiting },
  { state: "busy", title: "RUNNING", glyph: STATE_GLYPHS.busy },
  { state: "idle", title: "IDLE — at a prompt", glyph: STATE_GLYPHS.idle },
  { state: "gone", title: "GONE — pick up or drop", glyph: STATE_GLYPHS.gone },
];

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
    for (const line of itemLines(
      view.item,
      view.steps,
      fold,
      nowMs,
      width,
      BOARD_PAINT,
      resumeContext(view),
    ))
      context.log(line);
  }
}

/** `exactOptionalPropertyTypes` refuses `{ resumeId: undefined }`, so omit it. */
function resumeContext(view: WorkItemView): { resumeId?: string } {
  return view.resumeId !== undefined ? { resumeId: view.resumeId } : {};
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

export function collectBoardView(
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
  // Read ONCE for the whole board rather than per item: it is a directory
  // listing, and a board with thirty items would otherwise do thirty of them.
  const onDisk = store.conversationsOnDisk();
  const views = visibleItems.map((item) => {
    const view = workItemView(store, item);
    const sessionId = item.agentId.startsWith("session:")
      ? item.agentId.slice("session:".length)
      : "";
    const resumable =
      item.closedMs === 0 &&
      sessionId !== "" &&
      !liveBySession.has(sessionId) &&
      onDisk.has(sessionId.toLowerCase());
    return resumable ? { ...view, resumeId: sessionId } : view;
  });
  const groups = new Map<
    string,
    {
      name: string;
      open: number;
      closed: number;
      items: WorkItemView[];
      state: AgentState;
    }
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
        state: agentState(
          live
            ? {
                lastSeenMs: live.lastSeenMs,
                blocked: live.blocked,
                lastTurnMs: live.lastTurnMs,
              }
            : {},
          nowMs,
        ),
      };
      groups.set(item.agentId, group);
    }
    if (item.closedMs === 0) group.open += 1;
    else group.closed += 1;
    group.items.push(view);
  }
  // A NAME CAN BE REUSED, so it cannot be the label on its own. Names return to
  // the pool when a conversation ends, and two blocks headed `akira` read as one
  // agent listed twice rather than the two different conversations they are.
  // Seen live 2026-08-05. `resolveAgent` already disambiguates this way.
  const timesUsed = new Map<string, number>();
  for (const group of groups.values()) {
    timesUsed.set(group.name, (timesUsed.get(group.name) ?? 0) + 1);
  }
  return {
    ok: true,
    view: {
      history: views,
      closedHidden: options.all || options.history ? 0 : allItems.length - views.length,
      agents: [...groups.entries()].map(([agentId, group]) => {
        const shown = group.items.slice(0, BOARD_OPEN_SHOWN + group.closed);
        const shared = (timesUsed.get(group.name) ?? 0) > 1;
        // `1 open` was on all seven rows and told a reader nothing while taking
        // the right margin. A tally earns its place only when the count is not
        // the one the section already implies.
        const worthSaying = group.open !== 1 || group.closed > 0;
        return {
          name: shared ? `${group.name}·${agentId.slice(-6)}` : group.name,
          tally: worthSaying
            ? agentTally(group.open, options.all || options.history ? group.closed : 0)
            : "",
          items: shown,
          hidden: group.items.length - shown.length,
          state: group.state,
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
  // GROUPED BY STATE, so the question "who needs me" is answered by position
  // rather than by comparing seven timestamps. `1 open` was on every row and
  // carried no information; the tally now only appears when it says something.
  const counts = STATE_SECTIONS.map(
    (section) => view.agents.filter((a) => a.state === section.state).length,
  );
  const summary = STATE_SECTIONS.map((section, i) => ({ section, n: counts[i] ?? 0 }))
    .filter((s) => s.n > 0)
    .map((s) => `${s.n} ${s.section.state}`)
    .join(" · ");
  context.log(dim(`  ${summary}`));
  for (const section of STATE_SECTIONS) {
    const agents = view.agents.filter((agent) => agent.state === section.state);
    if (agents.length === 0) continue;
    context.log("");
    context.log(dim(section.title));
    for (const agent of agents) {
      const label = bold(handleColour(agent.name)(`${section.glyph} ${agent.name}`));
      // No tally means no padding either — a run of spaces to the right margin
      // is invisible until it lands in a diff or a paste.
      const line =
        agent.tally === ""
          ? `  ${label}`
          : `  ${label}${" ".repeat(
              Math.max(1, width - 2 - [...`${section.glyph} ${agent.name}`].length - agent.tally.length),
            )}${dim(agent.tally)}`;
      context.log(line);
      for (const item of agent.items) {
        const fold = foldEvents(item.events);
        for (const line of itemLines(
          item.item,
          item.steps,
          fold,
          nowMs,
          width,
          BOARD_PAINT,
          resumeContext(item),
        ))
          context.log(line);
      }
      if (agent.hidden > 0) context.log(dim(`    +${agent.hidden} more`));
    }
  }
  context.log("");
  context.log(
    dim(stateLegend(["busy", "waiting", "idle", "gone"], ["— no plan recorded"])),
  );
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
        if (!item) return noOpenItem(context, match, store.work.openItems(me.agentId));
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

    /**
     * Takes a tick back.
     *
     * The counterpart to `did`, and the reason it exists is that `did` was
     * unrecoverable: `step` writes a status note but leaves `done_ms` set, so a
     * correction rendered UNDER a green check and the board kept counting work
     * that had not happened. Recovery meant editing sqlite by hand.
     */
    undo(args) {
      const input = commandArguments(context, "undo", args, {
        valueFlags: ["--item"],
      });
      if (!input) return;
      const parsedStep = requireSafeInteger(input.positionals[0], "step", {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      if (!parsedStep.ok) return failCommand(context, `undo: ${parsedStep.error}`);
      const stepNumber = parsedStep.value;
      const match = stringFlag(input, "--item") ?? "";
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const me = callerIdentity(context, store);
        if (!me) return notAnAgent(context, "`undo`");
        const item = store.work.target(me.agentId, match);
        if (!item) return noOpenItem(context, match, store.work.openItems(me.agentId));
        if (!store.work.untick(item.workId, stepNumber, now)) {
          const steps = store.work.steps(item.workId);
          context.error(`${bold(item.subject)} has no step ${stepNumber}.`);
          for (const step of steps)
            context.error(dim(`  ${step.idx}  ${step.text}`));
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
        if (!item) return noOpenItem(context, match, store.work.openItems(me.agentId));
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
        if (!item) return noOpenItem(context, match, store.work.openItems(me.agentId));
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
        if (!item) return noOpenItem(context, match, store.work.openItems(me.agentId));
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
        if (!item) return noOpenItem(context, match, store.work.openItems(me.agentId));
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
      // The project root is what resolves the transcript dir, and the board
      // needs it to tell a resumable conversation from a deleted one.
      const snapshot = withStore(
        context.dbPath,
        (store) => collectBoardView(store, who, now, { all, history, raw }),
        context.projectRoot,
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
    // Shares `noOpenItem` so ambiguity reads the same here as everywhere else:
    // this site had its own "no open work item" string, which told an agent
    // holding two that it held none.
    if (!item) return noOpenItem(context, match, store.work.openItems(me.agentId));
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
