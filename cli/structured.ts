import type { StructuredActInput } from "../core/obligations.ts";
import { booleanFlag, parseArguments, stringFlag } from "./args.ts";
import { failure, success, type Result } from "./result.ts";

export const STRUCTURED_SHORTCUTS = [
  "request",
  "promise",
  "handoff",
  "grant",
  "correct",
  "hazard",
] as const;
export type StructuredShortcut = (typeof STRUCTURED_SHORTCUTS)[number];

export interface ParsedStructuredShortcut {
  readonly command: StructuredShortcut;
  readonly target: string;
  readonly acts: readonly StructuredActInput[];
}

export type StructuredShortcutResult =
  | { readonly matched: false }
  | {
      readonly matched: true;
      readonly result: Result<ParsedStructuredShortcut>;
    };

function shortcutNamed(
  command: string | undefined,
): StructuredShortcut | undefined {
  return STRUCTURED_SHORTCUTS.find((candidate) => candidate === command);
}

function invalid(message: string): StructuredShortcutResult {
  return { matched: true, result: failure(message) };
}

/** Pure, non-mutating parser for the short single-act semantic commands. */
/**
 * `--until` as a release boundary.
 *
 * A DURATION (`4h`, `30m`, `2d`) becomes an automatic deadline, which is the
 * only form anything can act on. Prose stays `manual` and waits for a human —
 * honest, but it is why `expire` had no trigger and a binding obligation could
 * outlive every session that cared about it.
 *
 * `nowMs` is a parameter because this file is a PURE parser: reading the clock
 * here would make the result depend on when it ran, which is exactly what
 * `cli-architecture.test.ts` forbids.
 */
export function releaseBoundaryFor(
  until: string,
  nowMs: number,
): { text: string; handling: "manual" } | {
  text: string;
  handling: "automatic";
  trigger: { kind: "deadline"; atMs: number };
} {
  const match = /^(\d+)\s*([mhd])$/i.exec(until.trim());
  if (!match) return { text: until, handling: "manual" };
  const scale = { m: 60_000, h: 3_600_000, d: 86_400_000 }[
    (match[2] ?? "h").toLowerCase() as "m" | "h" | "d"
  ];
  return {
    text: until,
    handling: "automatic",
    trigger: { kind: "deadline", atMs: nowMs + Number(match[1]) * scale },
  };
}

export function parseStructuredShortcut(
  command: string | undefined,
  argv: readonly string[],
  nowMs = 0,
): StructuredShortcutResult {
  const shortcut = shortcutNamed(command);
  if (!shortcut) return { matched: false };
  const parsed = parseArguments(
    argv,
    shortcut === "promise"
      ? { valueFlags: ["--until"], booleanFlags: ["--refrain"] }
      : {},
  );
  if (!parsed.ok) return invalid(parsed.error);
  const [target = "", ...rest] = parsed.value.positionals;

  if (shortcut === "promise") {
    const refrain = booleanFlag(parsed.value, "--refrain");
    const until = stringFlag(parsed.value, "--until");
    const text = rest.join(" ").trim();
    if (!target || !text) return invalid("promise requires a target and text");
    if (refrain && !until)
      return invalid("--refrain requires --until <condition>");
    return {
      matched: true,
      result: success({
        command: shortcut,
        target,
        acts: [
          {
            key: "promise",
            type: "promise",
            text,
            mode: refrain ? "refrain" : "perform",
            // A DURATION BECOMES A DEADLINE; anything else stays prose.
            // `--until "the release lands"` is honest but unactionable, so it
            // remains `manual` and a human resolves it. `--until 4h` can be
            // acted on, and is the only form that lets `expire` ever fire --
            // without it a binding obligation outlives every session that
            // cared, above the roster in its target's injection.
            ...(until ? { releaseBoundary: releaseBoundaryFor(until, nowMs) } : {}),
          },
        ],
      }),
    };
  }

  if (shortcut === "correct") {
    const [kind, ...words] = rest;
    const correctionType =
      kind === "self"
        ? "self_erratum"
        : kind === "peer"
          ? "peer_correction"
          : kind === "implementation"
            ? "implementation_correction"
            : undefined;
    const text = words.join(" ").trim();
    if (!target || !correctionType || !text)
      return invalid("correct requires target, correction kind, and text");
    return {
      matched: true,
      result: success({
        command: shortcut,
        target,
        acts: [{ key: "correction", type: "correction", text, correctionType }],
      }),
    };
  }

  if (shortcut === "hazard") {
    const [subject = "", ...words] = rest;
    const text = words.join(" ").trim();
    if (!target || !subject || !text)
      return invalid("hazard requires target, subject, and warning text");
    return {
      matched: true,
      result: success({
        command: shortcut,
        target,
        acts: [{ key: "hazard", type: "hazard", text, subject }],
      }),
    };
  }

  const text = rest.join(" ").trim();
  if (!target || !text)
    return invalid(`${shortcut} requires a target and text`);
  const act: StructuredActInput =
    shortcut === "request"
      ? { key: "request", type: "request", text }
      : shortcut === "handoff"
        ? {
            key: "handoff",
            type: "handoff",
            text: `Responsibility for ${text}`,
            subject: text,
          }
        : {
            key: "grant",
            type: "grant",
            text: `Go ahead on ${text}`,
            scopeText: text,
          };
  return {
    matched: true,
    result: success({ command: shortcut, target, acts: [act] }),
  };
}
