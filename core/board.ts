/**
 * Rendering for the work board — the fold from rows to the lines a reader sees.
 *
 * Kept out of `cli.ts` so it can be tested without a terminal: every function
 * here takes a paint callback and returns strings, so the same code produces the
 * colourised board a human types `board` for and the plain text a `Stop` hook
 * will inject in P2.
 */

import { fit } from "./layout.ts";
import type { WorkFold, WorkItem, WorkStep } from "./work.ts";
import { progress } from "./work.ts";

/** No-op paint, for tests and for any consumer that is not a terminal. */
export const plain = (s: string): string => s;

export interface BoardPaint {
  readonly bold: (s: string) => string;
  readonly dim: (s: string) => string;
  readonly green: (s: string) => string;
  readonly red: (s: string) => string;
  readonly cyan: (s: string) => string;
  readonly name: (s: string) => string;
}

export const PLAIN_PAINT: BoardPaint = {
  bold: plain,
  dim: plain,
  green: plain,
  red: plain,
  cyan: plain,
  name: plain,
};

/**
 * A compact age: `2h`, `40m`, `just now`.
 *
 * Distinct from `agoText` because the board prints two of these per line
 * ("2h · updated 4m") and `2h ago · updated 4m ago` reads as noise at that
 * density — the column header already says they are ages.
 */
export function briefAge(fromMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - fromMs) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * `2h ago` / `just now` — for the one place that needs the suffix.
 *
 * `briefAge` is a DURATION ("updated 4m"), so appending "ago" to it produced
 * "started just now ago". The sentinel is the whole reason this is a function
 * rather than a template string at the call site.
 */
export function briefAgo(fromMs: number, nowMs: number): string {
  const age = briefAge(fromMs, nowMs);
  return age === "just now" ? age : `${age} ago`;
}

/** The `← current` marker, and the columns it costs. */
const CURRENT_TAIL = "   ← current";

/**
 * `✓ 2  migrate the call sites` — one checklist row.
 *
 * `width` is the WHOLE line's budget, not the text's. Passing a pre-subtracted
 * text budget is what overflowed: the caller cannot know that `← current` costs
 * another twelve columns, so the marker pushed the line past the terminal edge
 * on exactly the step a reader most wants to see.
 */
export function stepLine(
  step: WorkStep,
  isCurrent: boolean,
  width: number,
  paint: BoardPaint,
): string {
  const mark = step.doneMs > 0 ? paint.green("✓") : paint.dim("▪");
  const tail = isCurrent ? CURRENT_TAIL : "";
  // "      " + mark + " " + idx + "  "
  const prefix = 6 + 1 + 1 + String(step.idx).length + 2;
  const room = Math.max(8, width - prefix - tail.length);
  // The marker is the whole signal for a done step, so a ticked one is dimmed:
  // at six steps the two unticked ones should be what the eye lands on. Its note
  // is history and is dropped — the eye should land on what is LEFT.
  const body = step.note !== "" ? `${step.text} — ${step.note}` : step.text;
  const text =
    step.doneMs > 0 ? paint.dim(fit(step.text, room)) : fit(body, room);
  return `      ${mark} ${paint.dim(String(step.idx))}  ${text}${paint.cyan(tail)}`;
}

/**
 * One work item: its header, checklist, and folded state.
 *
 * `width` is the terminal's, and every line is fitted to it — a board that wraps
 * loses the indentation that carries the structure.
 */
export function itemLines(
  item: WorkItem,
  steps: readonly WorkStep[],
  fold: WorkFold,
  nowMs: number,
  width: number,
  paint: BoardPaint,
): string[] {
  const out: string[] = [];
  const p = progress(steps);
  const open = item.closedMs === 0;
  const marker = open ? paint.cyan("▸") : paint.green("✓");
  const countText = p.total > 0 ? `  ${p.done}/${p.total}` : "";
  const count = paint.dim(countText);
  const age = open
    ? `${briefAge(item.startedMs, nowMs)} · updated ${briefAge(item.updatedMs, nowMs)}`
    : `${item.outcome === "abandoned" ? "abandoned" : "closed"} ${briefAgo(item.closedMs, nowMs)}`;
  // Subject and age share the line, so the subject takes whatever the age does
  // not — a long subject truncates rather than pushing the age off the screen.
  //
  // EVERY WIDTH HERE IS MEASURED ON THE UNPAINTED TEXT. A painted string carries
  // ANSI escapes that occupy no columns, so padding computed from `.length`
  // after painting is wrong by however many escapes it contains — and wrong only
  // in a terminal, which is the one place it is ever seen.
  const subjectRoom = Math.max(12, width - 6 - age.length - countText.length - 1);
  const subject = fit(item.subject, subjectRoom);
  const used = 6 + [...subject].length + countText.length + age.length;
  out.push(
    `    ${marker} ${paint.bold(subject)}${count}${" ".repeat(Math.max(1, width - used))}${paint.dim(age)}`,
  );

  if (open) {
    for (const s of steps) {
      out.push(stepLine(s, p.current?.idx === s.idx, width, paint));
    }
  }
  if (fold.status !== "" && p.total === 0) {
    out.push(`      ${paint.dim(fit(fold.status, width - 8))}`);
  }
  if (fold.landed.length > 0) {
    out.push(`      ${paint.dim("landed  ")} ${fold.landed.map((s) => paint.cyan(s)).join("  ")}`);
  }
  for (const b of fold.breaks) {
    // The line the whole feature is for: today this fact exists only inside a
    // 2500-char broadcast that scrolled past.
    out.push(`      ${paint.red("⚠ breaks")} ${fit(b, width - 15)}`);
  }
  if (fold.needs !== "") {
    out.push(`      ${paint.red("needs   ")} ${fit(fold.needs, width - 15)}`);
  }
  return out;
}

/** `2 open · 1 closed`, or "" when there is nothing worth counting. */
export function agentTally(open: number, closed: number): string {
  const parts: string[] = [];
  if (open > 0) parts.push(`${open} open`);
  if (closed > 0) parts.push(`${closed} closed`);
  return parts.join(" · ");
}
