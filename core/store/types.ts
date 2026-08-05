import { loadConfig } from "../config.ts";
import { discipleName, fullName } from "../names.ts";

/**
 * A session with no heartbeat for this long is treated as gone. Sessions die by
 * closing a terminal far more often than by exiting cleanly, so the SessionEnd
 * hook cannot be the only way a row disappears — without a timeout the roster
 * fills with ghosts and stops being worth reading.
 */
export const STALE_MS = loadConfig().staleMs;

/**
 * How long a claim keeps meaning "I am working on this".
 *
 * A claim is recorded per edit and never released, so without an age limit a
 * file touched once at 09:00 is still "held" at 17:00. With several agents in
 * one tree that turns most of the day's files into contested paths, the roster's
 * red channel stops meaning anything, and the one collision that matters is
 * buried among a dozen that do not. Two hours is longer than any single edit
 * session on one file and far shorter than a working day.
 */
export const CLAIM_TTL_MS = loadConfig().claimTtlMs;

/**
 * How long an overlap announcement stays "already said".
 *
 * `pre-edit` fires on EVERY edit, so an agent working through a contested file
 * posted an identical `claim` line each time — six of them in one log view,
 * burying the actual conversation between the two agents who were resolving it.
 * The first announcement is news; the tenth is noise about a fact the log
 * already carries.
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
 *
 * `say` and `note` carry human words; the rest are the agent's own. Collapsing
 * the two would let one session's instructions read as another agent's claim.
 *
 * There is deliberately NO kind for "a session's prompt". Publishing prompts
 * verbatim leaked whatever the user typed — credentials, client names — to every
 * peer, and produced lines like `turing was asked by its user: "go"` that say
 * nothing. A session's task now reaches peers only as its own short `intent`.
 */
/**
 * `breaks` is its own kind rather than a `say`, because it is the one message
 * with a consequence attached: a peer reading it may have to change code it has
 * already written. Rendering it as ordinary chatter is how it gets skimmed.
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
   *
   * It outranks Claude Code's own `traffic-XX` deliberately: that label MOVES —
   * measured, one conversation was relabelled `traffic-a0` -> `traffic-7c` ->
   * `traffic-56` in an afternoon — and a name that changes under a reader is
   * worse than one that never meant anything.
   */
  readonly handle: string;
  /**
   * What the agent is FOR, in words: "Tooling Master", "Keeper of Wet Things".
   * Set by the agent or by the operator, changes freely as the work does.
   *
   * SHOWN TO PEERS TOO, which reverses an earlier call. The worry was that
   * "Terrain Whisperer" reads as a claim of authority a peer might over-weight;
   * the measured cost of withholding it was worse. Agents write "adela is
   * fixing this same bug" in text the operator reads, and with eight windows
   * open a bare given name identifies nobody.
   */
  readonly role: string;
  /**
   * A name the agent chose for itself. Outranks both of the above.
   *
   * ITS OWN COLUMN, not a write into `name`: `syncAgents` overwrites `name`
   * wholesale from `claude agents --json` on every roster read, so a chosen name
   * stored there would survive until the next `who` and then silently revert.
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
   * "" for the ordinary session, which is nobody's successor. A session that
   * inherited displays as `Vega, Hopper's Disciple` and never as `hopper`: it
   * has the knowledge and not the transcript, so naming it for the master would
   * point `blame` and every work row at a conversation that did not do the work.
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
  // the way out rather than shown. Names are validated at both the CLI and
  // `setAlias`, so this only catches rows written before that was true — but a
  // roster that shows an unaddressable name is worse than one that shows a
  // hyphenated version of it, because the peer will try to use it.
  // `alias` is optional in the SIGNATURE only, because `post` and the claim
  // helpers pass a narrower shape that never carried one. A `Session` always
  // has the field.
  if (s.alias !== undefined && s.alias !== "") return addressableName(s.alias);
  // The GIVEN NAME beats Claude Code's `traffic-XX`, which is the reverse of
  // what this did before. That label is not stable — one conversation carried
  // three of them in an afternoon — so preferring it made every peer reference
  // and every frozen log line a moving target.
  return addressableName(s.handle !== "" ? s.handle : s.name);
}

/** Converts stored identity text into the single-line token accepted by `msg`. */
function addressableName(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

/**
 * What an agent is READ as when it carries a lineage: `Vega, Hopper's Disciple`.
 *
 * SEPARATE FROM `displayName` ON PURPOSE, and the split is load-bearing. That
 * one is what a peer TYPES at `msg` and must stay a single unquoted word; this
 * is prose for a human reading eight windows. Collapsing them would either
 * break `msg` or throw the lineage away.
 */
export function lineageName(
  s: Pick<Session, "name" | "handle" | "lineageFrom"> & { readonly alias?: string },
): string {
  return discipleName(displayName(s), s.lineageFrom);
}

/**
 * What the OPERATOR sees: "Luna — Tooling Master".
 *
 * Separate from `displayName` because the two have different audiences and
 * different rules. This is READ-ONLY — `msg` takes the bare name, and a peer
 * that copied this three-word string would be naming an agent that does not
 * exist, because the em-dash and the role are not part of anyone's name.
 */
/**
 * Names for the OPERATOR, resolved from whatever the caller has to hand.
 *
 * WHY THIS EXISTS: `who`, `log`, `board`, `files` and `blame` each had their own
 * idea of what to print, so one agent appeared as "Hopper — Tooling Master",
 * "tooling" and "hopper" in three commands on one screen. Worse, `log` and
 * `board` show names FROZEN at write time, so they cannot resolve a session at
 * all — they hold a string and nothing else.
 *
 * So the lookup is by NAME, built once per command from the live roster, and it
 * degrades to the name it was given. A frozen "terrain-perf" from an hour ago
 * still resolves to "Terrain Whisperer Akari" while that agent is alive, and
 * falls back to "terrain-perf" once it is gone — which is the honest answer.
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
  // THE NAME IS WHATEVER PEERS TYPE, so it comes from `displayName` and from
  // nowhere else. Resolving it here independently is what made one agent read
  // `Tooling — Tooling Master` on the roster while `msg` answered to `hopper`:
  // this function treated `handle` as the name and `alias` as a role-fallback,
  // which is the exact inverse of `displayName`'s precedence. One agent, two
  // names, depending on which function you asked.
  //
  // The role-fallback slug is therefore the HANDLE — a topic slug like
  // `water-dynamic` says what an agent works on, which is what an unset role
  // wants to say. It is never Claude Code's `traffic-a9`; that label is the
  // unstable thing this design moved away from, and using it produced "Traffic
  // A9 Terrain Perf", a role nobody chose.
  return fullName(displayName(s), s.role, s.handle);
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

/** One candidate that did not fit, with the version that was withheld. */
/**
 * One candidate that did not make the block, for ANY reason.
 *
 * Every omission is recorded; only the actionable ones dropped for space are
 * OWED to the inbox. The caller passes them all and the store narrows, because
 * a caller filtering first serves the inbox and silently starves the ledger.
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
   * The claimant's Claude session name (`traffic-07`), or "" before one is
   * known. Carried alongside the handle because a handle is an internal
   * allocation detail: showing `knuth` to someone whose terminals are all
   * called `traffic-NN` forces them to map the two by hand, and the roster
   * already resolves it everywhere else.
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
 * name and its own sequence number (`minionName`), never stored. That is the
 * opposite of how message senders and edit rows work, where the name is frozen
 * at write time — and deliberately so. A frozen sender name keeps a log line
 * readable after its author is gone; a minion has no independent identity to
 * preserve, so if the parent is renamed its minions must be renamed with it, or
 * `who` would show `Tooling's Minion #1` indented under `Hopper`.
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
