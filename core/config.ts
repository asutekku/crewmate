/**
 * Tunable lifetimes, read from `~/.claude/agent-presence/config.json`.
 *
 * THE FILE IS OPTIONAL. Every value has a default that applies when it is
 * missing, unreadable or malformed — this is read on hook paths, so a parse
 * error must degrade to defaults rather than take a session's edit with it.
 */

import { readFileSync } from "node:fs";

import { BASE_DIR } from "./repo.ts";

/** Every tunable, with the value used when the file says nothing. */
export interface PresenceConfig {
  /** A session with no heartbeat for this long is treated as gone. */
  readonly staleMs: number;
  /** How long a claim keeps meaning "I am working on this". */
  readonly claimTtlMs: number;
  /** How long an overlap announcement stays "already said". */
  readonly claimReannounceMs: number;
  /** How long a CLOSED work record is kept. Open ones never expire. */
  readonly workKeepMs: number;
  /** How long edit history is kept. There is no "off"; the knob is how long. */
  readonly editKeepMs: number;
  /**
   * How long a minion with no SubagentStop is still believed to be running.
   * MUCH SHORTER than session staleness: a quiet session is usually still
   * there, where a silent subagent has almost always died with its parent.
   */
  readonly minionStaleMs: number;
  /**
   * How long a diary entry is kept. LONG, because it answers a question about
   * the past; an entry that expires while its code stands has failed its job.
   */
  readonly diaryKeepMs: number;
  /**
   * How long a DEPRECATED entry is kept. Shorter than the above but not zero:
   * why a thing stopped being true outlives the claim itself.
   */
  readonly diaryDeprecatedKeepMs: number;
  /**
   * How long an open work item can sit untouched before its agent is asked
   * whether it is still real. Shorter interrupts work in progress; longer
   * leaves the board advertising items nobody is doing.
   */
  readonly workStaleMs: number;
  /**
   * What session-start CANDIDATES are allocated against, in characters.
   *
   * NOT a hard ceiling: the mandatory header is subtracted first and renders
   * even when it alone exceeds this, and the omitted-items line sits outside
   * it. Sized at roughly 1.6x the busiest real block.
   */
  readonly injectionTargetChars: number;
  /**
   * How long injection exposure and omission rows are kept.
   *
   * ITS OWN HORIZON, not `staleMs`. A session leaves the roster after 90
   * minutes of silence but can be resumed hours or days later, and resume is
   * the one lifecycle where suppression is correct — reusing the roster's TTL
   * would silently make the feature useless on the only path it serves. A week
   * covers a conversation picked up after a weekend and still bounds two tables
   * that would otherwise grow forever.
   */
  readonly injectionKeepMs: number;
}

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULTS: PresenceConfig = {
  staleMs: 90 * 60 * 1000, // 90 min
  claimTtlMs: 2 * 60 * 60 * 1000, // 2 h
  claimReannounceMs: 30 * 60 * 1000, // 30 min
  workKeepMs: 7 * DAY,
  editKeepMs: 30 * DAY,
  minionStaleMs: 60 * 60 * 1000, // 1 h
  diaryKeepMs: 365 * DAY,
  diaryDeprecatedKeepMs: 90 * DAY,
  workStaleMs: 60 * 60 * 1000, // 1 h
  injectionTargetChars: 6000, // ~1.6x the busiest measured block (3,772)
  injectionKeepMs: 7 * DAY,
};

export function configPath(): string {
  return `${BASE_DIR}/config.json`;
}

/**
 * Read once per process, so every caller sees the same numbers.
 *
 * A CONSISTENCY guarantee, not an optimisation: `STALE_MS` and friends load at
 * module time while `register` and `pruneStale` call this later, so an edit
 * between those points gave one process two different configs.
 */
let cached: PresenceConfig | null = null;

export function loadConfig(): PresenceConfig {
  if (cached !== null) return cached;
  cached = readConfig();
  return cached;
}

/** Test seam: forget the cached config so a fixture can write a new one. */
export function clearConfigCache(): void {
  cached = null;
}

/**
 * Reads the config, falling back per FIELD rather than per file, so one
 * misspelled key cannot silently revert every other setting.
 *
 * Values must be finite and positive: a zero makes the next sweep delete
 * everything, and `"7 days"` reads as NaN, which makes nothing ever expire.
 */
function readConfig(): PresenceConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return DEFAULTS;
  }
  if (typeof raw !== "object" || raw === null) return DEFAULTS;
  const given = raw as Record<string, unknown>;
  const pick = (key: keyof PresenceConfig): number => {
    const v = given[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULTS[key];
  };
  return {
    staleMs: pick("staleMs"),
    claimTtlMs: pick("claimTtlMs"),
    claimReannounceMs: pick("claimReannounceMs"),
    workKeepMs: pick("workKeepMs"),
    editKeepMs: pick("editKeepMs"),
    minionStaleMs: pick("minionStaleMs"),
    diaryKeepMs: pick("diaryKeepMs"),
    diaryDeprecatedKeepMs: pick("diaryDeprecatedKeepMs"),
    workStaleMs: pick("workStaleMs"),
    injectionTargetChars: pick("injectionTargetChars"),
    injectionKeepMs: pick("injectionKeepMs"),
  };
}
