/**
 * Tunable lifetimes, read from `~/.claude/agent-presence/config.json`.
 *
 * WHY A FILE RATHER THAN MORE CONSTANTS. There are ten separate horizons here —
 * how long a session is alive, a claim means "mine", a name is held, a work
 * record is kept, edit history survives, a subagent is believed to be running, a
 * finding stays, a retired finding stays, and how long an open item can sit
 * before its agent is asked about it. They answer genuinely different questions,
 * and a tenth hardcoded constant is well past where that stays reviewable.
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
  /**
   * How long a minion with no SubagentStop is still believed to be running.
   *
   * MUCH SHORTER than a session's staleness, because the failure it covers is
   * different: a session that goes quiet is usually still there, while a
   * subagent that never reported back has almost always died with its parent.
   * A stuck row reads as "still working" and is worse than forgetting early —
   * the operator acts on what `who` says is happening NOW.
   */
  readonly minionStaleMs: number;
  /**
   * How long a diary entry is kept.
   *
   * LONG, like edit history and for the same reason: it is a record of what was
   * learned, and the question it answers ("has anyone hit this before?") is
   * asked about the past. An entry that expires while the code it describes is
   * still there has failed at its only job.
   */
  readonly diaryKeepMs: number;
  /**
   * How long a DEPRECATED entry is kept after being marked.
   *
   * Shorter than the above but not zero: "this was believed and here is why it
   * stopped being true" is usually worth more than the original claim, so it
   * outlives the claim rather than dying with it.
   */
  readonly diaryDeprecatedKeepMs: number;
  /**
   * How long an open work item can sit untouched before its agent is asked
   * whether it is still real.
   *
   * An hour, because that is roughly the span over which "I am still on this"
   * stops being obviously true. Shorter and the nudge interrupts work that is
   * genuinely in progress; much longer and the board spends most of a working
   * day advertising items nobody is doing.
   */
  readonly workStaleMs: number;
  /**
   * What session-start CANDIDATES are allocated against, in characters.
   *
   * NOT a hard ceiling on the block. The mandatory header (identity, and the
   * staleness warning that changes how everything below it reads) is subtracted
   * before candidates are ranked and renders even when it alone exceeds this;
   * the "N actionable items omitted" line sits outside it too. It is the figure
   * discretionary content competes for, and nothing else.
   *
   * Measured 2026-08-02 against the live hook: 3,772 chars with a full roster
   * (identity 338, roster 370, recent activity 892, the three standing
   * instructions 1,459, trust note 300, diary 413) and 2,288 alone. 6,000 is
   * roughly 1.6x the busiest real block — enough that nothing in the tool today
   * is ever dropped, while a future feature that tries to add 3,000 chars of
   * its own hits a wall instead of silently burying the identity text that
   * measurably changes how a session answers "who are you".
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
  nameReuseMs: 60 * 60 * 60 * 1000, // 60 h
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
    minionStaleMs: pick("minionStaleMs"),
    diaryKeepMs: pick("diaryKeepMs"),
    diaryDeprecatedKeepMs: pick("diaryDeprecatedKeepMs"),
    workStaleMs: pick("workStaleMs"),
    injectionTargetChars: pick("injectionTargetChars"),
    injectionKeepMs: pick("injectionKeepMs"),
  };
}
