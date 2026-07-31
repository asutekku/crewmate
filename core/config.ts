/**
 * Tunable lifetimes, read from `~/.claude/agent-presence/config.json`.
 *
 * WHY A FILE RATHER THAN MORE CONSTANTS. There are now five separate horizons —
 * how long a session is alive, how long a claim means "mine", how long a name is
 * held, how long a closed work record is kept, how long edit history survives —
 * and they answer genuinely different questions. A fifth hardcoded constant is
 * where that stops being reviewable.
 *
 * THE FILE IS OPTIONAL AND ALWAYS HAS BEEN. Every value below has a default that
 * applies when the file is missing, unreadable, or malformed. A config that must
 * exist would be a new failure mode on a tool whose whole design is to fail open
 * — and it is read on hook paths, so a parse error must degrade to defaults
 * rather than take a session's edit with it.
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
  /** How long a given name is held after its agent was last seen. */
  readonly nameReuseMs: number;
  /** How long a CLOSED work record is kept. Open ones never expire. */
  readonly workKeepMs: number;
  /**
   * How long edit history is kept.
   *
   * DELIBERATELY THE LONGEST, because it is the only thing here that answers a
   * question asked about the past. There is no "off" — an append-only table on a
   * repo with 36 worktrees is how this gets slow, and the honest knob is how
   * long, not whether. Set it to a year if you want a year.
   */
  readonly editKeepMs: number;
}

const DAY = 24 * 60 * 60 * 1000;

export const DEFAULTS: PresenceConfig = {
  staleMs: 90 * 60 * 1000, // 90 min
  claimTtlMs: 2 * 60 * 60 * 1000, // 2 h
  claimReannounceMs: 30 * 60 * 1000, // 30 min
  nameReuseMs: 60 * 60 * 60 * 1000, // 60 h
  workKeepMs: 7 * DAY,
  editKeepMs: 30 * DAY,
};

export function configPath(): string {
  return `${BASE_DIR}/config.json`;
}

/**
 * Reads the config, falling back to a default per FIELD rather than per file.
 *
 * A file that sets one value and misspells another keeps the good one — the
 * alternative is a single typo silently reverting every setting, which is the
 * kind of failure nobody notices for weeks.
 *
 * Values must be finite and positive. A zero or a negative would make a sweep
 * delete everything on its next run, and reading `"7 days"` as `NaN` would make
 * every comparison false and nothing ever expire.
 */
/**
 * Read once per process, so every caller sees the same numbers.
 *
 * Not an optimisation — 0.1 ms against Bun's ~52 ms startup floor. It is a
 * CONSISTENCY guarantee: `STALE_MS` and friends are initialised at module load,
 * while `register` and `pruneStale` call this again later, so an edit to the
 * file between those two points gave one process two different configs. A hook
 * lives for milliseconds, so caching cannot make a change take long to land —
 * the next hook, seconds away, reads the new file.
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
    nameReuseMs: pick("nameReuseMs"),
    workKeepMs: pick("workKeepMs"),
    editKeepMs: pick("editKeepMs"),
  };
}
