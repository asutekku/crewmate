import type { StructuredActInput } from "../core/obligations.ts";
import { failure, success, type Result } from "./result.ts";

export type StructuredShortcut =
  "request" | "promise" | "handoff" | "grant" | "correct" | "hazard";

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

const SHORTCUTS: ReadonlySet<string> = new Set<StructuredShortcut>([
  "request",
  "promise",
  "handoff",
  "grant",
  "correct",
  "hazard",
]);

function takeFlag(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) return "";
  const value = args[index + 1] ?? "";
  args.splice(index, 2);
  return value;
}

/** Pure parser for the short, one-act semantic messaging commands. */
export function parseStructuredShortcut(
  command: string | undefined,
  rawArgs: readonly string[],
): StructuredShortcutResult {
  if (!command || !SHORTCUTS.has(command)) return { matched: false };
  const shortcut = command as StructuredShortcut;
  const args = [...rawArgs];
  const target = args.shift() ?? "";

  if (shortcut === "promise") {
    const refrainIndex = args.indexOf("--refrain");
    const refrain = refrainIndex >= 0;
    if (refrain) args.splice(refrainIndex, 1);
    const until = takeFlag(args, "--until");
    const text = args.join(" ").trim();
    if (!target || !text || (refrain && !until)) {
      return { matched: true, result: failure("invalid shortcut arguments") };
    }
    const promise: StructuredActInput = {
      key: "promise",
      type: "promise",
      text,
      mode: refrain ? "refrain" : "perform",
      ...(until
        ? { releaseBoundary: { text: until, handling: "manual" } }
        : {}),
    };
    return {
      matched: true,
      result: success({ command: shortcut, target, acts: [promise] }),
    };
  }

  if (shortcut === "correct") {
    const kind = args.shift();
    const correctionType =
      kind === "self"
        ? "self_erratum"
        : kind === "peer"
          ? "peer_correction"
          : kind === "implementation"
            ? "implementation_correction"
            : undefined;
    const text = args.join(" ").trim();
    if (!target || !correctionType || !text) {
      return { matched: true, result: failure("invalid shortcut arguments") };
    }
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
    const subject = args.shift() ?? "";
    const text = args.join(" ").trim();
    if (!target || !subject || !text) {
      return { matched: true, result: failure("invalid shortcut arguments") };
    }
    return {
      matched: true,
      result: success({
        command: shortcut,
        target,
        acts: [{ key: "hazard", type: "hazard", text, subject }],
      }),
    };
  }

  const text = args.join(" ").trim();
  if (!target || !text)
    return { matched: true, result: failure("invalid shortcut arguments") };

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
