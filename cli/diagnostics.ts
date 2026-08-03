import { agentKey, progress } from "../core/work.ts";
import { briefAgo } from "../core/board.ts";
import { bold, cyan, dim, handleColour } from "../core/colour.ts";
import { fit, terminalWidth } from "../core/layout.ts";
import { withPersonal } from "../core/personal.ts";
import { displayName, withStore } from "../core/store.ts";
import { sizeText, spanText, usageFlag } from "../core/stats.ts";
import { parseArguments, parseSafeInteger, stringFlag } from "./args.ts";
import { failCommand } from "./command.ts";
import { resolveTrustedPath } from "./paths.ts";
import type { CliContext, CommandMap } from "./types.ts";

function databaseBytes(path: string): number {
  return ["", "-wal", "-shm"].reduce(
    (total, suffix) => total + Bun.file(path + suffix).size,
    0,
  );
}

export function createDiagnosticCommands(context: CliContext): CommandMap {
  return {
    files(args) {
      const parsed = parseArguments(args, { valueFlags: ["--hours"] });
      if (!parsed.ok) return failCommand(context, `files: ${parsed.error}`);
      const parsedHours = parseSafeInteger(stringFlag(parsed.value, "--hours"), "hours", {
        min: 1,
        max: 24 * 365,
      });
      if (!parsedHours.ok) return failCommand(context, `files: ${parsedHours.error}`);
      const hours = parsedHours.value ?? 24;
      const target = parsed.value.positionals.join(" ").trim();
      if (!target) {
        context.error("usage: cli.ts files <agent> [--hours n]");
        context.fail();
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const since = now - hours * 60 * 60 * 1000;
        const live = store.findByName(target, now);
        const past = store.editAgents(since);
        const query = target.toLowerCase();
        const historical = past.find(
          (agent) =>
            agent.agent.toLowerCase() === query ||
            agent.agent.toLowerCase().startsWith(query),
        );
        const sessionId = live?.sessionId ?? historical?.sessionId ?? "";
        const name = live ? displayName(live) : (historical?.agent ?? "");
        if (!sessionId) {
          context.error(
            `no agent named ${bold(target)} has edited anything in ${hours}h`,
          );
          const seen = [...new Set(past.map((agent) => agent.agent))].slice(
            0,
            8,
          );
          if (seen.length > 0)
            context.error(dim(`  seen recently: ${seen.join(", ")}`));
          context.fail();
          return;
        }
        const edits = store.editsBy(sessionId, since);
        if (edits.length === 0) {
          context.log(dim(`${name} has edited nothing in the last ${hours}h.`));
          return;
        }
        const width = terminalWidth();
        context.log(
          `${bold(handleColour(name)(name))} ${dim(`— ${edits.length} file(s) in ${hours}h`)}${live === null ? dim("  (session ended — this is history)") : ""}`,
        );
        for (const item of store.work.openItems(agentKey("", sessionId))) {
          const state = progress(store.work.steps(item.workId));
          context.log(
            `  ${cyan("▸")} ${item.subject}${dim(state.total > 0 ? ` ${state.done}/${state.total}` : "")}`,
          );
          if (state.current)
            context.log(`    ${dim("now")}  ${state.current.text}`);
        }
        const trees = new Set(
          edits.map((edit) => edit.worktree).filter(Boolean),
        );
        for (const edit of edits) {
          const when = dim(briefAgo(edit.tsMs, now).padStart(9));
          const times = edit.count > 1 ? dim(` ×${edit.count}`) : "";
          const tree =
            trees.size > 1 && edit.worktree
              ? dim(` [${edit.worktree.split("/").pop()}]`)
              : "";
          context.log(
            `  ${when}  ${fit(edit.path, width - 26)}${times}${tree}`,
          );
        }
      });
    },
    blame(args) {
      const parsed = parseArguments(args, {});
      if (!parsed.ok) return failCommand(context, `blame: ${parsed.error}`);
      const path = parsed.value.positionals.join(" ").trim();
      if (!path) {
        context.error("usage: cli.ts blame <path>");
        context.fail();
        return;
      }
      const resolved = resolveTrustedPath(path, context.projectRoot);
      if (!resolved.ok) return failCommand(context, resolved.error);
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const relative = resolved.value.relative;
        const rows = store.editsOf(relative);
        if (rows.length === 0) {
          context.log(dim(`No recorded edits to ${relative}.`));
          context.log(
            dim("  Only files edited through Claude Code's tools are tracked."),
          );
          return;
        }
        context.log(bold(relative));
        const width = terminalWidth();
        for (const row of rows) {
          const when = dim(briefAgo(row.tsMs, now).padStart(9));
          const tree = row.worktree
            ? dim(` [${row.worktree.split("/").pop()}]`)
            : "";
          const tool = row.tool ? dim(` ${row.tool}`) : "";
          const who = row.agent || dim(row.sessionId.slice(0, 8));
          context.log(
            `  ${when}  ${fit(handleColour(who)(who), width - 30)}${tool}${tree}`,
          );
        }
      });
    },
    stats(args) {
      const parsed = parseArguments(args, { maxPositionals: 0 });
      if (!parsed.ok) return failCommand(context, `stats: ${parsed.error}`);
      let memories = 0;
      try {
        memories = withPersonal((personal) => personal.count());
      } catch {
        memories = 0;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const stats = store.stats(memories);
        context.log(bold("store"));
        context.log(`  ${dim("project")}  ${context.projectName}`);
        context.log(`  ${dim("db     ")}  ${context.dbPath}`);
        context.log(
          `  ${dim("size   ")}  ${sizeText(databaseBytes(context.dbPath))}`,
        );
        context.log(bold("\nsample"));
        if (stats.sample.activeHours === 0)
          context.log(dim("  no activity recorded"));
        else {
          context.log(
            `  ${dim("window ")} ${stats.sample.activeHours} active hours over ${spanText(0, stats.sample.spanMs)}`,
          );
          context.log(
            dim(
              "  a low count here measures this sample, not what the tool supports:",
            ),
          );
          context.log(
            dim(
              "  feature age and whether agents were told it exists are NOT recorded.",
            ),
          );
        }
        context.log(bold("\nrows"));
        const widest = stats.tables.reduce(
          (width, table) => Math.max(width, table.table.length),
          0,
        );
        for (const table of stats.tables)
          context.log(
            `  ${table.table.padEnd(widest)}  ${String(table.rows).padStart(6)}`,
          );
        context.log(bold("\nagents seen"));
        context.log(`  ${dim("by edits   ")} ${stats.agents.edits}`);
        context.log(
          `  ${dim("by messages")} ${stats.agents.messages} ${dim("(cumulative — keeps swept sessions; not comparable to edits)")}`,
        );
        context.log(`  ${dim("by work    ")} ${stats.agents.work}`);
        context.log(`  ${dim("by diary   ")} ${stats.agents.diary}`);
        if (stats.activity.length > 0) {
          context.log(bold("\nbusiest agents"));
          const width = stats.activity.reduce(
            (value, agent) => Math.max(value, agent.agent.length),
            0,
          );
          for (const agent of stats.activity)
            context.log(
              `  ${handleColour(agent.agent)(agent.agent.padEnd(width))}  ${String(agent.edits).padStart(5)} edits  ${dim(`lived ${spanText(agent.firstMs, agent.lastMs).padStart(6)}`)}  ${dim(`last ${briefAgo(agent.lastMs, now)}`)}`,
            );
        }
        context.log(bold("\nconcurrency"));
        if (stats.concurrency.activeHours === 0)
          context.log(dim("  no edits recorded"));
        else {
          for (const bucket of stats.concurrency.buckets)
            context.log(
              `  ${`${bucket.agents} agent${bucket.agents === 1 ? "" : "s"}`.padEnd(9)} ${bucket.hours} hour${bucket.hours === 1 ? "" : "s"}`,
            );
          context.log(
            dim(
              `  ${stats.concurrency.activeHours} active hours, peak ${stats.concurrency.peak} at once`,
            ),
          );
          context.log(
            dim(
              "  bounded by how many sessions were run, not by what the tool supports",
            ),
          );
        }
        context.log(bold("\nmessages"));
        if (stats.messages.byKind.length === 0) context.log(dim("  none"));
        else {
          const width = stats.messages.byKind.reduce(
            (value, kind) => Math.max(value, kind.kind.length),
            0,
          );
          for (const kind of stats.messages.byKind)
            context.log(
              `  ${kind.kind.padEnd(width)}  ${String(kind.count).padStart(5)}`,
            );
          context.log(
            dim(
              `  say: ${stats.messages.directedSays} directed, ${stats.messages.broadcastSays} broadcast`,
            ),
          );
        }
        context.log(bold("\nfeature usage"));
        const featureWidth = stats.features.reduce(
          (width, feature) => Math.max(width, feature.feature.length),
          0,
        );
        for (const feature of stats.features) {
          const flag = usageFlag(feature.rows, feature.exposure.opportunities);
          const tail = flag
            ? ` ${dim(flag)}`
            : feature.detail
              ? ` ${dim(feature.detail)}`
              : "";
          context.log(
            `  ${feature.feature.padEnd(featureWidth)}  ${String(feature.rows).padStart(6)}${tail}`,
          );
          context.log(
            dim(
              `    availability ${feature.availability.observations}/${feature.availability.opportunities}  exposure ${feature.exposure.observations}/${feature.exposure.opportunities}  use ${feature.use.observations}/${feature.use.opportunities}`,
            ),
          );
          if (feature.exposure.surfaces.length > 0)
            context.log(
              dim(
                `    surfaces ${feature.exposure.surfaces.map((surface) => `${surface.surface}:${surface.observations}/${surface.sessions}`).join("  ")}`,
              ),
            );
        }
      });
    },
  };
}
