import { agentKey, progress } from "../core/work.ts";
import { briefAgo } from "../core/board.ts";
import { bold, cyan, dim, handleColour } from "../core/colour.ts";
import { fit, terminalWidth } from "../core/layout.ts";
import { withPersonal } from "../core/personal.ts";
import { displayName, withStore, type Store } from "../core/store.ts";
import { parseArguments, parseSafeInteger, stringFlag } from "./args.ts";
import { failCommand } from "./command.ts";
import { renderStats } from "./diagnostics-renderers.ts";
import { resolveLiveName } from "./identity.ts";
import { resolveTrustedPath } from "./paths.ts";
import { attempt, failure, success, type Result } from "./result.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import type { CliContext, CommandMap } from "./types.ts";

const DEFAULT_FILE_HISTORY_HOURS = 24;
const MAX_FILE_HISTORY_HOURS = 24 * 365;
const RECENT_EDITOR_SUGGESTION_LIMIT = 8;

interface FileEditView {
  readonly path: string;
  readonly tsMs: number;
  readonly worktree: string;
  readonly count: number;
}

interface WorkProgressView {
  readonly subject: string;
  readonly done: number;
  readonly total: number;
  readonly current?: string;
}

interface FilesView {
  readonly name: string;
  readonly live: boolean;
  readonly hours: number;
  readonly edits: readonly FileEditView[];
  readonly work: readonly WorkProgressView[];
  readonly recentNames: readonly string[];
}

interface BlameRowView {
  readonly agent: string;
  readonly sessionShort: string;
  readonly tsMs: number;
  readonly worktree: string;
  readonly tool: string;
}

interface BlameView {
  readonly path: string;
  readonly rows: readonly BlameRowView[];
}

function databaseBytes(path: string): number {
  return ["", "-wal", "-shm"].reduce(
    (total, suffix) => total + Bun.file(path + suffix).size,
    0,
  );
}

function historicalEditor(
  editors: readonly { readonly agent: string; readonly sessionId: string }[],
  query: string,
): Result<{ readonly agent: string; readonly sessionId: string } | undefined> {
  const wanted = query.toLowerCase();
  const exact = editors.filter((editor) => editor.agent.toLowerCase() === wanted);
  const candidates = exact.length > 0
    ? exact
    : editors.filter((editor) => editor.agent.toLowerCase().startsWith(wanted));
  const unique = new Map(candidates.map((editor) => [editor.sessionId, editor]));
  if (unique.size === 0) return success(undefined);
  if (unique.size === 1) return success(unique.values().next().value!);
  return failure(
    `ambiguous agent ${query}: ${[...unique.values()]
      .map((editor) => sanitizeTerminalText(editor.agent))
      .sort((a, b) => a.localeCompare(b))
      .join(", ")}`,
  );
}

function collectFilesView(
  store: Store,
  target: string,
  hours: number,
  nowMs: number,
): Result<FilesView> {
  const sinceMs = nowMs - hours * 60 * 60 * 1000;
  const liveResult = resolveLiveName(store.liveSessions(nowMs), target);
  if (!liveResult.ok && liveResult.kind === "ambiguous")
    return failure(`ambiguous agent ${target}: ${liveResult.candidates.join(", ")}`);
  const past = store.editAgents(sinceMs);
  const historical = historicalEditor(past, target);
  if (!historical.ok) return historical;
  const live = liveResult.ok ? liveResult.value : undefined;
  const sessionId = live?.sessionId ?? historical.value?.sessionId ?? "";
  const recentNames = [...new Set(past.map((editor) => sanitizeTerminalText(editor.agent)))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, RECENT_EDITOR_SUGGESTION_LIMIT);
  if (sessionId === "")
    return success({ name: "", live: false, hours, edits: [], work: [], recentNames });
  const name = sanitizeTerminalText(live ? displayName(live) : historical.value?.agent ?? "");
  const edits = store.editsBy(sessionId, sinceMs).map((edit) => ({
    path: sanitizeTerminalText(edit.path),
    tsMs: edit.tsMs,
    worktree: sanitizeTerminalText(edit.worktree),
    count: edit.count,
  }));
  const work = store.work.openItems(agentKey("", sessionId)).map((item) => {
    const state = progress(store.work.steps(item.workId));
    return {
      subject: sanitizeTerminalText(item.subject),
      done: state.done,
      total: state.total,
      ...(state.current ? { current: sanitizeTerminalText(state.current.text) } : {}),
    };
  });
  return success({ name, live: live !== undefined, hours, edits, work, recentNames });
}

function renderFiles(context: CliContext, view: FilesView, target: string, nowMs: number, width: number): void {
  if (view.name === "") {
    context.error(`no agent named ${bold(sanitizeTerminalText(target))} has edited anything in ${view.hours}h`);
    if (view.recentNames.length > 0)
      context.error(dim(`  seen recently: ${view.recentNames.join(", ")}`));
    context.fail();
    return;
  }
  if (view.edits.length === 0) {
    context.log(dim(`${view.name} has edited nothing in the last ${view.hours}h.`));
    return;
  }
  context.log(
    `${bold(handleColour(view.name)(view.name))} ${dim(`— ${view.edits.length} file(s) in ${view.hours}h`)}${view.live ? "" : dim("  (session ended — this is history)")}`,
  );
  for (const item of view.work) {
    context.log(`  ${cyan("▸")} ${item.subject}${dim(item.total > 0 ? ` ${item.done}/${item.total}` : "")}`);
    if (item.current) context.log(`    ${dim("now")}  ${item.current}`);
  }
  const trees = new Set(view.edits.map((edit) => edit.worktree).filter(Boolean));
  for (const edit of view.edits) {
    const when = dim(briefAgo(edit.tsMs, nowMs).padStart(9));
    const times = edit.count > 1 ? dim(` ×${edit.count}`) : "";
    const tree = trees.size > 1 && edit.worktree
      ? dim(` [${edit.worktree.split("/").pop() ?? ""}]`)
      : "";
    context.log(`  ${when}  ${fit(edit.path, Math.max(8, width - 26))}${times}${tree}`);
  }
}

function renderBlame(context: CliContext, view: BlameView, nowMs: number, width: number): void {
  if (view.rows.length === 0) {
    context.log(dim(`No recorded edits to ${view.path}.`));
    context.log(dim("  Only files edited through Claude Code's tools are tracked."));
    return;
  }
  context.log(bold(view.path));
  for (const row of view.rows) {
    const when = dim(briefAgo(row.tsMs, nowMs).padStart(9));
    const tree = row.worktree ? dim(` [${row.worktree.split("/").pop() ?? ""}]`) : "";
    const tool = row.tool ? dim(` ${row.tool}`) : "";
    const who = row.agent || dim(row.sessionShort);
    context.log(`  ${when}  ${fit(handleColour(who)(who), Math.max(8, width - 30))}${tool}${tree}`);
  }
}

function handleFiles(context: CliContext, args: readonly string[]): void {
  const parsed = parseArguments(args, { valueFlags: ["--hours"] });
  if (!parsed.ok) return failCommand(context, `files: ${parsed.error}`);
  const parsedHours = parseSafeInteger(stringFlag(parsed.value, "--hours"), "hours", {
    min: 1,
    max: MAX_FILE_HISTORY_HOURS,
  });
  if (!parsedHours.ok) return failCommand(context, `files: ${parsedHours.error}`);
  const target = parsed.value.positionals.join(" ").trim();
  if (!target) return failCommand(context, "usage: crew files <agent> [--hours n]");
  const now = context.now();
  const width = terminalWidth();
  const view = withStore(context.dbPath, (store) =>
    collectFilesView(store, target, parsedHours.value ?? DEFAULT_FILE_HISTORY_HOURS, now),
  );
  if (!view.ok) return failCommand(context, view.error);
  renderFiles(context, view.value, target, now, width);
}

function handleBlame(context: CliContext, args: readonly string[]): void {
  const parsed = parseArguments(args, {});
  if (!parsed.ok) return failCommand(context, `blame: ${parsed.error}`);
  const path = parsed.value.positionals.join(" ").trim();
  if (!path) return failCommand(context, "usage: crew blame <path>");
  const resolved = resolveTrustedPath(path, context.projectRoot);
  if (!resolved.ok) return failCommand(context, resolved.error);
  const now = context.now();
  const width = terminalWidth();
  const view = withStore(context.dbPath, (store): BlameView => ({
    path: sanitizeTerminalText(resolved.value.relative),
    rows: store.editsOf(resolved.value.relative).map((row) => ({
      agent: sanitizeTerminalText(row.agent),
      sessionShort: sanitizeTerminalText(row.sessionId.slice(0, 8)),
      tsMs: row.tsMs,
      worktree: sanitizeTerminalText(row.worktree),
      tool: sanitizeTerminalText(row.tool),
    })),
  }));
  renderBlame(context, view, now, width);
}

function handleStats(context: CliContext, args: readonly string[]): void {
  const parsed = parseArguments(args, { maxPositionals: 0 });
  if (!parsed.ok) return failCommand(context, `stats: ${parsed.error}`);
  const personal = attempt(() => withPersonal((store) => store.count()));
  const databaseSize = databaseBytes(context.dbPath);
  const now = context.now();
  const stats = withStore(context.dbPath, (store) =>
    store.stats(personal.ok ? personal.value : 0),
  );
  renderStats(context, {
    stats,
    nowMs: now,
    databaseBytes: databaseSize,
    ...(!personal.ok ? { personalError: personal.error } : {}),
  });
}

export function createDiagnosticCommands(context: CliContext): CommandMap {
  return {
    files: (args) => handleFiles(context, args),
    blame: (args) => handleBlame(context, args),
    stats: (args) => handleStats(context, args),
  };
}
