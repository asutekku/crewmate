/**
 * Reading a session's own transcript for facts Claude Code already computed —
 * the `ai-title` it rewrites every turn, and `last-prompt`.
 *
 * BOUNDED READ, ALWAYS: these files reach 25 MB against a hook budget in
 * milliseconds, so nothing parses them. A fixed tail plus a regex, which is
 * where the current values are anyway. An ABSENT title is normal, not an error.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * How much of the tail to scan. Large enough that several turns' worth of
 * records fall inside it even when one turn writes a lot (a big tool result),
 * small enough to stay a single cheap read on a 25 MB file.
 */
const TAIL_BYTES = 256 * 1024;

/** The last `bytes` of a file as text, or "" if it cannot be read. */
function tailText(path: string, bytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, start);
    // A mid-character split at the window boundary is possible; utf8 decoding
    // yields a replacement char there, which only ever affects the first
    // partial line — never a record we go on to match.
    return buf.toString("utf8");
  } catch {
    // A transcript being rotated, a path that does not exist, a permission
    // problem: all mean "no title available", which every caller handles.
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * The last JSON string value for `key` in `text`.
 *
 * Regex rather than a JSON parse of each line: the tail starts mid-line and
 * contains megabytes of records we do not want, so parsing it is far more work
 * than matching one key. The value is unescaped through `JSON.parse` so
 * embedded quotes and newlines come back correct.
 */
function lastJsonString(text: string, key: string): string {
  const re = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, "g");
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1] ?? null;
  if (last === null) return "";
  try {
    const value: unknown = JSON.parse(`"${last}"`);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

export interface TranscriptFacts {
  /** Claude Code's own conversation name, or "" when it has not written one. */
  readonly title: string;
  /** The latest user prompt, as Claude Code recorded it (already truncated). */
  readonly lastPrompt: string;
}

export function readTranscript(path: string): TranscriptFacts {
  const text = tailText(path, TAIL_BYTES);
  if (text === "") return { title: "", lastPrompt: "" };
  return {
    title: lastJsonString(text, "aiTitle"),
    lastPrompt: lastJsonString(text, "lastPrompt"),
  };
}

/**
 * Recent assistant prose from the tail, oldest first, for summarisation.
 *
 * ASSISTANT TEXT, NOT USER PROMPTS: what an agent just said it did describes
 * the work better than what it was asked hours ago. Only `{"type":"text"}`
 * blocks match, which keeps file contents and command output out.
 */
export function recentAssistantText(path: string, maxChars = 4000): string {
  const text = tailText(path, TAIL_BYTES);
  if (text === "") return "";
  const re = /"type":"text","text":"((?:[^"\\]|\\.)*)"/g;
  const chunks: string[] = [];
  for (const m of text.matchAll(re)) {
    const raw = m[1];
    if (raw === undefined) continue;
    try {
      const value: unknown = JSON.parse(`"${raw}"`);
      // Short fragments are acknowledgements ("Done.", "Let me check") and
      // crowd out the substantive paragraphs within the character budget.
      if (typeof value === "string" && value.length >= 80) chunks.push(value);
    } catch {
      /* a fragment split by the window boundary */
    }
  }
  // The LAST few, since the newest text describes the current work; assembled
  // oldest-first so the summariser reads them in the order they happened.
  const tail: string[] = [];
  let total = 0;
  for (let i = chunks.length - 1; i >= 0 && total < maxChars; i--) {
    const c = chunks[i] as string;
    tail.unshift(c);
    total += c.length;
  }
  return tail.join("\n\n").slice(0, maxChars);
}
