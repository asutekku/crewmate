import type { AgentInfo } from "../core/agents.ts";
import {
  activityColour,
  bold,
  cyan,
  dim,
  green,
  handleColour,
  red,
  rosterColours,
} from "../core/colour.ts";
import {
  fit,
  pad,
  renderFileLine,
  shortAge,
  summarizeFiles,
} from "../core/layout.ts";
import { minionName } from "../core/names.ts";
import {
  agoText,
  claimName,
  displayName,
  rosterName,
  type Claim,
  type Minion,
  type Session,
} from "../core/store.ts";
import {
  BACKGROUND_PROCESS_LIMIT,
  type Contention,
  type ClaimIndex,
  type RosterLayout,
  type RosterSnapshot,
  type RosterView,
} from "./roster-model.ts";
import { sanitizeTerminalText } from "./terminal.ts";

type Paint = (text: string) => string;

export function renderRosterHeader(
  projectName: string,
  view: RosterView,
): string[] {
  const lines = [
    bold(
      `${view.orderedSessions.length} agents in ${sanitizeTerminalText(projectName)}${dim(view.treeCount > 1 ? ` · ${view.treeCount} trees` : "")}`,
    ),
  ];
  if (view.behind.length > 0) {
    lines.push(
      dim(
        `  ⟲ ${view.behind.length === view.orderedSessions.length ? "all" : view.behind.length} running older hooks — restart to pick up changes`,
      ),
    );
  }
  return lines;
}

export function renderSession(
  session: Session,
  input: {
    readonly now: number;
    readonly raw: boolean;
    readonly layout: RosterLayout;
    readonly paint: Paint;
    readonly taskCounts: RosterSnapshot["taskCounts"];
  },
): string[] {
  const { layout } = input;
  const mark = session.blocked
    ? red("●")
    : session.status === "busy"
      ? green("●")
      : dim("○");
  const seen = activityColour(input.now - session.lastSeenMs)(
    pad(shortAge(session.lastSeenMs, input.now), layout.ageWidth),
  );
  const tasks = input.taskCounts.get(session.sessionId);
  const progress =
    tasks && tasks.open + tasks.done > 0
      ? dim(` [${tasks.done}/${tasks.open + tasks.done}]`)
      : "";
  const headline = sanitizeTerminalText(session.title || session.intent);
  const description = headline
    ? fit(headline, layout.descriptionWidth - [...progress].length)
    : dim(fit("(no stated task)", layout.descriptionWidth));
  const shown = sanitizeTerminalText(input.raw ? displayName(session) : rosterName(session));
  const lines = [
    `  ${mark} ${input.paint(bold(pad(fit(shown, layout.nameWidth), layout.nameWidth)))} ${seen}  ${description}${progress}`,
  ];
  if (session.blocked)
    lines.push(
      `${" ".repeat(layout.gutter)}${red(fit(sanitizeTerminalText(session.blocked), layout.descriptionWidth))}`,
    );
  if (session.summary)
    lines.push(
      `${" ".repeat(layout.gutter)}${cyan(fit(sanitizeTerminalText(session.summary), layout.descriptionWidth))}`,
    );
  return lines;
}

export function renderMinions(
  parent: Session,
  minions: readonly Minion[],
  raw: boolean,
  layout: RosterLayout,
  paint: Paint,
): string[] {
  const labels = minions.map((minion) =>
    raw
      ? `${sanitizeTerminalText(displayName(parent))}#${minion.seq}`
      : sanitizeTerminalText(minionName(displayName(parent), minion.seq)),
  );
  const labelWidth = Math.max(0, ...labels.map((label) => [...label].length));
  return minions.map((minion, index) => {
    const what = sanitizeTerminalText(minion.task || minion.agentType || "(running)");
    return `${" ".repeat(layout.gutter - 2)}${dim("↳")} ${paint(pad(labels[index] ?? "", labelWidth))} ${dim(fit(what, Math.max(12, layout.descriptionWidth - labelWidth - 1)))}`;
  });
}

export function renderClaims(
  handle: string,
  claims: ClaimIndex,
  layout: RosterLayout,
): string[] {
  const paths = (claims.byHandle.get(handle) ?? []).map((claim) => sanitizeTerminalText(claim.path));
  const pieces = summarizeFiles(paths, { contested: claims.contestedPaths });
  const line = renderFileLine(pieces, layout.descriptionWidth - 2, {
    contested: red,
    normal: dim,
  });
  return line ? [`${" ".repeat(layout.gutter)}${dim("✎")} ${line}`] : [];
}

export function renderSessions(
  view: RosterView,
  snapshot: RosterSnapshot,
  now: number,
  raw: boolean,
): string[] {
  const lines: string[] = [];
  const palette = rosterColours(view.orderedSessions, displayName);
  for (const [tree, group] of view.groups) {
    lines.push("");
    if (tree) {
      const leaf = sanitizeTerminalText(tree.split("/").pop() ?? tree);
      const branch = sanitizeTerminalText(group[0]?.branch ?? "");
      lines.push(dim(`  worktree ${leaf}${branch ? ` (${branch})` : ""}`));
    }
    for (const session of group) {
      const paint =
        palette.get(displayName(session)) ?? handleColour(session.handle);
      lines.push(
        ...renderSession(session, {
          now,
          raw,
          layout: view.layout,
          paint,
          taskCounts: snapshot.taskCounts,
        }),
        ...renderMinions(
          session,
          snapshot.minionsBySession.get(session.sessionId) ?? [],
          raw,
          view.layout,
          paint,
        ),
        ...renderClaims(session.handle, view.claims, view.layout),
      );
    }
  }
  return lines;
}

export function renderBackgroundProcesses(
  processes: readonly AgentInfo[],
  projectRoot: string,
  now: number,
): string[] {
  if (processes.length === 0) return [];
  const lines = [
    "",
    dim(
      `${processes.length} background process(es) — no window, not on the roster:`,
    ),
  ];
  for (const process of processes.slice(0, BACKGROUND_PROCESS_LIMIT)) {
    const age =
      process.startedAtMs > 0 ? agoText(process.startedAtMs, now) : "unknown";
    const leaf =
      process.cwd === projectRoot
        ? ""
        : ` ${sanitizeTerminalText(process.cwd.split("/").pop() ?? "")}`;
    lines.push(
      dim(
        `    pid ${String(process.pid).padEnd(7)} ${sanitizeTerminalText(process.name || "(unnamed)")}${leaf}  started ${age}`,
      ),
    );
  }
  if (processes.length > BACKGROUND_PROCESS_LIMIT)
    lines.push(
      dim(`    … ${processes.length - BACKGROUND_PROCESS_LIMIT} more`),
    );
  return lines;
}

function renderContentionRows(
  rows: readonly Contention[],
  width: number,
  paint: Paint,
  note: string,
): string[] {
  return rows.flatMap((row) => [
    `    ${paint(fit(sanitizeTerminalText(row.path), Math.max(8, width - 6)))}`,
    `      ${row.holders.map((claim: Claim) => handleColour(claim.handle)(sanitizeTerminalText(claimName(claim)))).join(dim(", "))} ${dim(note)}`,
  ]);
}

export function renderContentionWarnings(
  contentions: readonly Contention[],
  width: number,
): string[] {
  const sameTree = contentions.filter((row) => row.sameTree);
  const crossTree = contentions.filter((row) => !row.sameTree);
  const lines: string[] = [];
  if (sameTree.length > 0) {
    lines.push(
      "",
      red(`⚠ ${sameTree.length} file(s) held by two agents in ONE tree:`),
    );
    lines.push(
      ...renderContentionRows(
        sameTree,
        width,
        (text) => text,
        "— uncommitted work would collide",
      ),
    );
  }
  if (crossTree.length > 0) {
    lines.push(
      "",
      dim(`${crossTree.length} file(s) edited in separate worktrees:`),
    );
    lines.push(
      ...renderContentionRows(
        crossTree,
        width,
        dim,
        "— different checkouts, merge later",
      ),
    );
  }
  return lines;
}
