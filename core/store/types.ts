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
export type MessageKind = "say" | "claim" | "done" | "note" | "breaks";

export interface Session {
  readonly sessionId: string;
  /**
   * Claude Code's own name for the session (`traffic-12`, `water-sim-f7`), when
   * known. Preferred over `handle` everywhere a human or agent reads a name: it
   * is the label you already see in your terminal, so the roster and your
   * windows agree.
   */
  readonly name: string;
  /**
   * The agent's GIVEN NAME, assigned from a pool at first registration and held
   * for 60 hours after it was last seen. This is what peers type (`msg luna`).
   * It outranks Claude Code's `traffic-XX`, which MOVES under a reader.
   */
  readonly handle: string;
  /**
   * What the agent is FOR, in words: "Tooling Master", "Keeper of Wet Things".
   * Set by the agent or the operator, and SHOWN TO PEERS TOO — with eight
   * windows open a bare given name identifies nobody.
   */
  readonly role: string;
  /**
   * A name the agent chose for itself. Outranks both of the above.
   *
   * ITS OWN COLUMN, not a write into `name`: `syncAgents` overwrites `name`
   * wholesale on every roster read, so a chosen name there would revert.
   */
  readonly alias: string;
  /** `idle` / `busy` from Claude Code, or "" when it has not been sampled. */
  readonly status: string;
  /** Why the session is stuck, when it is; "" otherwise. Beats `status`. */
  readonly blocked: string;
  /** The session's working tree — differs per worktree within one repo. */
  readonly worktree: string;
  readonly branch: string;
  /**
   * Commits this checkout trails `baseBranch` by, or **-1 when not measured**.
   *
   * Sampled at SessionStart and on a cwd change rather than read live, so it is
   * a HINT that may lag: the roster cannot afford a git subprocess per peer.
   * `where` computes the same number fresh, because a direct question deserves
   * a current answer.
   */
  readonly behindBase: number;
  /** What `behindBase` was measured against; "" when it could not be resolved. */
  readonly baseBranch: string;
  /**
   * The lineage this session took up, if any — a lowercased agent name.
   *
   * A session that inherited displays as `Vega, Hopper's Disciple`, never as
   * `hopper`: it has the knowledge and not the transcript, so naming it for the
   * master would point `blame` at a conversation that did not do the work.
   */
  readonly lineageFrom: string;
  readonly intent: string;
  /**
   * Claude Code's conversation name. OPERATOR-FACING: it identifies a window on
   * the user's screen, so it belongs in `who` and never in a peer injection.
   */
  readonly title: string;
  /** A Haiku line describing current work; "" until the first refresh lands. */
  readonly summary: string;
  readonly summaryMs: number;
  readonly lastSeenMs: number;
  /**
   * When this conversation last ENDED a turn; 0 if it never has.
   *
   * Against `lastSeenMs` it separates mid-turn from sat-at-a-prompt. Keyed by
   * session, not by handle: handles are reused, so a session would inherit the
   * turn ends of whoever held its name before it. See `agentState`.
   */
  readonly lastTurnMs: number;
  readonly startedMs: number;
}

/**
 * What an agent is CALLED — the single word peers type at `msg`.
 *
 * Precedence: a name the agent chose, else its given name, else Claude Code's
 * own label. Both of the first two are stable for the life of the conversation;
 * the third is not, which is why it is last.
 */
export function displayName(s: Pick<Session, "name" | "handle"> & { readonly alias?: string }): string {
  // A stored name with a space cannot be typed at `msg`, so it is repaired on
  // the way out. `alias` is optional in the SIGNATURE only, because `post` and
  // the claim helpers pass a narrower shape; a `Session` always has the field.
  if (s.alias !== undefined && s.alias !== "") return addressableName(s.alias);
  // The GIVEN NAME beats Claude Code's `traffic-XX`, which is not stable — one
  // conversation carried three of them in an afternoon.
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
    // Every string that could have been frozen for this agent maps to one
    // display: its chosen name, its given name, and Claude Code's own label.
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
  return fullName(displayName(s), s.role, slug);
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
  /** Whether the agent was expected to act on it — the inbox's filter. */
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
  /** Who holds it — needed to ADDRESS an overlap notice to them, not just name them. */
  readonly sessionId: string;
  readonly handle: string;
  /**
   * The claimant's DISPLAY name, resolved alias -> handle -> `traffic-07` by
   * `claimRows` — the same order as `displayName`, so an overlap warning names
   * the agent the roster names.
   */
  readonly name: string;
  readonly path: string;
  /** The claimant's working tree — same tree means a real on-disk collision. */
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
  /** Claude Code's id for this subagent, stable across its Start and Stop. */
  readonly agentId: string;
  /** The PARENT's conversation uuid. Subagents have no session of their own. */
  readonly sessionId: string;
  /** 1-based, per parent, never reused. */
  readonly seq: number;
  /** What the parent said it was for, when spawning. */
  readonly task: string;
  /** `general-purpose`, `Explore`, … — which kind was spawned. */
  readonly agentType: string;
  readonly startedMs: number;
}
