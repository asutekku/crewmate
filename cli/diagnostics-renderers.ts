import { briefAgo } from "../core/board.ts";
import { bold, dim, handleColour } from "../core/colour.ts";
import type { Stats } from "../core/stats.ts";
import { sizeText, spanText, usageFlag } from "../core/stats.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import type { CliContext } from "./types.ts";

export interface StatsView {
  readonly stats: Stats;
  readonly nowMs: number;
  readonly databaseBytes: number;
  readonly personalError?: string;
}

function section(context: CliContext, title: string): void {
  context.log("");
  context.log(bold(title));
}

function renderStoreAndSample(context: CliContext, view: StatsView): void {
  const { stats } = view;
  context.log(bold("store"));
  context.log(`  ${dim("project")}  ${sanitizeTerminalText(context.projectName)}`);
  context.log(`  ${dim("db     ")}  ${sanitizeTerminalText(context.dbPath)}`);
  context.log(`  ${dim("size   ")}  ${sizeText(view.databaseBytes)}`);
  if (view.personalError)
    context.log(dim(`  personal memory unavailable: ${sanitizeTerminalText(view.personalError)}`));
  section(context, "sample");
  if (stats.sample.activeHours === 0) {
    context.log(dim("  no activity recorded"));
    return;
  }
  context.log(
    `  ${dim("window ")} ${stats.sample.activeHours} active hours over ${spanText(0, stats.sample.spanMs)}`,
  );
  context.log(dim("  a low count here measures this sample, not what the tool supports:"));
  context.log(dim("  feature age and whether agents were told it exists are NOT recorded."));
}

function renderRowsAndAgents(context: CliContext, view: StatsView): void {
  const { stats, nowMs } = view;
  section(context, "rows");
  const tables = stats.tables.map((table) => ({
    ...table,
    table: sanitizeTerminalText(table.table),
  }));
  const widest = tables.reduce((width, table) => Math.max(width, [...table.table].length), 0);
  for (const table of tables)
    context.log(`  ${table.table.padEnd(widest)}  ${String(table.rows).padStart(6)}`);
  section(context, "agents seen");
  context.log(`  ${dim("by edits   ")} ${stats.agents.edits}`);
  context.log(
    `  ${dim("by messages")} ${stats.agents.messages} ${dim("(cumulative — keeps swept sessions; not comparable to edits)")}`,
  );
  context.log(`  ${dim("by work    ")} ${stats.agents.work}`);
  context.log(`  ${dim("by diary   ")} ${stats.agents.diary}`);
  if (stats.activity.length === 0) return;
  section(context, "busiest agents");
  const activity = stats.activity.map((agent) => ({
    ...agent,
    agent: sanitizeTerminalText(agent.agent),
  }));
  const width = activity.reduce((value, agent) => Math.max(value, [...agent.agent].length), 0);
  for (const agent of activity)
    context.log(
      `  ${handleColour(agent.agent)(agent.agent.padEnd(width))}  ${String(agent.edits).padStart(5)} edits  ${dim(`lived ${spanText(agent.firstMs, agent.lastMs).padStart(6)}`)}  ${dim(`last ${briefAgo(agent.lastMs, nowMs)}`)}`,
    );
}

function renderConcurrencyAndMessages(context: CliContext, stats: Stats): void {
  section(context, "concurrency");
  if (stats.concurrency.activeHours === 0) context.log(dim("  no edits recorded"));
  else {
    for (const bucket of stats.concurrency.buckets)
      context.log(
        `  ${`${bucket.agents} agent${bucket.agents === 1 ? "" : "s"}`.padEnd(9)} ${bucket.hours} hour${bucket.hours === 1 ? "" : "s"}`,
      );
    context.log(dim(`  ${stats.concurrency.activeHours} active hours, peak ${stats.concurrency.peak} at once`));
    context.log(dim("  bounded by how many sessions were run, not by what the tool supports"));
  }
  section(context, "messages");
  if (stats.messages.byKind.length === 0) context.log(dim("  none"));
  else {
    const kinds = stats.messages.byKind.map((kind) => ({
      ...kind,
      kind: sanitizeTerminalText(kind.kind),
    }));
    const width = kinds.reduce((value, kind) => Math.max(value, [...kind.kind].length), 0);
    for (const kind of kinds)
      context.log(`  ${kind.kind.padEnd(width)}  ${String(kind.count).padStart(5)}`);
    context.log(dim(`  say: ${stats.messages.directedSays} directed, ${stats.messages.broadcastSays} broadcast`));
  }
}

function renderFeatures(context: CliContext, stats: Stats): void {
  section(context, "feature usage");
  const features = stats.features.map((feature) => ({
    ...feature,
    feature: sanitizeTerminalText(feature.feature),
    detail: sanitizeTerminalText(feature.detail),
  }));
  const width = features.reduce((value, feature) => Math.max(value, [...feature.feature].length), 0);
  for (const feature of features) {
    const flag = usageFlag(feature.rows, feature.exposure.opportunities);
    const tail = flag ? ` ${dim(flag)}` : feature.detail ? ` ${dim(feature.detail)}` : "";
    context.log(`  ${feature.feature.padEnd(width)}  ${String(feature.rows).padStart(6)}${tail}`);
    context.log(
      dim(
        `    availability ${feature.availability.observations}/${feature.availability.opportunities}  exposure ${feature.exposure.observations}/${feature.exposure.opportunities}  use ${feature.use.observations}/${feature.use.opportunities}`,
      ),
    );
    if (feature.exposure.surfaces.length > 0)
      context.log(
        dim(
          `    surfaces ${feature.exposure.surfaces
            .map((surface) => `${sanitizeTerminalText(surface.surface)}:${surface.observations}/${surface.sessions}`)
            .join("  ")}`,
        ),
      );
  }
}

export function renderStats(context: CliContext, view: StatsView): void {
  renderStoreAndSample(context, view);
  renderRowsAndAgents(context, view);
  renderConcurrencyAndMessages(context, view.stats);
  renderFeatures(context, view.stats);
}
