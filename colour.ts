/**
 * ANSI colour for the CLI's terminal output.
 *
 * FOR THE TERMINAL ONLY. Hook output goes into an agent's context window, where
 * escape codes are noise that costs tokens and can only confuse a reader — so
 * `shared.ts` formats plain text and the CLI colours it on the way out. Nothing
 * that reaches `additionalContext` passes through here.
 *
 * Colour is a SECOND channel, never the only one: every distinction it draws is
 * also in the words, so a piped log, a CI capture, or a terminal that does not
 * support colour loses decoration and no information.
 */

import { HANDLES } from "./store.ts";

/**
 * Honours NO_COLOR (informal cross-tool standard) and FORCE_COLOR, then falls
 * back to whether stdout is a terminal — piping to a file or a pager should
 * yield clean text.
 */
function colourEnabled(): boolean {
  const env = process.env;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") return true;
  // Bun exposes tty-ness here; when unavailable, assume no colour rather than
  // risk writing escapes into a file.
  return Boolean(process.stdout.isTTY);
}

const ON = colourEnabled();

/** \x1b is spelled out: a raw ESC byte in source is invisible in an editor. */
const ESC = "\x1b";
const code =
  (n: string) =>
  (s: string): string =>
    ON ? `${ESC}[${n}m${s}${ESC}[0m` : s;

export const dim = code("2");
export const bold = code("1");
export const red = code("31");
export const green = code("32");
export const yellow = code("33");
export const blue = code("34");
export const magenta = code("35");
export const cyan = code("36");

/**
 * A stable colour per handle, so one agent keeps its colour across commands and
 * you can track it down a log by eye.
 *
 * Handles are drawn from a FIXED, ORDERED pool, so a colour is just that pool's
 * index — which guarantees the first five agents are all different. Hashing the
 * name was tried first and is wrong here: over a handful of short similar
 * strings it collides readily (`ada` and `hopper` both landed on blue), and two
 * peers sharing a colour defeats the only thing this is for.
 *
 * Red is excluded: it is reserved for genuine problems (contested files), and an
 * agent that happened to be red would read as an alert.
 */
const HANDLE_COLOURS = [cyan, green, yellow, magenta, blue] as const;

export function handleColour(handle: string): (s: string) => string {
  // Imported, not duplicated: two lists that must agree will eventually not.
  const i = (HANDLES as readonly string[]).indexOf(handle);
  // A real Claude session name (`traffic-12`) is outside the pool; hash it so it
  // still gets a stable colour rather than defaulting to one already in use.
  if (i < 0) {
    let h = 0;
    for (let k = 0; k < handle.length; k++) h = (h * 131 + handle.charCodeAt(k)) >>> 0;
    return HANDLE_COLOURS[h % HANDLE_COLOURS.length] ?? cyan;
  }
  return HANDLE_COLOURS[i % HANDLE_COLOURS.length] ?? cyan;
}

/**
 * Colours a whole roster so no two members share one, which index-by-name alone
 * cannot promise once names are arbitrary. Assignment follows roster order, and
 * only wraps when there are more agents than colours.
 */
export function rosterColours<T>(
  items: readonly T[],
  nameOf: (t: T) => string,
): Map<string, (s: string) => string> {
  const out = new Map<string, (s: string) => string>();
  items.forEach((item, i) => {
    out.set(nameOf(item), HANDLE_COLOURS[i % HANDLE_COLOURS.length] ?? cyan);
  });
  return out;
}

/** Older than this and a session is likely a ghost rather than a busy peer. */
const IDLE_WARN_MS = 15 * 60 * 1000;

/** Fresh activity reads green, going-quiet amber, likely-dead dim. */
export function activityColour(ageMs: number): (s: string) => string {
  if (ageMs < 5 * 60 * 1000) return green;
  if (ageMs < IDLE_WARN_MS) return yellow;
  return dim;
}
