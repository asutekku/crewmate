/**
 * Full-text search over past conversations, so a crashed window can be found
 * again and resumed.
 *
 * NO INDEX, BY MEASUREMENT: a streamed scan of the whole corpus (1179 files,
 * 970 MB) takes ~0.9 s on two cores, which is I/O bound rather than CPU bound.
 * An index would add invalidation and staleness to save under a second.
 *
 * TWO PASSES PER FILE, and the order is the optimisation. A raw BYTE search
 * rejects almost every file (5 survivors of 1179 for a real query); only a
 * survivor is decoded as UTF-8, which is what a naive version spent 75% of its
 * time on. Both passes stream, so memory follows the chunk, not the 53 MB file.
 */

import { createReadStream, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

/** Read size for the byte pass. One MB keeps syscalls few and memory flat. */
const CHUNK_BYTES = 1 << 20;

/** Characters of prose kept around a match, for the snippet. */
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 90;

/**
 * Concurrent file reads. TWO, matching the operator's core budget; measured at
 * 1074 ms (one), 892 ms (two) and 835 ms (four), so the third and fourth cores
 * buy 6% and the work is waiting on the disk either way.
 */
export const SCAN_CONCURRENCY = 2;

export interface TranscriptHit {
  /** The conversation uuid — what `claude --resume` takes. */
  readonly sessionId: string;
  readonly path: string;
  /** Absolute project path, read from the transcript's own `cwd`. */
  readonly projectPath: string;
  readonly title: string;
  /** How often the term appears in PROSE. Separates real work from a mention. */
  readonly count: number;
  readonly snippet: string;
  readonly lastMs: number;
}

/** Case-insensitive byte match, ASCII-folded. Avoids decoding a whole file. */
function byteIndexOf(
  buf: Uint8Array, len: number, lower: Uint8Array, upper: Uint8Array,
): number {
  const n = lower.length;
  if (n === 0 || len < n) return -1;
  const first = lower[0] as number;
  const firstUpper = upper[0] as number;
  const limit = len - n;
  for (let i = 0; i <= limit; i++) {
    const byte = buf[i] as number;
    if (byte !== first && byte !== firstUpper) continue;
    let j = 1;
    for (; j < n; j++) {
      const at = buf[i + j] as number;
      if (at !== lower[j] && at !== upper[j]) break;
    }
    if (j === n) return i;
  }
  return -1;
}

/**
 * Does the file contain these bytes anywhere? Reads in chunks, carrying a
 * needle-length overlap so a term split across a chunk boundary still matches.
 */
async function fileContains(
  path: string, lower: Uint8Array, upper: Uint8Array,
): Promise<boolean> {
  const overlap = Math.max(0, lower.length - 1);
  const handle = await open(path, "r");
  try {
    const buf = new Uint8Array(CHUNK_BYTES + overlap);
    let carried = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, carried, CHUNK_BYTES, null);
      if (bytesRead === 0) return false;
      const filled = carried + bytesRead;
      if (byteIndexOf(buf, filled, lower, upper) !== -1) return true;
      if (overlap === 0) {
        carried = 0;
        continue;
      }
      buf.copyWithin(0, filled - overlap, filled);
      carried = overlap;
    }
  } finally {
    await handle.close();
  }
}

/** The JSON string value for `key` on one line, unescaped, or "". */
function jsonString(line: string, key: string): string {
  const match = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(line);
  const raw = match?.[1];
  if (raw === undefined) return "";
  try {
    const value: unknown = JSON.parse(`"${raw}"`);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

interface ProseScan {
  readonly count: number;
  readonly snippet: string;
  readonly title: string;
  readonly projectPath: string;
  readonly lastMs: number;
}

/**
 * Counts matches in PROSE only, line by line.
 *
 * Assistant text and user prompts, never tool results or file contents: a term
 * inside a `Read` result means the file was open, not that the session worked
 * on it, and counting those makes every hit look equally strong.
 */
async function scanProse(path: string, needle: string): Promise<ProseScan> {
  const text = /"type":"text","text":"((?:[^"\\]|\\.)*)"/g;
  let count = 0;
  let snippet = "";
  let title = "";
  let projectPath = "";
  let lastMs = 0;
  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of reader) {
      // These three are cheap substring tests before any regex runs.
      if (line.includes('"aiTitle"')) {
        const found = jsonString(line, "aiTitle");
        if (found !== "") title = found;
      }
      if (projectPath === "" && line.includes('"cwd"')) {
        projectPath = jsonString(line, "cwd");
      }
      if (line.includes('"timestamp"')) {
        const stamp = Date.parse(jsonString(line, "timestamp"));
        if (!Number.isNaN(stamp) && stamp > lastMs) lastMs = stamp;
      }
      if (!line.toLowerCase().includes(needle)) continue;
      text.lastIndex = 0;
      for (const match of line.matchAll(text)) {
        const raw = match[1];
        if (raw === undefined) continue;
        let value = "";
        try {
          const parsed: unknown = JSON.parse(`"${raw}"`);
          if (typeof parsed !== "string") continue;
          value = parsed;
        } catch {
          continue;
        }
        const at = value.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        count++;
        // The NEWEST match wins: it describes where the work ended up.
        snippet = value
          .slice(Math.max(0, at - SNIPPET_BEFORE), at + SNIPPET_AFTER)
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  } finally {
    reader.close();
  }
  return { count, snippet, title, projectPath, lastMs };
}

/**
 * Top-level transcripts under `dirs`. Files inside `subagents/` are skipped:
 * a subagent has no conversation of its own and `--resume` cannot reach it.
 */
export function transcriptFiles(dirs: readonly string[]): string[] {
  const files: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(`${dir}/${entry}`);
    }
  }
  return files;
}

/** Every project directory Claude Code keeps transcripts in. */
export function everyProjectDir(projectsRoot: string): string[] {
  try {
    return readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${projectsRoot}/${entry.name}`);
  } catch {
    return [];
  }
}

function sessionIdOf(path: string): string {
  const file = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
}

/**
 * Searches `files` for `term`, strongest first.
 *
 * Rank is match count, then recency: a session that said it forty times was
 * working on it, and between two equal counts the newer one is the one being
 * looked for.
 */
export async function searchTranscripts(
  files: readonly string[],
  term: string,
  concurrency = SCAN_CONCURRENCY,
): Promise<TranscriptHit[]> {
  const needle = term.toLowerCase();
  if (needle === "") return [];
  const encoder = new TextEncoder();
  const lower = encoder.encode(needle);
  const upper = encoder.encode(needle.toUpperCase());
  const hits: TranscriptHit[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= files.length) return;
      const path = files[index] as string;
      try {
        if (!(await fileContains(path, lower, upper))) continue;
        const scan = await scanProse(path, needle);
        if (scan.count === 0) continue;
        hits.push({
          sessionId: sessionIdOf(path), path, projectPath: scan.projectPath,
          title: scan.title, count: scan.count, snippet: scan.snippet,
          lastMs: scan.lastMs,
        });
      } catch {
        // A transcript being written, removed or locked is not an error here.
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => worker()),
  );
  return hits.sort((a, b) => b.count - a.count || b.lastMs - a.lastMs);
}
