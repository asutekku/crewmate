import { loadConfig } from "../config.ts";
import { discipleName, fullName } from "../names.ts";

/**
 * A session with no heartbeat for this long is treated as gone. Terminals close
 * more often than sessions exit cleanly, so SessionEnd cannot be the only way a
 * row disappears or the roster fills with ghosts.
 */
export const STALE_MS = loadConfig().staleMs;

/**
 * How long a claim keeps meaning "I am working on this".
 *
 * A claim is recorded per edit and never released, so without an age limit
 * every file touched today reads as contested and the warning stops meaning
 * anything. Two hours outlasts one edit session and is well short of a day.
 */
export const CLAIM_TTL_MS = loadConfig().claimTtlMs;

/**
 * How long an overlap announcement stays "already said".
 *
 * `pre-edit` fires on EVERY edit, so without this an agent working through a
 * contested file posts the same line until it buries the real conversation.
 */
export const CLAIM_REANNOUNCE_MS = loadConfig().claimReannounceMs;

/**
 * How long a minion with no SubagentStop is still believed to be running.
 *
 * A parent that dies takes its subagents with it and never reports them
 * stopped, so without a bound `who` would show ghosts working forever.
 */
export const MINION_STALE_MS = loadConfig().minionStaleMs;

/** Retention horizon for append-only edit history. */
export const EDIT_KEEP_MS = loadConfig().editKeepMs;

/** Closed minions deliberately share the edit-history retention policy. */
export const MINION_KEEP_MS = EDIT_KEEP_MS;

/** Rows kept in the log; old ones are pruned so the file cannot grow forever. */
export const MAX_MESSAGES = 2000;

/**
 * Who authored the text, which is NOT the same as which agent it came through.
 * `say` and `note` carry human words; the rest are the agent's own.
 *
 * `breaks` is its own kind because it is the one message with a consequence: a
 * peer may have to change code it already wrote. There is deliberately NO kind
 * for a session's prompt. See docs/design-notes.md, "Message kinds".
 */
/**
 * `note` is the OPERATOR speaking; `diary` is an agent filing a finding. The
 * two are deliberately distinct: `note` outranks peer text wherever it renders.
 */
export type MessageKind = "say" | "claim" | "done" | "note" | "breaks" | "diary";

/**
 * THREE NAME FIELDS, resolved by `displayName` as alias, then handle, then
 * name. `name` is Claude Code's `traffic-12`, which moves under a reader;
 * `handle` is issued from a pool; `alias` is chosen. See `rosterName`.
 */
export interface Session {
  readonly sessionId: string;
  readonly name: string;
  readonly handle: string;
  /** What the agent is FOR: "Tooling Master". Shown to peers as well. */
  readonly role: string;
  /**
   * ITS OWN COLUMN, not a write into `name`: `syncAgents` overwrites `name`
   * wholesale on every roster read, so a chosen name there would revert.
   */
  readonly alias: string;
  /** `idle` / `busy` from Claude Code, or "" when it has not been sampled. */
  readonly status: string;
  /** Why the session is stuck, when it is; "" otherwise. Beats `status`. */
  readonly blocked: string;
  readonly worktree: string;
  readonly branch: string;
  /**
   * Commits this checkout trails `baseBranch` by, or **-1 when not measured**.
   * A HINT that may lag, sampled rather than read live; `where` recomputes it.
   */
  readonly behindBase: number;
  readonly baseBranch: string;
  /**
   * The lineage this session took up — a lowercased agent name, or "".
   *
   * A disciple displays as `Vega, Hopper's Disciple`, never as `hopper`: it has
   * the knowledge and not the transcript, so `blame` must not point at it.
   */
  readonly lineageFrom: string;
  readonly intent: string;
  /** OPERATOR-FACING: names a window on the user's screen, never injected. */
  readonly title: string;
  readonly summary: string;
  readonly summaryMs: number;
  readonly lastSeenMs: number;
  /**
   * When this conversation last ENDED a turn; 0 if it never has. Against
   * `lastSeenMs` it separates mid-turn from sat-at-a-prompt. Keyed by session,
   * not handle, because handles are reused. See `agentState`.
   */
  readonly lastTurnMs: number;
  readonly startedMs: number;
}

/**
 * What an agent is CALLED — the single word peers type at `msg`. `alias` is
 * optional in the SIGNATURE only, because `post` and the claim helpers pass a
 * narrower shape; a `Session` always has the field.
 */
export function displayName(s: Pick<Session, "name" | "handle"> & { readonly alias?: string }): string {
  if (s.alias !== undefined && s.alias !== "") return addressableName(s.alias);
  return addressableName(s.handle !== "" ? s.handle : s.name);
}

/** Converts stored identity text into the single-line token accepted by `msg`. */
function addressableName(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

/**
 * What an agent is READ as when it carries a lineage: `Vega, Hopper's Disciple`.
 *
 * SEPARATE FROM `displayName` ON PURPOSE: that one is what a peer TYPES at
 * `msg` and must stay one unquoted word. This is prose for a human.
 */
export function lineageName(
  s: Pick<Session, "name" | "handle" | "lineageFrom"> & { readonly alias?: string },
): string {
  return discipleName(displayName(s), s.lineageFrom);
}

/**
 * Names for the OPERATOR, resolved from whatever the caller has to hand.
 *
 * The lookup is by NAME, built once per command from the live roster, because
 * `log` and `board` hold names FROZEN at write time and cannot resolve a
 * session. Degrades to the name it was given once that agent is gone.
 */
export function operatorNames(sessions: readonly Session[]): (name: string) => string {
  const byName = new Map<string, string>();
  for (const s of sessions) {
    const full = rosterName(s);
    // Every string that could have been frozen for this agent maps to one display.
    for (const key of [s.alias, s.handle, s.name]) {
      if (key !== "") byName.set(key.toLowerCase(), full);
    }
  }
  return (name: string): string => byName.get(name.toLowerCase()) ?? name;
}

export function rosterName(s: Session): string {
  // THE NAME IS WHATEVER PEERS TYPE, so it comes from `displayName` alone.
  // The role-fallback slug is the HANDLE, and only while the handle is still
  // the name: once an alias supersedes it, deriving a role from it prints the
  // name the agent just left. See docs/design-notes.md, "Roster names".
  const slug = s.alias.trim() !== "" ? "" : s.handle;
  // THE LINEAGE JOINS THE NAME, NOT THE ROLE. It is a fact about whose
  // knowledge this agent took up; a role is chosen and changes with the work,
  // so writing one into the other would let `call-you` erase a descent. With a
  // lineage the slug fallback is dropped: the suffix is already saying who this
  // agent is, and deriving a second one from the handle repeats the name.
  const given = lineageName(s);
  if (given !== displayName(s)) return fullName(given, s.role, "");
  return fullName(given, s.role, slug);
}

export interface Message {
  readonly id: number;
  readonly tsMs: number;
  /** Sender's display name at send time — frozen so history stays readable. */
  readonly from: string;
  /** Recipient's display name, or "" for a broadcast. */
  readonly to: string;
  readonly kind: MessageKind;
  readonly body: string;
}

/** One candidate that made it into a block, as the ledger records it. */
export interface InjectionShown {
  readonly key: string;
  readonly dedupeKey: string;
  readonly stateVersion: string;
  readonly form: "full" | "compact";
  readonly priority: number;
  readonly chars: number;
  readonly actionable?: boolean;
}

/**
 * One candidate that did not make the block, for ANY reason.
 *
 * Every omission is recorded; only actionable ones dropped for space are OWED
 * to the inbox. The caller passes them all and the store narrows — a caller
 * that filters first serves the inbox and starves the ledger.
 */
export interface InjectionOmitted {
  readonly key: string;
  readonly dedupeKey: string;
  readonly stateVersion: string;
  readonly text: string;
  /** `duplicate` | `unchanged` | `no room`. */
  readonly reason: string;
  readonly priority: number;
  /** The inbox's filter. */
  readonly actionable: boolean;
}

export type FeatureStage = "availability" | "exposure" | "use";
export type FeatureSurface = "build" | "actionable" | "context" | "help" | "cli" | "api";

/** A row of delivery history. `form` is empty for an omission, `reason` for a selection. */
export interface InjectionLedgerRow {
  /** Shared by every row from one packed block. */
  readonly deliveryId: number;
  readonly tsMs: number;
  readonly key: string;
  readonly dedupeKey: string;
  readonly stateVersion: string;
  readonly outcome: string;
  readonly form: string;
  readonly reason: string;
  readonly priority: number;
  readonly chars: number;
}

export interface Claim {
  /** Who holds it — needed to ADDRESS an overlap notice, not just name one. */
  readonly sessionId: string;
  readonly handle: string;
  /** Resolved by `claimRows` in `displayName`'s order, so the names agree. */
  readonly name: string;
  readonly path: string;
  /** Same tree as yours means a real on-disk collision. */
  readonly worktree: string;
  readonly tsMs: number;
}

/**
 * A subagent, owned by the parent that spawned it.
 *
 * There is no name field: a minion's name is DERIVED from its parent's current
 * name and its sequence number (`minionName`), never frozen. A minion has no
 * identity of its own, so a renamed parent must rename its minions with it.
 */
export interface Minion {
  /** Stable across this subagent's Start and Stop. */
  readonly agentId: string;
  /** The PARENT's conversation uuid. Subagents have no session of their own. */
  readonly sessionId: string;
  /** 1-based, per parent, never reused. */
  readonly seq: number;
  readonly task: string;
  /** `general-purpose`, `Explore`, … */
  readonly agentType: string;
  readonly startedMs: number;
}
