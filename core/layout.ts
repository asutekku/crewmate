/**
 * Turning a roster into scannable columns. Three rules, because a wrapped line
 * is indistinguishable from a new agent's row:
 *
 * 1. FIXED COLUMNS, so the eye drops down one instead of re-reading each line.
 * 2. NOTHING EXCEEDS THE TERMINAL WIDTH — truncate rather than let it wrap.
 * 3. REPEATED FACTS MOVE TO THE HEADER; they belong to the roster, not a row.
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
 * Breaks text onto lines of at most `max` cells, at word boundaries.
 *
 * For text where the END CARRIES MEANING, such as a diary title. Use `fit`
 * where the start identifies it instead. An over-long word takes its own line
 * rather than breaking, because a split identifier is not searchable by eye.
 */
export function wrap(text: string, max: number): string[] {
  if (max <= 0) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line === "") {
      line = word;
    } else if ([...line].length + 1 + [...word].length <= max) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.length > 0 ? lines : [""];
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
 * Throwaway probes dominate the roster by volume and bury the one real file.
 * Still COUNTED, because "this agent is busy" is worth knowing; never named.
 */
export function isScratchPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  return (
    // A TOP-LEVEL directory only. Anchoring at the repo root is what makes
    // this safe: unanchored, `temp[^/]*` also matches `src/template/` and
    // would hide a genuine collision.
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
  // Contested paths are shown IN FULL, never shortened. They are the one entry
  // on the line that requires a decision, so the reader must be able to act on
  // the text without reconstructing it -- and a red marker on an ambiguous name
  // is worse than no marker at all.
  const pieces: FilePiece[] = contested.map((text) => ({ text, contested: true }));

  if (real.length > collapseAbove) {
    const dir = commonDir(real);
    // A shared directory says where the work is; without one, a bare count is
    // still better than three arbitrary names out of twelve.
    const label = dir !== "" ? `${dir}/ (${real.length} files)` : `${real.length} files`;
    pieces.push({ text: label, contested: false });
  } else {
    const named = real.slice(0, maxNamed);
    const label = disambiguate([...contested, ...named]);
    for (const p of named) {
      pieces.push({ text: label(p), contested: false });
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
 * Running Claude processes in this repo that no roster row accounts for —
 * sessions whose terminal closed while the process lived on.
 *
 * SCOPED TO THE REPO, because `claude agents --json` is machine-wide. The
 * boundary check stops `/Traffic` matching `/Traffic-old`. Oldest first.
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

/**
 * Shortest path suffix that still names ONE file, per path.
 *
 * NOT the bare basename: contention is computed on the FULL path, so
 * `README.md` and `plans/README.md` displayed alike make two agents in
 * different files read as a collision. Identical paths are one file.
 */
export function disambiguate(paths: readonly string[]): (path: string) => string {
  const unique = [...new Set(paths)];
  const suffix = (path: string, depth: number): string =>
    path.split("/").slice(-depth).join("/");
  const resolved = new Map<string, string>();
  for (const path of unique) {
    const segments = path.split("/").length;
    let depth = 1;
    // Grow until this path's suffix is claimed by no OTHER path, or until the
    // whole path is spelled out and there is nothing further to add.
    while (
      depth < segments &&
      unique.some((other) => other !== path && suffix(other, depth) === suffix(path, depth))
    )
      depth += 1;
    resolved.set(path, suffix(path, depth));
  }
  return (path: string) => resolved.get(path) ?? (path.split("/").pop() ?? path);
}

/**
 * THE GLYPH FOR EACH AGENT STATE, DEFINED ONCE, because `who` and `board` once
 * disagreed about what `○` meant. Keyed on `AgentState` so a new state is a
 * type error in both renderers rather than a silently missing row.
 */
export const STATE_GLYPHS = {
  waiting: "⏸",
  busy: "●",
  idle: "◐",
  gone: "○",
} as const;

/** One legend entry per state, in reading order: most to least urgent. */
export const STATE_LEGEND: ReadonlyArray<{
  readonly state: keyof typeof STATE_GLYPHS;
  readonly label: string;
}> = [
  { state: "busy", label: "running" },
  { state: "waiting", label: "needs you" },
  { state: "idle", label: "at a prompt" },
  { state: "gone", label: "gone" },
];

/**
 * The legend line, rendered from the table above.
 *
 * `states` selects which entries appear, because the two surfaces genuinely
 * differ: `who` has no `gone` rows to explain. `extras` carries the
 * surface-specific tail (`✎ files this agent holds`, `— no plan recorded`)
 * that is not a state at all.
 */
export function stateLegend(
  states: ReadonlyArray<keyof typeof STATE_GLYPHS>,
  extras: readonly string[] = [],
  paint: (state: keyof typeof STATE_GLYPHS, glyph: string) => string = (_s, g) => g,
): string {
  const entries = STATE_LEGEND.filter((e) => states.includes(e.state)).map(
    (e) => `${paint(e.state, STATE_GLYPHS[e.state])} ${e.label}`,
  );
  return `  ${[...entries, ...extras].join("   ")}`;
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
