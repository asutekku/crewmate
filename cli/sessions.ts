/**
 * `crew sessions <words>` — find a conversation by what was said in it.
 *
 * FOR THE OPERATOR AFTER A CRASH: the window is gone and the roster row with
 * it, so the only durable record is the transcript on disk. Prints the
 * `claude --resume` line, which is the thing the operator actually wants.
 */

import { homedir } from "node:os";
import { bold, cyan, dim, green } from "../core/colour.ts";
import { shortAge, terminalWidth } from "../core/layout.ts";
import {
  everyProjectDir,
  searchTranscripts,
  transcriptFiles,
  type TranscriptHit,
} from "../core/transcript-search.ts";
import { projectTranscriptDir } from "../core/store/ownership.ts";
import { withStore } from "../core/store.ts";
import { booleanFlag, parseArguments, parseSafeInteger, stringFlag } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import type { CliContext, CommandMap } from "./types.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 200;

/** Where Claude Code keeps every project's transcripts. */
function projectsRoot(): string {
  const base = process.env["CLAUDE_CONFIG_DIR"] ?? `${homedir()}/.claude`;
  return `${base}/projects`;
}

/** The last path segment, for labelling a hit's project. */
function projectLabel(hit: TranscriptHit): string {
  const path = hit.projectPath;
  if (path === "") return "";
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Names the conversation from the archive, so a hit reads as an agent rather
 * than a uuid. Empty when it ended before `past_sessions` existed.
 */
function nameFor(dbPath: string, hits: readonly TranscriptHit[]): Map<string, string> {
  const names = new Map<string, string>();
  withStore(dbPath, (store) => {
    for (const hit of hits) {
      const past = store.past.find(hit.sessionId);
      const known = past === null ? "" : past.alias || past.handle;
      if (known !== "") names.set(hit.sessionId, known);
      else {
        // The ledger outlives even the archive: it is keyed on the uuid and
        // only released when the transcript leaves disk.
        const owned = store.owners.nameFor(hit.sessionId);
        if (owned !== "") names.set(hit.sessionId, owned);
      }
    }
  });
  return names;
}

function renderHit(
  context: CliContext,
  hit: TranscriptHit,
  name: string,
  nowMs: number,
  showProject: boolean,
): void {
  const age = hit.lastMs === 0 ? "" : shortAge(hit.lastMs, nowMs);
  const matches = `${hit.count} match${hit.count === 1 ? "" : "es"}`;
  const label = showProject ? projectLabel(hit) : "";
  const head = [
    name === "" ? dim("(unnamed)") : bold(cyan(name)),
    age === "" ? "" : dim(age),
    dim(matches),
    label === "" ? "" : dim(label),
  ].filter((part) => part !== "");
  context.log(`  ${head.join(dim(" · "))}`);
  if (hit.title !== "") context.log(`    ${hit.title}`);
  if (hit.snippet !== "") {
    const room = Math.max(30, terminalWidth() - 8);
    const text = hit.snippet.length > room ? `${hit.snippet.slice(0, room - 1)}…` : hit.snippet;
    context.log(dim(`    > ${text}`));
  }
  context.log(`    ${green(`claude --resume ${hit.sessionId}`)}`);
  context.log("");
}

export function createSessionCommands(context: CliContext): CommandMap {
  const sessions = (args: readonly string[]): void => {
    const parsed = parseArguments(args, {
      booleanFlags: ["--all"],
      valueFlags: ["--limit"],
    });
    if (!parsed.ok) return failCommand(context, `sessions: ${parsed.error}`);
    const term = parsed.value.positionals.join(" ").trim();
    if (term === "") return failUsage(context, "sessions");
    const limit = parseSafeInteger(stringFlag(parsed.value, "--limit"), "limit", {
      min: 1,
      max: MAX_LIMIT,
    });
    if (!limit.ok) return failCommand(context, `sessions: ${limit.error}`);
    const everywhere = booleanFlag(parsed.value, "--all");
    const dirs = everywhere
      ? everyProjectDir(projectsRoot())
      : [projectTranscriptDir(context.projectRoot)];
    const files = transcriptFiles(dirs);
    if (files.length === 0) {
      context.log(dim("no transcripts found — nothing to search."));
      return;
    }
    const now = context.now();
    void searchTranscripts(files, term).then((hits) => {
      if (hits.length === 0) {
        const where = everywhere ? "no conversation" : `nothing in ${context.projectName}`;
        context.log(dim(`${where} mentions "${term}".`));
        if (!everywhere) context.log(dim("  `--all` searches every project."));
        return;
      }
      const shown = hits.slice(0, limit.value ?? DEFAULT_LIMIT);
      const names = nameFor(context.dbPath, shown);
      context.log(
        dim(`${hits.length} conversation(s) mention "${term}", strongest first:`),
      );
      context.log("");
      for (const hit of shown) {
        renderHit(context, hit, names.get(hit.sessionId) ?? "", now, everywhere);
      }
      if (hits.length > shown.length) {
        context.log(dim(`  ${hits.length - shown.length} more — raise with \`--limit\`.`));
      }
    });
  };

  return { sessions };
}
