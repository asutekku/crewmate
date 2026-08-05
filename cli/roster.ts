import { listAgents } from "../core/agents.ts";
import { dim } from "../core/colour.ts";
import { terminalWidth } from "../core/layout.ts";
import { installedVersion } from "../core/repo.ts";
import { refreshSummary, SUMMARY_TTL_MS } from "../core/summary.ts";
import { displayName, rosterName, withStore } from "../core/store.ts";
import { booleanFlag, parseArguments } from "./args.ts";
import { failCommand } from "./command.ts";
import {
  buildRosterView,
  collectRosterSnapshot,
  synchronizeRosterStore,
} from "./roster-model.ts";
import {
  renderBackgroundProcesses,
  renderContentionWarnings,
  renderRosterHeader,
  renderRosterLegend,
  renderSessions,
} from "./roster-renderers.ts";
import type { CliContext, CommandMap } from "./types.ts";

function refreshStaleSummaries(
  context: CliContext,
  sessions: readonly { readonly sessionId: string; readonly path: string }[],
): void {
  for (const session of sessions)
    refreshSummary(
      `${context.binRoot}/core/summarize-worker.ts`,
      session.sessionId,
      session.path,
      context.dbPath,
    );
}

function handleWho(context: CliContext, argv: readonly string[]): void {
  const parsed = parseArguments(argv, {
    booleanFlags: ["--raw"],
    maxPositionals: 0,
  });
  if (!parsed.ok) return failCommand(context, parsed.error);
  const raw = booleanFlag(parsed.value, "--raw");
  const now = context.now();
  const width = terminalWidth();
  const agents = listAgents();

  withStore(context.dbPath, (store) => synchronizeRosterStore(store, agents, now));
  const snapshot = withStore(context.dbPath, (store) =>
    collectRosterSnapshot(store, now, SUMMARY_TTL_MS),
  );
  if (snapshot.sessions.length === 0) {
    context.log(dim(`No active agents in ${context.projectName}.`));
    return;
  }
  refreshStaleSummaries(context, snapshot.staleSummaries);
  const view = buildRosterView({
    snapshot,
    agents,
    projectRoot: context.projectRoot,
    currentVersion: installedVersion(),
    raw,
    width,
    shownName: raw ? displayName : rosterName,
  });
  const lines = [
    ...renderRosterHeader(context.projectName, view),
    ...renderSessions(view, snapshot, now, raw),
    ...renderBackgroundProcesses(view.background, context.projectRoot, now),
    ...renderContentionWarnings(view.contentions, view.layout.width),
    ...renderRosterLegend(view),
  ];
  for (const line of lines) context.log(line);
}

export function createRosterCommands(context: CliContext): CommandMap {
  return { who: (args) => handleWho(context, args) };
}
