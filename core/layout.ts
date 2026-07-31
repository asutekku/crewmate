/**
 * Turning a roster into scannable columns.
 *
 * The problem this solves is measured, not aesthetic. The previous `who`
 * space-joined its fields, so nothing lined up vertically and line lengths ran
 * 78–276 characters against an 80-column terminal — every long line wrapped, and
 * a wrapped line is indistinguishable from a new agent's row. With seven agents
 * live the output was a wall.
 *
 * Three rules follow from that:
 *
 * 1. FIXED COLUMNS. A name column and an age column of known width mean the eye
 *    can drop down one column instead of re-reading each line.
 * 2. NOTHING EXCEEDS THE TERMINAL WIDTH. Text is truncated to fit rather than
 *    left to wrap, because a wrap costs a whole line and destroys the alignment
 *    the columns just bought.
 * 3. REPEATED FACTS MOVE TO THE HEADER. `⟲ old hooks` on seven rows says one
 *    thing seven times; it is a property of the roster, not of an agent.
 *
 * Pure string work, so it is testable without a terminal — the widths and
 * truncation are asserted rather than eyeballed, which is how two spacing bugs
 * shipped previously.
 */

/** Fallback when stdout is not a TTY (piped, redirected, or under a test). */
const DEFAULT_WIDTH = 80;

/** Below this, columns cost more than they buy and the layout goes single-file. */
const MIN_WIDTH = 60;

export function terminalWidth(): number {
  const cols = process.stdout.columns;
  return typeof cols === "number" && cols >= MIN_WIDTH ? cols : DEFAULT_WIDTH;
}

/**
 * Truncates to `max` display cells, with an ellipsis when it had to cut.
 *
 * Counts CODE POINTS, not UTF-16 units, so an emoji or CJK character in a
 * conversation title is not split into a broken half. Not full grapheme
 * segmentation — that needs Intl and this only has to avoid mojibake in a label.
 */
export function fit(text: string, max: number): string {
  if (max <= 0) return "";
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Pads to `width` code points; never truncates, so a caller must `fit` first. */
export function pad(text: string, width: number): string {
  const len = [...text].length;
  return len >= width ? text : text + " ".repeat(width - len);
}

/**
 * Files an agent touched that no one could meaningfully collide on.
 *
 * Agents write throwaway probes constantly — `tmpprobe/`, `tmpwb/`, `.p3msg.tmp`
 * — and they dominated the roster by volume: one live session held 17 of 18
 * claims in `tmpprobe/`, producing a 276-character line in which the single real
 * file was invisible. They are still COUNTED, because "this agent is poking at
 * things" is worth knowing; they are just never worth a path.
 */
export function isScratchPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return (
    // A TOP-LEVEL directory starting with tmp/temp/scratch. Anchoring at the
    // repo root is what makes this safe: agents drop probes in the root
    // (`tmpprobe/`, `tmpwb/`), while real code that merely starts with those
    // letters lives nested — `src/template/` was matched by an unanchored
    // `temp[^/]*` and would have hidden a genuine collision, which is far worse
    // than the noise the filter removes.
    /^(?:tmp|temp|scratch)[^/]*\//i.test(p) ||
    /\.tmp$/i.test(p) ||
    /(?:^|\/)node_modules\//.test(p)
  );
}

/** The deepest directory every path shares, or "" when they share none. */
export function commonDir(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const parts = paths.map((p) => p.replace(/\\/g, "/").split("/").slice(0, -1));
  const first = parts[0];
  if (first === undefined) return "";
  let depth = 0;
  while (depth < first.length && parts.every((p) => p[depth] === first[depth])) depth++;
  return first.slice(0, depth).join("/");
}

export interface FileSummaryOptions {
  /** Paths held by more than one agent — always named, never collapsed. */
  readonly contested?: ReadonlySet<string>;
  /** Beyond this many real files, collapse to a shared directory. */
  readonly collapseAbove?: number;
  readonly maxNamed?: number;
}

/**
 * One line describing what an agent is editing, or "" when there is nothing
 * worth saying.
 *
 * A CONTESTED PATH IS ALWAYS NAMED IN FULL, whatever else is collapsed: it is
 * the only entry in this list that requires action, so it can never be the one
 * hidden behind "(12 files)".
 */
/** One piece of the file line, tagged so the caller can colour it correctly. */
export interface FilePiece {
  readonly text: string;
  /** Contested paths are the only thing on this line that needs action. */
  readonly contested: boolean;
}

export function summarizeFiles(
  paths: readonly string[],
  opts: FileSummaryOptions = {},
): FilePiece[] {
  const contestedSet = opts.contested ?? new Set<string>();
  const collapseAbove = opts.collapseAbove ?? 3;
  const maxNamed = opts.maxNamed ?? 3;

  const contested = paths.filter((p) => contestedSet.has(p));
  const rest = paths.filter((p) => !contestedSet.has(p));
  const real = rest.filter((p) => !isScratchPath(p));
  const scratch = rest.length - real.length;

  // Contested first: it is the reason to read this line at all, and it must
  // survive any truncation applied further down.
  const pieces: FilePiece[] = contested.map((text) => ({ text, contested: true }));

  if (real.length > collapseAbove) {
    const dir = commonDir(real);
    // A shared directory says where the work is; without one, a bare count is
    // still better than three arbitrary names out of twelve.
    const label = dir !== "" ? `${dir}/ (${real.length} files)` : `${real.length} files`;
    pieces.push({ text: label, contested: false });
  } else {
    for (const p of real.slice(0, maxNamed)) {
      pieces.push({ text: p.split("/").pop() ?? p, contested: false });
    }
    const unnamed = real.length - Math.min(real.length, maxNamed);
    if (unnamed > 0) pieces.push({ text: `+${unnamed} more`, contested: false });
  }

  if (scratch > 0) pieces.push({ text: `+${scratch} scratch`, contested: false });
  return pieces;
}

/**
 * Renders pieces to a line no wider than `max`, colouring each by role.
 *
 * COLOUR IS APPLIED PER PIECE, AFTER truncation. Assembling a plain string,
 * wrapping the contested path in red, and then wrapping the whole line in `dim`
 * silently loses the red — `dim`'s trailing reset closes it — and truncating the
 * assembled string could cut the path so the substring replacement no longer
 * matched at all. Both happened; the contested file rendered plain.
 */
export function renderFileLine(
  pieces: readonly FilePiece[],
  max: number,
  paint: { contested: (s: string) => string; normal: (s: string) => string },
): string {
  const out: string[] = [];
  let used = 0;
  for (const piece of pieces) {
    const sep = out.length > 0 ? 2 : 0;
    const room = max - used - sep;
    if (room <= 0) break;
    // A contested path is never abbreviated away to nothing: it gets whatever
    // room is left, and if that is too little the line simply ends here.
    const text = fit(piece.text, room);
    if (text === "" || (text === "…" && piece.text !== "…")) break;
    out.push((piece.contested ? paint.contested : paint.normal)(text));
    used += sep + [...text].length;
  }
  return out.join("  ");
}

/** The fields of a running process this module needs; see `core/agents.ts`. */
export interface ProcessLike {
  readonly sessionId: string;
  readonly cwd: string;
  readonly startedAtMs: number;
}

/**
 * Running Claude processes in this repo that no roster row accounts for.
 *
 * These are sessions whose terminal was closed: the window is gone, the process
 * is not, and nothing in any UI reports them — two were found running for 48
 * hours in worktrees that were no longer in use.
 *
 * SCOPED TO THE REPO. `claude agents --json` is machine-wide, so without this
 * filter a session in an unrelated project would be reported here as a stray of
 * this one. Worktrees live beneath the root, so a prefix test keeps them; the
 * boundary check stops `/Traffic` from also matching `/Traffic-old`.
 *
 * Oldest first — age is what makes one worth acting on.
 */
export function backgroundProcesses<T extends ProcessLike>(
  processes: readonly T[],
  registered: ReadonlySet<string>,
  repoRoot: string,
): T[] {
  const root = repoRoot.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  return processes
    .filter((p) => !registered.has(p.sessionId))
    .filter((p) => {
      const cwd = p.cwd.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
      return cwd === root || cwd.startsWith(`${root}/`);
    })
    .slice()
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/** `just now` / `2m` / `3h` — short enough for a narrow fixed column. */
export function shortAge(tsMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - tsMs) / 1000));
  if (secs < 60) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
