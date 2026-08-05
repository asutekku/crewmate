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
  stateLegend,
  summarizeFiles,
} from "../core/layout.ts";
import { minionName } from "../core/names.ts";
import { agentState } from "../core/work.ts";
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
    // NAMED, not counted. "2 running older hooks" of three makes you go and
    // find out which two, and restarting the wrong session costs its context —
    // so a warning that hides its subjects is one a reader learns to skip.
    // `code_version` is stamped at SessionStart, so a genuine restart is the
    // only thing that clears this; `--resume` is what keeps the conversation.
    const named = view.behind
      .map((session) => sanitizeTerminalText(rosterName(session)))
      .join(", ");
    lines.push(dim(`  ⟲ ${named} running older hooks`));
    lines.push(
      dim("    restart each to pick them up — `claude --resume <id>` keeps the conversation"),
    );
  }
  return lines;
}

/**
 * What the glyphs mean, permanently.
 *
 * Two symbols carrying the roster's primary distinction went unkeyed, so a
 * reader had to infer `●` from the ages beside it. The `⚠` line is listed only
 * when one is on screen — a legend for something absent is noise.
 */
export function renderRosterLegend(view: RosterView): string[] {
  const anyOverlap = view.claims.contestedPaths.size > 0;
  // `gone` is omitted: a roster lists the living, so there is no such row to
  // explain. The MEANING of every glyph shown comes from `STATE_LEGEND` --
  // see `core/layout.ts` for why that is shared with `board` rather than
  // spelled out twice.
  return [
    "",
    dim(
      stateLegend(
        ["busy", "waiting", "idle"],
        [
          "✎ files this agent holds",
          ...(anyOverlap ? [`${red("⚠")} also held by a peer`] : []),
        ],
        (state, glyph) =>
          state === "busy" ? green(glyph) : state === "waiting" ? red(glyph) : glyph,
      ),
    ),
  ];
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
  // THE SAME DERIVATION THE BOARD USES, so one agent cannot read `busy` here
  // and `idle` there. `session.status` is Claude Code's own sample, refreshed
  // only when `who` runs (~950 ms); the heartbeat-vs-turn-boundary comparison
  // is free and fresher. See `agentState`.
  const state = agentState(
    {
      lastSeenMs: session.lastSeenMs,
      blocked: session.blocked,
      lastTurnMs: session.lastTurnMs,
    },
    input.now,
  );
  const mark =
    state === "waiting" ? red("⏸") : state === "busy" ? green("●") : dim("○");
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
  const mine = claims.byHandle.get(handle) ?? [];
  const paths = mine.map((claim) => sanitizeTerminalText(claim.path));
  const pieces = summarizeFiles(paths, { contested: claims.contestedPaths });
  const line = renderFileLine(pieces, layout.descriptionWidth - 2, {
    contested: red,
    normal: dim,
  });
  if (!line) return [];
  const lines = [`${" ".repeat(layout.gutter)}${dim("✎")} ${line}`];
  // THE LINE THIS COMMAND EXISTS FOR. A contested path was already painted red,
  // which says "someone else is in here" without saying WHO — and who is the
  // part you act on. Two agents about to edit one file is the failure a shared
  // tree creates, and no other view catches it before the edit lands.
  const peers = overlapPeers(handle, mine, claims);
  if (peers.length > 0) {
    // Counts are FILES SHARED WITH THAT PEER, one unit throughout: "2 shared
    // with adela" reads the same whether one peer or three are listed.
    const text = peers
      .map((peer) => `${peer.count} shared with ${peer.name}`)
      .join(", ");
    lines.push(
      `${" ".repeat(layout.gutter)}${red("⚠")} ${red(fit(text, layout.descriptionWidth - 2))}`,
    );
  }
  return lines;
}

/** Who else holds a path this agent holds, and how many they share. */
function overlapPeers(
  handle: string,
  mine: readonly Claim[],
  claims: ClaimIndex,
): Array<{ name: string; count: number }> {
  const shared = new Map<string, { name: string; count: number }>();
  for (const claim of mine) {
    for (const other of claims.byPath.get(claim.path) ?? []) {
      if (other.handle === handle) continue;
      const key = other.handle;
      const seen = shared.get(key);
      if (seen) seen.count += 1;
      else shared.set(key, { name: sanitizeTerminalText(claimName(other)), count: 1 });
    }
  }
  return [...shared.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * The heading every group gets, named path first.
 *
 * The branch is shown only when every session in the tree agrees on it. A git
 * worktree has one checkout, so they normally do — but each session records the
 * branch when IT last looked, so a stale row can disagree, and one row's answer
 * must not be printed as the tree's.
 */
function treeHeading(tree: string, group: readonly Session[]): string {
  if (tree === "") return "unknown tree";
  const leaf = sanitizeTerminalText(tree.split("/").pop() ?? tree);
  const branches = new Set(group.map((s) => s.branch).filter((b) => b !== ""));
  const branch = branches.size === 1 ? sanitizeTerminalText([...branches][0] ?? "") : "";
  return `${leaf}${branch ? ` (${branch})` : ""}  ${sanitizeTerminalText(tree)}`;
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
    lines.push(dim(`  ${treeHeading(tree, group)}`));
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
