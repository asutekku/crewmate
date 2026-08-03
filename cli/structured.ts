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
export function parseStructuredShortcut(
  command: string | undefined,
  argv: readonly string[],
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
            ...(until
              ? { releaseBoundary: { text: until, handling: "manual" } }
              : {}),
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
