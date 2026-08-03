/**
 * Shared state for the agent-presence hooks: who is working in this repo, what
 * they said they are doing, and a message log each session reads once.
 *
 * WHY SQLITE AND NOT A MARKDOWN FILE: 3-4 agents run concurrently here, and a
 * read-modify-write of one `.md` is a lost-update race — two sessions read the
 * same text and the second write erases the first's line. That is precisely the
 * failure this is meant to prevent, so the store has to serialise writes itself.
 * `bun:sqlite` ships with Bun (no dependency to add) and WAL mode lets every
 * reader proceed while one writer commits, so a hook never blocks on a peer.
 *
 * THE CURSOR IS THE DELIVERY MODEL: `messages.id` is monotonic and each session
 * stores the last id it has been shown. "Unread" is `id > last_read_id`, so
 * delivery is a range read followed by advancing one integer. No per-recipient
 * fan-out, no acknowledgements, and a session that never reads simply has a
 * stale cursor rather than a growing queue of its own.
 *
 * ADVISORY ONLY: nothing here can stop another agent from editing a file. A
 * claim is a published intention, which is what makes an overlap *visible*;
 * enforcement would mean blocking a tool call, and a wedged agent is worse than
 * a conflict someone can see and talk about.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { ensureBaseDir } from "./repo.ts";
import { createWorkTables, WorkStore } from "./work.ts";
import { createDiaryTables, DiaryStore } from "./diary.ts";
import { createQuestionTables, QuestionStore } from "./questions.ts";
import { createObligationTables, ObligationStore } from "./obligations.ts";
import { collectStats } from "./stats.ts";
import type { Stats } from "./stats.ts";
import { discipleName, fullName, GIVEN_NAMES, pickName } from "./names.ts";
import { loadConfig } from "./config.ts";
import { featureForCandidate, isFeatureId, type FeatureId } from "./features.ts";

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

/** How long a CLOSED minion row is kept, matching the rest of the edit history. */
const MINION_KEEP_MS = loadConfig().editKeepMs;

/** Rows kept in the log; old ones are pruned so the file cannot grow forever. */
const MAX_MESSAGES = 2000;

/**
 * The pool an agent's given name is drawn from — see `core/names.ts`.
 *
 * Re-exported here because this is where callers already look for it, and
 * because `colour.ts` colours an agent by its index in this list. ORDER IS
 * THEREFORE LOAD-BEARING: reordering it reshuffles every agent's colour.
 */
export const HANDLES = GIVEN_NAMES;

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
  const hyphenate = (v: string): string => (v.includes(" ") ? v.replace(/\s+/g, "-") : v);
  // `alias` is optional in the SIGNATURE only, because `post` and the claim
  // helpers pass a narrower shape that never carried one. A `Session` always
  // has the field.
  if (s.alias !== undefined && s.alias !== "") return hyphenate(s.alias);
  // The GIVEN NAME beats Claude Code's `traffic-XX`, which is the reverse of
  // what this did before. That label is not stable — one conversation carried
  // three of them in an afternoon — so preferring it made every peer reference
  // and every frozen log line a moving target.
  return hyphenate(s.handle !== "" ? s.handle : s.name);
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

/**
 * Answers "is there anything at all for this session?" without opening the
 * write path or building any objects.
 *
 * WHY THIS EXISTS: `PostToolBatch` fires after every batch of tool calls — many
 * times per turn — and the honest answer is almost always "nothing new". Doing
 * the full open-drain-format round trip there would tax every batch to deliver
 * a message that arrives a few times an hour. This is a read-only open and one
 * indexed MAX(), so the common case costs a query rather than a transaction.
 *
 * Returns false when the db does not exist yet, which is the very first hook of
 * the very first session.
 */
export function hasUnread(dbPath: string, sessionId: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query(
          `SELECT EXISTS(
             SELECT 1 FROM messages m
               JOIN sessions s ON s.session_id = ?1
              WHERE m.id > s.last_read_id
                AND m.handle != s.handle
                AND (m.to_session = '' OR m.to_session = ?1)
           ) AS any_unread`,
        )
        .get(sessionId) as { any_unread: number } | null;
      return (row?.any_unread ?? 0) === 1;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function openDb(dbPath: string): Database {
  ensureBaseDir();
  const db = new Database(dbPath, { create: true });
  // busy_timeout FIRST: without it a concurrent writer throws SQLITE_BUSY
  // instead of waiting, and the `journal_mode` switch below is itself a
  // statement that can block on a fresh db another process is opening. Setting
  // the timeout second would leave that one pragma unprotected.
  db.exec("PRAGMA busy_timeout = 5000");
  // WAL survives across connections once set, but setting it every open is
  // cheap and means a deleted db file comes back correctly configured.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id   TEXT PRIMARY KEY,
      handle       TEXT NOT NULL,
      name         TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT '',
      -- Why a session is stuck, when it is: "waiting for permission", "turn
      -- failed: rate_limit". Distinct from the status column, which a
      -- "claude agents --json" sample overwrites wholesale.
      blocked      TEXT NOT NULL DEFAULT '',
      worktree     TEXT NOT NULL,
      branch       TEXT NOT NULL DEFAULT '',
      intent       TEXT NOT NULL DEFAULT '',
      last_seen_ms INTEGER NOT NULL,
      started_ms   INTEGER NOT NULL,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      -- The build of the hook scripts this session LOADED. A session keeps the
      -- copy it started with until it restarts, so this is what tells a reader
      -- that a peer's behaviour is a version behind rather than broken.
      code_version TEXT NOT NULL DEFAULT '',
      -- Claude Code's own conversation name ("Explore cheap agent communication
      -- solutions"), read from the transcript. OPERATOR-FACING ONLY: it names a
      -- window on the user's screen, which is what makes it useful to them and
      -- useless to a peer agent, so it is never injected into a peer's context.
      title        TEXT NOT NULL DEFAULT '',
      -- A Haiku-written line describing current work. Refreshed on a timer from
      -- the transcript, not on any hook path — see core/summary.ts.
      summary      TEXT NOT NULL DEFAULT '',
      summary_ms   INTEGER NOT NULL DEFAULT 0,
      -- Where this session's transcript lives, so a refresh can read it without
      -- reconstructing a path from the session id.
      transcript   TEXT NOT NULL DEFAULT ''
    );
    -- Two agents answering to one name makes the whole roster a lie, so the
    -- constraint is enforced by the schema rather than trusted from the code.
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_handle ON sessions (handle);
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms     INTEGER NOT NULL,
      handle    TEXT NOT NULL,
      kind      TEXT NOT NULL,
      body      TEXT NOT NULL,
      -- Empty means broadcast. A session id here means ONLY that session is
      -- shown the row (see drainUnread). Delivery scoping, not secrecy: every
      -- agent can read this file directly.
      to_session TEXT NOT NULL DEFAULT '',
      -- Display names FROZEN at send time. Resolving them at read time would
      -- blank out every historical line once a session exits, and the log's job
      -- is to still make sense afterwards.
      from_name  TEXT NOT NULL DEFAULT '',
      to_name    TEXT NOT NULL DEFAULT ''
    );
    -- Claude Code's own task list is PER-SESSION (verified: ~/.claude/tasks/ is
    -- one directory per session id), so peers cannot see each other's. Mirroring
    -- it here is the only way a shared board exists.
    CREATE TABLE IF NOT EXISTS tasks (
      session_id   TEXT NOT NULL,
      task_id      TEXT NOT NULL,
      subject      TEXT NOT NULL,
      created_ms   INTEGER NOT NULL,
      completed_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS claims (
      path       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ts_ms      INTEGER NOT NULL,
      PRIMARY KEY (path, session_id)
    );
    -- WHAT THIS SESSION HAS ALREADY BEEN SHOWN, so the same unchanged block is
    -- not injected again at the next SessionStart (resume, /clear, compact).
    -- Keyed on the CONTENT fingerprint rather than a timestamp: "has this
    -- changed since you last saw it" is a content question, and the clock
    -- answers a different one -- which is how a claim re-announced on every
    -- edit put six identical lines in one log view.
    CREATE TABLE IF NOT EXISTS injection_exposures (
      session_id  TEXT NOT NULL,
      dedupe_key  TEXT NOT NULL,
      state_ver   TEXT NOT NULL,
      ts_ms       INTEGER NOT NULL,
      PRIMARY KEY (session_id, dedupe_key)
    );
    -- THE LEDGER: what each block actually contained, kept per delivery.
    --
    -- Distinct from injection_exposures, which is live SUPPRESSION STATE --
    -- one latest-version row per key, replaced on every pack and dropped when
    -- the context is wiped. That answers "should I say this again?" and cannot
    -- answer "what was this agent shown an hour ago?", because the row that
    -- would have said so is gone. Conflating the two is why the injection
    -- command could only ever recompute a hypothetical block from current state.
    --
    -- CANDIDATE METADATA, NOT THE BLOCK ITSELF. It records which candidates a
    -- delivery contained, at what version, in which form, at what rank, and why
    -- each omission was dropped. It does NOT store the selected text, the
    -- mandatory header, the framing or the budget figures — so it answers "was
    -- this agent told about the roster, and in full or compacted?" and cannot
    -- reproduce the literal string that was injected. Storing the prose would
    -- duplicate most of the block on every SessionStart for a question nobody
    -- has yet needed to ask.
    --
    -- APPEND-ONLY, bounded by pruneInjectionState like the rest.
    CREATE TABLE IF NOT EXISTS injection_ledger (
      session_id  TEXT NOT NULL,
      -- One packed block, one id. Grouping by timestamp alone merges two hook
      -- runs that land in the same millisecond into a delivery that never
      -- happened.
      delivery_id INTEGER NOT NULL DEFAULT 0,
      ts_ms       INTEGER NOT NULL,
      key         TEXT NOT NULL,
      dedupe_key  TEXT NOT NULL,
      state_ver   TEXT NOT NULL,
      outcome     TEXT NOT NULL,   -- 'selected' | 'omitted'
      form        TEXT NOT NULL,   -- 'full' | 'compact' | '' when omitted
      reason      TEXT NOT NULL,   -- omission reason; '' when selected
      priority    INTEGER NOT NULL,
      chars       INTEGER NOT NULL
    );
    -- Its index is created with the MIGRATIONS, not here: delivery_id was
    -- added to this table after it shipped, so on an existing db the CREATE
    -- above is a no-op and an index over that column cannot be built until
    -- addColumnIfMissing has run.
    -- WHAT DID NOT FIT, so the inbox command can hand it over on request.
    -- The block promises "N actionable item(s) omitted", and a promise pointing
    -- at nothing is worse than no promise: the agent is told work exists and
    -- then cannot reach it. The full text is stored rather than a reference,
    -- because the candidate that produced it is gone by then.
    CREATE TABLE IF NOT EXISTS injection_omissions (
      session_id  TEXT NOT NULL,
      key         TEXT NOT NULL,
      text        TEXT NOT NULL,
      reason      TEXT NOT NULL,
      -- WHICH VERSION was withheld. Without it, a key whose content moves
      -- between packs leaves an inbox entry that cannot say which one the agent
      -- never saw -- and the whole point of the row is to hand back the thing
      -- that was missed, not a thing with the same name.
      state_ver   TEXT NOT NULL DEFAULT '',
      ts_ms       INTEGER NOT NULL,
      PRIMARY KEY (session_id, key)
    );
    -- P3 raw observations. Availability, exposure and use are separate events;
    -- opportunity_id supplies the session-level denominator so repeated hooks
    -- in one conversation never masquerade as independent opportunities.
    CREATE TABLE IF NOT EXISTS feature_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      feature TEXT NOT NULL,
      stage TEXT NOT NULL,
      surface TEXT NOT NULL,
      opportunity_id TEXT NOT NULL,
      source_key TEXT NOT NULL DEFAULT '',
      delivery_id INTEGER NOT NULL DEFAULT 0,
      ts_ms INTEGER NOT NULL,
      code_version TEXT NOT NULL DEFAULT '',
      feature_set_version INTEGER NOT NULL DEFAULT 0,
      CHECK(stage IN ('availability','exposure','use')),
      CHECK(surface IN ('build','actionable','context','help','cli','api'))
    );
    CREATE INDEX IF NOT EXISTS feature_events_feature
      ON feature_events(feature, stage, session_id);
    -- APPEND-ONLY history of who touched what. Distinct from the claims table,
    -- which is live state and is DELETED with its session: 95 commits landed in
    -- this repo in one day, every one authored by the same person, so git can
    -- say which line changed but never which agent changed it. This is the only
    -- table that can, and it is worthless if it is lossy -- hence its own table
    -- rather than a longer TTL on claims.
    --
    -- Attribution is FROZEN at write time, exactly as message sender names are:
    -- resolving an agent later would blank out every historical row the moment
    -- that session exits, which is precisely when blame is asked for.
    CREATE TABLE IF NOT EXISTS edits (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms      INTEGER NOT NULL,
      path       TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent      TEXT NOT NULL DEFAULT '',
      worktree   TEXT NOT NULL DEFAULT '',
      branch     TEXT NOT NULL DEFAULT '',
      -- Edit / Write / NotebookEdit. A Write is a whole-file replacement and a
      -- far bigger deal than an Edit, so the two are worth telling apart.
      tool       TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS edits_path ON edits (path, id);
    CREATE INDEX IF NOT EXISTS edits_agent ON edits (session_id, id);
    -- Names remembered past the roster row that held them. A session id is the
    -- CONVERSATION uuid (the transcript's filename, and what "claude --resume"
    -- takes), so it is the same after a restart -- but SessionEnd deletes the
    -- row on a clean exit, taking the name with it.
    -- Survives the stale sweep on purpose: it is a preference, not liveness.
    CREATE TABLE IF NOT EXISTS aliases (
      session_id TEXT PRIMARY KEY,
      alias      TEXT NOT NULL,
      -- When the name was last in use. Without it the reservation was
      -- UNBOUNDED: a name remembered here was held against the pool forever,
      -- which is the same failure the 60 h hold exists to prevent, from the
      -- other direction.
      ts_ms      INTEGER NOT NULL DEFAULT 0
    );
    -- Subagents. NOT roster rows, and the distinction is the whole design: a
    -- minion never registers, never takes a name from the pool, and cannot be
    -- addressed -- only its parent can spawn or reach one, so msg resolving a
    -- minion name would promise a delivery nothing can make.
    --
    -- Everything a minion DOES is already the parent's: its tool calls carry the
    -- parent's session_id (measured 2026-08-01 by probing both events), so
    -- claims, edits and blame attribute upward with no special handling. This
    -- table exists only so the operator can SEE what a parent has running --
    -- "eight agents on the roster" was hiding twelve more doing the work.
    --
    -- seq increments per parent and is never reused, so a minion number is a
    -- durable reference in a log line after that minion is gone. They are
    -- disposable; their numbers are not.
    CREATE TABLE IF NOT EXISTS minions (
      agent_id   TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      -- The string the PARENT passed when spawning. Free and already written --
      -- no model call, no new convention for an agent to remember.
      task       TEXT NOT NULL DEFAULT '',
      agent_type TEXT NOT NULL DEFAULT '',
      started_ms INTEGER NOT NULL,
      -- 0 while alive. A closed row is kept: it is history, like edits.
      ended_ms   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS minions_parent ON minions (session_id, ended_ms);
  `);
  createWorkTables(db);
  createDiaryTables(db);
  createQuestionTables(db);
  createObligationTables(db);
  // `CREATE TABLE IF NOT EXISTS` leaves an EXISTING table alone, so a column
  // added later never reaches a db that is already live — and this db is live
  // state that several running sessions are writing to, not a save file that
  // can be dropped and regenerated (which is what the repo's pre-release
  // "no migrations" rule is about).
  addColumnIfMissing(db, "sessions", "code_version", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "sessions", "title", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "sessions", "summary", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "sessions", "summary_ms", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "sessions", "transcript", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "sessions", "alias", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "sessions", "role", "TEXT NOT NULL DEFAULT ''");
  // How far this session's checkout trails its base branch, cached so the roster
  // can show it without spawning git ONCE PER PEER on the per-turn path -- the
  // exact shape `worktreeRoot` was cached to avoid (pre-edit 157 ms -> 106 ms).
  // -1 is "not measured", which must stay distinct from 0: zero means in sync,
  // and an unmeasured checkout reading as in-sync is the one wrong answer here.
  addColumnIfMissing(db, "sessions", "behind_base", "INTEGER NOT NULL DEFAULT -1");
  addColumnIfMissing(db, "sessions", "base_branch", "TEXT NOT NULL DEFAULT ''");
  // Whose body of knowledge this session took up; "" for the ordinary agent
  // that is nobody's successor. Displayed as "Vega, Hopper's Disciple" -- see
  // `displayName` for why a successor never simply reads as the master.
  addColumnIfMissing(db, "sessions", "lineage_from", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "aliases", "ts_ms", "INTEGER NOT NULL DEFAULT 0");
  // A `DEFAULT ''` in the CREATE reaches fresh dbs only; the live ones that
  // already have this table need the column added. Empty means "recorded before
  // versions were kept", which a reader must be able to tell from a real one.
  addColumnIfMissing(db, "injection_omissions", "state_ver", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "feature_events", "delivery_id", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "feature_events", "feature_set_version", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "injection_ledger", "delivery_id", "INTEGER NOT NULL DEFAULT 0");
  // AFTER the column it indexes, and deliberately not up with the CREATEs.
  // `CREATE TABLE IF NOT EXISTS` is a no-op on a db that already has this
  // table, so an index over a migration-added column placed with the schema
  // throws `no such column` — and it throws BEFORE the migration that would
  // have added it, so the db can never open again. Reproduced against an
  // old-shape db 2026-08-02; `test/store-migrate.test.ts` pins it.
  db.query(
    `CREATE INDEX IF NOT EXISTS injection_ledger_session
       ON injection_ledger (session_id, delivery_id DESC)`,
  ).run();
  // Live dbs predate this; without it every existing board read fails on a
  // column the queries now select.
  addColumnIfMissing(db, "work", "auto", "INTEGER NOT NULL DEFAULT 0");
  // The plan document this item is executing, repo-relative and forward-slashed.
  // Empty for the ordinary item that is not working from a plan, which is most
  // of them -- a required link would be a field agents fill in with noise.
  addColumnIfMissing(db, "work", "plan_doc", "TEXT NOT NULL DEFAULT ''");
  // Which entry records the fix. Only meaningful on kind='error' -- a finding
  // is a fact and has no open state, so giving one a "fixed" marker invites an
  // agent to close a piece of knowledge.
  addColumnIfMissing(db, "diary", "fixed_by", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "diary", "fixed_ms", "INTEGER NOT NULL DEFAULT 0");
  // AFTER the column exists, never inside `createWorkTables`. `CREATE TABLE IF
  // NOT EXISTS` leaves an existing table alone, so on a live db the table is
  // untouched and a `plan_doc` index declared beside it runs against a column
  // that is not there yet -- "no such column: plan_doc", on every hook and
  // every CLI call. Fresh-db tests cannot see this: they build the table WITH
  // the column, so the index resolves and the migration is a no-op.
  db.exec(`CREATE INDEX IF NOT EXISTS work_plan ON work (plan_doc) WHERE plan_doc != ''`);
  return db;
}

/** Idempotent, and silent when the column is already there. */
function addColumnIfMissing(db: Database, table: string, column: string, decl: string): void {
  try {
    const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch {
    // A db we cannot alter is one we can still read; the column simply reads
    // as absent and the roster omits the version.
  }
}

/**
 * Every hook is a short-lived process, so there is no long-lived connection to
 * manage: open, do one unit of work, close. `using` guarantees the close even
 * when a caller throws, which matters because a leaked WAL handle keeps the
 * -wal file from checkpointing.
 */
export function withStore<T>(dbPath: string, fn: (s: Store) => T): T {
  const db = openDb(dbPath);
  try {
    return fn(new Store(db));
  } finally {
    db.close();
  }
}

/** The column list every Session query selects, so the two cannot drift apart. */
const SESSION_COLUMNS = `session_id, handle, name, alias, role, status, blocked, worktree, branch,
                         behind_base, base_branch, lineage_from, intent, title, summary,
                         summary_ms, last_seen_ms, started_ms`;

function rowToSession(r: Record<string, string | number>): Session {
  return {
    sessionId: String(r["session_id"]),
    handle: String(r["handle"]),
    name: String(r["name"] ?? ""),
    alias: String(r["alias"] ?? ""),
    role: String(r["role"] ?? ""),
    status: String(r["status"] ?? ""),
    blocked: String(r["blocked"] ?? ""),
    worktree: String(r["worktree"]),
    branch: String(r["branch"]),
    // `?? -1`, not `?? 0`: an unmeasured checkout must not read as in sync.
    behindBase: Number(r["behind_base"] ?? -1),
    baseBranch: String(r["base_branch"] ?? ""),
    lineageFrom: String(r["lineage_from"] ?? ""),
    intent: String(r["intent"]),
    title: String(r["title"] ?? ""),
    summary: String(r["summary"] ?? ""),
    summaryMs: Number(r["summary_ms"] ?? 0),
    lastSeenMs: Number(r["last_seen_ms"]),
    startedMs: Number(r["started_ms"]),
  };
}

export class Store {
  constructor(private readonly db: Database) {}

  /**
   * The work-record tables, sharing this connection.
   *
   * A separate class rather than more methods here, because work records are a
   * timeline with their own lifetime rule (`WORK_KEEP_MS`, deliberately outliving
   * the `STALE_MS` sweep) and folding them into the roster's store would put two
   * different notions of "expired" in one file.
   */
  get work(): WorkStore {
    return new WorkStore(this.db);
  }

  /** Explicit acts and append-only obligation state (COURT_PLAN P2). */
  get obligations(): ObligationStore {
    return new ObligationStore(this.db, (input) => this.recordFeatureEvent(input));
  }

  /**
   * The diary tables, sharing this connection.
   *
   * Separate for the same reason `work` is, and more so: the diary keeps
   * entries for a YEAR where the roster forgets a session in 90 minutes, and
   * one file holding both notions of "expired" is how a sweep eats the thing it
   * was not meant to touch.
   */
  get diary(): DiaryStore {
    return new DiaryStore(this.db);
  }

  /** Questions between agents, sharing this connection. */
  get questions(): QuestionStore {
    return new QuestionStore(this.db);
  }

  /**
   * Everything `cli.ts stats` reports, over this connection.
   *
   * A FUNCTION TAKING THE HANDLE, not more methods here, and not a class. The
   * aggregates cut ACROSS every table this file owns — the row counts are
   * discovered from `sqlite_master` rather than named, and the concurrency
   * histogram is a query no other caller wants. Folding them in would put a
   * dozen one-caller reporting queries beside the roster's own, and none of
   * them can be tested without going through the whole Store.
   */
  stats(memories: number, topAgents?: number): Stats {
    return collectStats(this.db, memories, topAgents);
  }

  /** Sessions seen recently enough to be plausibly alive, oldest first. */
  liveSessions(nowMs: number): Session[] {
    const rows = this.db
      .query(
        `SELECT ${SESSION_COLUMNS}
           FROM sessions WHERE last_seen_ms > ? ORDER BY started_ms ASC`,
      )
      .all(nowMs - STALE_MS) as Array<Record<string, string | number>>;
    return rows.map(rowToSession);
  }

  /**
   * Registers a session, or refreshes it if the id is already known (a resumed
   * session keeps its handle, so peers' references to it stay valid).
   *
   * Handle choice deliberately considers only LIVE sessions: reusing the handle
   * of an agent that died hours ago is what keeps a 4-agent setup on the first
   * four names instead of drifting down the list every restart.
   *
   * PICKING A HANDLE IS A READ THEN A WRITE, so it must be one transaction.
   * Sessions start together — four terminals launched at once, or a `claude`
   * command per pane — and WAL gives durability, not mutual exclusion: four
   * processes can each read the roster before any of them inserts, and all four
   * then pick the same "first free" name. Measured: 4 simultaneous starts in one
   * tree produced TWO agents called `hopper`. BEGIN IMMEDIATE takes the write
   * lock up front so the read and the insert cannot interleave, and the UNIQUE
   * index makes a duplicate impossible rather than merely unlikely.
   */
  register(sessionId: string, worktree: string, branch: string, nowMs: number): string {
    const claim = this.db.transaction((): string => {
      const existing = this.db
        .query(`SELECT handle FROM sessions WHERE session_id = ?`)
        .get(sessionId) as { handle: string } | null;
      if (existing) {
        this.db
          .query(
            `UPDATE sessions SET last_seen_ms = ?, worktree = ?, branch = ? WHERE session_id = ?`,
          )
          .run(nowMs, worktree, branch, sessionId);
        return existing.handle;
      }

      // A name is held for far longer than a session lives, and FOUR sources are
      // needed to make that true. The fourth — `edits` — is the one that
      // actually holds, and it was missing: an agent that edited files and left
      // lost its reservation immediately, because `sessions` deletes its row on
      // exit, `aliases` is empty unless a name was chosen by hand, and
      // `messages` self-prunes at MAX_MESSAGES, which on a busy day evicts a
      // name within hours rather than the 60 the comment promised.
      //
      // The consequence was not cosmetic. A fresh conversation took a departed
      // agent's name, and `operatorNames` then mapped that agent's frozen log
      // lines onto the LIVE holder — so `files adela` listed a stranger's files
      // under the name an overlap warning had just given you, and `msg adela`
      // reached somebody else. `edits` is append-only and pruned on its own
      // 30-day clock, so it is the only source that survives the hold.
      const taken = new Set<string>();
      const heldSince = nowMs - loadConfig().nameReuseMs;
      for (const r of this.db.query(`SELECT handle FROM sessions`).all() as Array<{
        handle: string;
      }>) {
        taken.add(r.handle);
      }
      for (const r of this.db
        .query(`SELECT alias FROM aliases WHERE ts_ms > ?`)
        .all(heldSince) as Array<{ alias: string }>) {
        if (r.alias !== "") taken.add(r.alias.toLowerCase());
      }
      for (const r of this.db
        .query(`SELECT DISTINCT agent FROM edits WHERE ts_ms > ? AND agent != ''`)
        .all(heldSince) as Array<{ agent: string }>) {
        taken.add(r.agent.toLowerCase());
      }
      for (const r of this.db
        .query(`SELECT handle FROM messages WHERE ts_ms > ?`)
        .all(heldSince) as Array<{ handle: string }>) {
        taken.add(r.handle);
      }
      // A CONVERSATION COMING BACK KEEPS ITS NAME. `SessionEnd` deletes the row
      // on a clean exit, so `--continue` and a relaunch arrive here as if new —
      // and handing out a fresh name is exactly the moving label the given name
      // exists to replace. Observed live: `adela` returned as `akira` mid-work.
      //
      // Taken by another LIVE session wins over the reservation: two agents on
      // one name makes every `msg` to it ambiguous, and the newcomer having a
      // prior claim to it does not change that.
      // Bounded by the SAME hold as everything else: a conversation resumed
      // within `nameReuseMs` keeps its name, one resumed next week takes a
      // fresh one. Unbounded, a name could never return to the pool, which is
      // the failure the hold exists to prevent from the other direction.
      const remembered = this.db
        .query(`SELECT alias FROM aliases WHERE session_id = ?`)
        .get(sessionId) as { alias: string } | null;
      const mine = taken.has((remembered?.alias ?? "").toLowerCase()) ? remembered!.alias : "";
      const stillFree =
        mine !== "" &&
        (this.db
          .query(
            `SELECT 1 AS hit FROM sessions WHERE LOWER(handle) = LOWER(?) OR LOWER(alias) = LOWER(?)`,
          )
          .get(mine, mine) as { hit: number } | null) === null;
      const handle = stillFree ? mine : pickName(taken);
      this.db
        .query(
          `INSERT INTO sessions
             (session_id, handle, worktree, branch, intent, last_seen_ms, started_ms, last_read_id)
           VALUES (?, ?, ?, ?, '', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
        )
        .run(sessionId, handle, worktree, branch, nowMs, nowMs);
      return handle;
    });
    // IMMEDIATE, not DEFERRED: a deferred transaction still starts read-only and
    // upgrades at the INSERT, which is exactly the window this must close.
    return claim.immediate();
  }

  /**
   * A new session's cursor starts at the current max id, so it is not shown a
   * backlog of chatter that predates it — `register` does this inline above.
   * Recent history is surfaced separately by `recent()`, which is a deliberate
   * one-off summary rather than unread mail.
   */
  /**
   * Heartbeat. Also clears `blocked`: a session doing something is by definition
   * no longer waiting on the permission prompt or dead from the API error that
   * set it, and a stale "stuck" label is worse than none.
   */
  touch(sessionId: string, nowMs: number): void {
    this.db
      .query(`UPDATE sessions SET last_seen_ms = ?, blocked = '' WHERE session_id = ?`)
      .run(nowMs, sessionId);
  }

  handleFor(sessionId: string): string | null {
    const row = this.db
      .query(`SELECT handle FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { handle: string } | null;
    return row ? row.handle : null;
  }

  /**
   * The handle for a session, registering it if the row is gone.
   *
   * A HOOK FIRING IS PROOF THE SESSION IS ALIVE, whatever `pruneStale` decided.
   * Reaping is a heuristic for sessions that died by having their terminal
   * closed, and it misfires on two ordinary cases: a session idle at a prompt
   * for 90 minutes, and a single long turn that runs no Edit/Write (the
   * `PostToolBatch` fast path deliberately skips `touch` when there is no mail,
   * so such a turn heartbeats once at its start).
   *
   * Before this existed, a pruned session was permanently invisible: every hook
   * did `handleFor → null → return`, so it recorded no claims, RAISED NO
   * OVERLAP WARNINGS, and received no messages — silently, because the hooks
   * fail open. It failed back into exactly the blindness the tool exists to end,
   * and it did so for the longest-running sessions, which are the ones with the
   * most work at stake.
   */
  /**
   * Registers, then puts back any name this conversation chose before.
   *
   * On `register` rather than on the first prompt, so a returning agent is
   * already under its known name in the roster a peer reads at session start —
   * a name that appears one turn late has already misidentified it once.
   */
  registerAndRestore(sessionId: string, worktree: string, branch: string, nowMs: number): string {
    const handle = this.register(sessionId, worktree, branch, nowMs);
    this.restoreAlias(sessionId, nowMs);
    return handle;
  }

  handleForOrRegister(sessionId: string, worktree: string, branch: string, nowMs: number): string {
    return this.handleFor(sessionId) ?? this.register(sessionId, worktree, branch, nowMs);
  }

  /**
   * Corrects the recorded working tree.
   *
   * Separate from `register` because it must NOT touch the handle or the read
   * cursor: this runs on a hot-ish path (every edit) purely to keep the tree
   * honest, and re-registering there would be a much bigger hammer.
   */
  setWorktree(sessionId: string, worktree: string, branch: string): void {
    this.db
      .query(`UPDATE sessions SET worktree = ?, branch = ? WHERE session_id = ?`)
      .run(worktree, branch, sessionId);
  }

  /**
   * Stamps the build this session is running. Kept off the `Session` type on
   * purpose: only the CLI's roster asks, so threading it through every reader
   * would cost more than the one query it saves.
   */
  /**
   * Cache this checkout's drift for the roster to read.
   *
   * Written by the hooks that already spawn git — SessionStart and CwdChanged —
   * so the roster pays nothing. Pass -1 for "could not measure"; storing 0 there
   * would tell every peer the checkout is current when nobody has checked.
   */
  setBaseDistance(sessionId: string, behind: number, base: string): void {
    this.db
      .query(`UPDATE sessions SET behind_base = ?, base_branch = ? WHERE session_id = ?`)
      .run(behind, base, sessionId);
  }

  /**
   * Take up a lineage, or drop one by passing "".
   *
   * Records only the CLAIM. Whether the lineage is free is `liveHolder`'s
   * question, asked by the caller, because the answer differs by verb: `inherit`
   * refuses a live one, a shadow deliberately allows it.
   */
  setLineage(sessionId: string, from: string): void {
    this.db
      .query(`UPDATE sessions SET lineage_from = ? WHERE session_id = ?`)
      .run(from.trim().toLowerCase(), sessionId);
  }

  /**
   * The live session currently answering to a lineage name, if any.
   *
   * WHY IT MATTERS: adopting a lineage whose original is still working is a
   * FORK, not a succession -- two sessions writing one body of knowledge makes
   * it a composite of two agents' beliefs with no way to tell them apart. A
   * session is matched on its own name or on a lineage it has already taken up,
   * so a disciple's disciple cannot quietly start a third writer.
   */
  liveHolder(lineage: string, nowMs: number): Session | null {
    const key = lineage.trim().toLowerCase();
    if (key === "") return null;
    const r = this.db
      .query(
        `SELECT ${SESSION_COLUMNS} FROM sessions
          WHERE last_seen_ms > ?
            AND (LOWER(handle) = ? OR LOWER(alias) = ? OR LOWER(lineage_from) = ?)
          ORDER BY last_seen_ms DESC LIMIT 1`,
      )
      .get(nowMs - STALE_MS, key, key, key) as Record<string, string | number> | null;
    return r ? rowToSession(r) : null;
  }

  setCodeVersion(sessionId: string, version: string, features: readonly string[] = [], nowMs = Date.now(), featureSetVersion = 0): void {
    this.db
      .query(`UPDATE sessions SET code_version = ? WHERE session_id = ?`)
      .run(version, sessionId);
    for (const feature of features) {
      if (!isFeatureId(feature)) continue;
      this.recordFeatureEvent({ sessionId, feature, stage: "availability", surface: "build", opportunityId: sessionId, sourceKey: version, nowMs, codeVersion: version, featureSetVersion });
    }
  }

  recordFeatureEvent(input: { sessionId: string; feature: FeatureId; stage: FeatureStage; surface: FeatureSurface; opportunityId: string; sourceKey?: string; deliveryId?:number; nowMs: number; codeVersion?: string; featureSetVersion?:number; eventId?:string }): void {
    if (!input.sessionId.trim() || !input.opportunityId.trim() || !isFeatureId(input.feature)) throw new Error("invalid feature observation identity");
    const allowed = input.stage === "availability"
      ? input.surface === "build"
      : input.stage === "exposure"
        ? ["actionable", "context", "help"].includes(input.surface)
        : ["cli", "api"].includes(input.surface);
    if (!allowed) throw new Error("feature stage and surface do not match");
    const deliveryId = input.deliveryId ?? 0;
    if (["actionable", "context"].includes(input.surface)) {
      const delivery = this.db.query(`SELECT 1 FROM injection_ledger WHERE session_id = ? AND delivery_id = ?`).get(input.sessionId, deliveryId);
      if (deliveryId <= 0 || !delivery) throw new Error("injection exposure requires its delivery");
    } else if (deliveryId !== 0) {
      throw new Error("only injection exposure may reference a delivery");
    }
    const source = input.sourceKey ?? "";
    this.db.query(`INSERT OR IGNORE INTO feature_events(event_id,session_id,feature,stage,surface,opportunity_id,source_key,delivery_id,ts_ms,code_version,feature_set_version) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(input.eventId??randomUUID(), input.sessionId, input.feature, input.stage, input.surface, input.opportunityId, source,deliveryId, input.nowMs, input.codeVersion ?? "",input.featureSetVersion??0);
  }

  /** Session id → the build it loaded, for the roster's skew warning. */
  codeVersions(): Map<string, string> {
    const rows = this.db.query(`SELECT session_id, code_version FROM sessions`).all() as Array<
      Record<string, string>
    >;
    return new Map(rows.map((r) => [String(r["session_id"]), String(r["code_version"] ?? "")]));
  }

  /** The tree currently recorded, so a caller can skip a no-op correction. */
  worktreeOf(sessionId: string): string | null {
    const r = this.db
      .query(`SELECT worktree FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { worktree: string } | null;
    return r ? r.worktree : null;
  }

  setIntent(sessionId: string, intent: string): void {
    this.db.query(`UPDATE sessions SET intent = ? WHERE session_id = ?`).run(intent, sessionId);
  }

  /**
   * Records a name the agent chose for itself.
   *
   * Returns the name taken, or null when a LIVE peer already answers to it.
   * Uniqueness is checked and written in one transaction for the same reason
   * handle assignment is: two sessions naming themselves at once would both read
   * "free" before either wrote, and `msg <name>` would then have two recipients.
   *
   * A dead session's name is reusable — that is the point of checking only live
   * ones, and it matches how handles are recycled.
   */
  setAlias(sessionId: string, alias: string, nowMs: number): string | null {
    // A LAST LINE, not the only one: `validateAlias` gives the agent a reason it
    // can act on, and this makes an unaddressable name unrepresentable however
    // it was reached. A stored space is not a cosmetic problem — `msg water
    // dynamic` resolves to nobody, so the name silently stops working.
    if (alias.includes(" ")) return null;
    const claim = this.db.transaction((): string | null => {
      const taken = this.db
        .query(
          `SELECT session_id FROM sessions
            WHERE last_seen_ms > ? AND session_id != ?
              AND (LOWER(alias) = LOWER(?) OR (alias = '' AND LOWER(name) = LOWER(?)))`,
        )
        .get(nowMs - STALE_MS, sessionId, alias, alias) as { session_id: string } | null;
      if (taken) return null;
      this.db.query(`UPDATE sessions SET alias = ? WHERE session_id = ?`).run(alias, sessionId);
      // Recorded durably HERE as well as on unregister, so a name survives a
      // terminal that is killed rather than closed — SessionEnd never runs in
      // that case, and a name that only survives a POLITE exit is the wrong way
      // round.
      this.db
        .query(`INSERT OR REPLACE INTO aliases (session_id, alias, ts_ms) VALUES (?, ?, ?)`)
        .run(sessionId, alias, nowMs);
      return alias;
    });
    return claim();
  }

  /**
   * Sets what the agent is FOR — "Tooling Master", "Keeper of Wet Things".
   *
   * Not unique, and deliberately so: two agents can share a job title the way
   * two people can, and only the NAME has to identify anything. That is the
   * whole reason this is a second field rather than a longer name.
   */
  setRole(sessionId: string, role: string): void {
    this.db.query(`UPDATE sessions SET role = ? WHERE session_id = ?`).run(role, sessionId);
  }

  /** Claude Code's conversation name, read from the transcript. */
  setTitle(sessionId: string, title: string): void {
    this.db.query(`UPDATE sessions SET title = ? WHERE session_id = ?`).run(title, sessionId);
  }

  /**
   * Restores a name this conversation chose before it was last closed.
   *
   * Keyed on the SESSION ID, which is the conversation uuid rather than a
   * per-process label — measured on this tool's own conversation: a mid-session
   * restart moved the display name `traffic-a0` -> `traffic-7c` while the id
   * stayed `c5ce05bc-…`. So the id alone identifies "this conversation, again",
   * and no fuzzy matching is needed.
   *
   * An earlier version matched on the conversation TITLE. That was wrong twice
   * over: the title is model-written and gets REWRITTEN as a conversation
   * develops, so renaming one orphaned its name; and it is empty until the first
   * title lands.
   *
   * Silent when there is nothing to restore, when this session already chose a
   * name, or when a live peer answers to that name — the last is a second window
   * on one conversation, and two agents on one name makes `msg` ambiguous.
   */
  restoreAlias(sessionId: string, nowMs: number): string | null {
    const run = this.db.transaction((): string | null => {
      const self = this.db
        .query(`SELECT alias FROM sessions WHERE session_id = ?`)
        .get(sessionId) as { alias: string } | null;
      if (!self || self.alias !== "") return null;
      const prior = this.db
        .query(`SELECT alias FROM aliases WHERE session_id = ?`)
        .get(sessionId) as { alias: string } | null;
      if (!prior || prior.alias === "") return null;
      const held = this.db
        .query(
          `SELECT session_id FROM sessions
            WHERE LOWER(alias) = LOWER(?) AND session_id != ? AND last_seen_ms > ?`,
        )
        .get(prior.alias, sessionId, nowMs - STALE_MS) as { session_id: string } | null;
      if (held) return null;
      this.db
        .query(`UPDATE sessions SET alias = ? WHERE session_id = ?`)
        .run(prior.alias, sessionId);
      return prior.alias;
    });
    return run();
  }

  /** Where this session's transcript lives, so a refresh can find it later. */
  setTranscript(sessionId: string, path: string): void {
    this.db.query(`UPDATE sessions SET transcript = ? WHERE session_id = ?`).run(path, sessionId);
  }

  transcriptOf(sessionId: string): string {
    const r = this.db
      .query(`SELECT transcript FROM sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, string> | null;
    return r ? String(r["transcript"] ?? "") : "";
  }

  /**
   * Stores a generated summary. The timestamp is written even for an EMPTY
   * summary, so a session whose transcript cannot be summarised is retried on
   * the TTL rather than on every single roster read — an unsummarisable session
   * would otherwise spawn a model call each time anyone typed `who`.
   */
  setSummary(sessionId: string, summary: string, nowMs: number): void {
    this.db
      .query(`UPDATE sessions SET summary = ?, summary_ms = ? WHERE session_id = ?`)
      .run(summary, nowMs, sessionId);
  }

  /**
   * Live sessions whose summary is older than the TTL, with the transcript to
   * read. Only sessions that have RECORDED a transcript path qualify — there is
   * nothing to summarise without one.
   */
  staleSummarySessions(nowMs: number, ttlMs: number): Array<{ sessionId: string; path: string }> {
    const rows = this.db
      .query(
        `SELECT session_id, transcript FROM sessions
          WHERE last_seen_ms > ? AND transcript != '' AND summary_ms < ?`,
      )
      .all(nowMs - STALE_MS, nowMs - ttlMs) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      sessionId: String(r["session_id"]),
      path: String(r["transcript"]),
    }));
  }

  /**
   * A state Claude Code's own `idle`/`busy` cannot express: waiting on a
   * permission prompt, or dead after an API error.
   *
   * Kept separate from `status` because that column is overwritten wholesale by
   * the next `claude agents --json` sample, which would erase this. Cleared by
   * any activity, since a session that just did something is not stuck.
   */
  setBlocked(sessionId: string, blocked: string): void {
    this.db.query(`UPDATE sessions SET blocked = ? WHERE session_id = ?`).run(blocked, sessionId);
  }

  /**
   * Folds in Claude Code's own view of the live sessions: its names
   * (`traffic-12`) and `idle`/`busy`. Only rows we already track are updated —
   * a session that never ran the hooks has no presence state to attach to.
   */
  syncAgents(agents: ReadonlyArray<{ sessionId: string; name: string; status: string }>): void {
    const upd = this.db.prepare(
      `UPDATE sessions SET name = ?, status = ? WHERE session_id = ?`,
    );
    const run = this.db.transaction(() => {
      for (const a of agents) upd.run(a.name, a.status, a.sessionId);
    });
    run();
  }

  /**
   * Finds a live session by the name a human would type. Matches the real
   * session name first, then the fallback handle, then a unique prefix — so
   * `msg traffic-12`, `msg ada` and `msg foot` all work.
   */
  findByName(query: string, nowMs: number): Session | null {
    const live = this.liveSessions(nowMs);
    const q = query.toLowerCase();
    // The CHOSEN name is matched first and on its own pass, so an agent that
    // renamed itself is reachable by the name peers actually see. Matching it in
    // the same pass as `name` would let another session's `traffic-56` win an
    // exact match over this one's deliberate alias.
    const named = live.find((s) => s.alias.toLowerCase() === q);
    if (named) return named;
    const exact = live.find((s) => s.name.toLowerCase() === q || s.handle.toLowerCase() === q);
    if (exact) return exact;
    const prefixed = live.filter(
      (s) =>
        s.alias.toLowerCase().startsWith(q) ||
        s.name.toLowerCase().startsWith(q) ||
        s.handle.toLowerCase().startsWith(q),
    );
    // Ambiguous is not a match: silently picking one would send to the wrong peer.
    return prefixed.length === 1 ? (prefixed[0] ?? null) : null;
  }

  /**
   * Looks a session up by its id, ignoring staleness.
   *
   * Used to identify a CLI caller from `CLAUDE_CODE_SESSION_ID`. Staleness is
   * deliberately NOT applied: a session running this command is by definition
   * alive, whatever its last heartbeat says, and falling back to the operator's
   * handle because a timestamp looked old would forge the user's identity.
   */
  findBySession(sessionId: string): Session | null {
    const r = this.db
      .query(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, string | number> | null;
    if (!r) return null;
    return rowToSession(r);
  }

  unregister(sessionId: string): void {
    // The chosen name is REMEMBERED past the row that held it. A session id is
    // the conversation uuid — `claude --resume <uuid>` takes the same one — so a
    // terminal closed with ⌃C comes back as this same id and should come back
    // under the name the user knows it by. Without this the name survives a
    // crash (row untouched) but not a clean exit, which is backwards.
    // THE GIVEN NAME IS REMEMBERED TOO, not just a chosen alias. Only an alias
    // was, and the result was that a `--continue` renamed anyone who had never
    // renamed themselves: SessionEnd deletes the row, the relaunch re-registers
    // the SAME session id, `restoreAlias` finds no alias to put back, and
    // `pickName` hands out a fresh name. Observed live — `adela` came back as
    // `akira` mid-conversation, which is precisely the moving label the given
    // name exists to replace.
    //
    // The alias wins when both exist, matching `displayName`'s precedence.
    const row = this.db
      .query(`SELECT handle, alias FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { handle: string; alias: string } | null;
    const remembered = row ? (row.alias !== "" ? row.alias : row.handle) : "";
    if (remembered !== "") {
      this.db
        // `Date.now()` because `unregister` takes no clock — every other method
        // here does, and a test that backdates one cannot backdate this. That is
        // acceptable: a session ending is always NOW, and the only cost is that
        // a fixture cannot age this row without ageing the whole test.
        .query(`INSERT OR REPLACE INTO aliases (session_id, alias, ts_ms) VALUES (?, ?, ?)`)
        .run(sessionId, remembered, Date.now());
    }
    this.db.query(`DELETE FROM claims WHERE session_id = ?`).run(sessionId);
    this.db.query(`DELETE FROM tasks WHERE session_id = ?`).run(sessionId);
    this.db.query(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
    // `edits` IS NOT TOUCHED. It is history, and the moment a session ends is
    // exactly when someone starts asking what it changed — measured: an agent
    // ended its session mid-conversation here and its 6 claims vanished with it,
    // leaving no record that it had been in `src/gen/terrain.ts` at all.
  }

  /**
   * Appends a message. `to` scopes delivery to one session; omit it to
   * broadcast. Display names are captured now, not resolved later.
   */
  post(
    handle: string,
    kind: MessageKind,
    body: string,
    nowMs: number,
    to?: { readonly sessionId: string; readonly name: string },
  ): void {
    // `alias` is selected here or a renamed agent's messages go out under its
    // old name — and `from_name` is FROZEN at send time, so the log would carry
    // the wrong sender forever rather than merely displaying it once.
    const from = this.db
      .query(`SELECT name, handle, alias FROM sessions WHERE handle = ?`)
      .get(handle) as { name: string; handle: string; alias: string } | null;
    const fromName = from ? displayName(from) : handle;
    this.db
      .query(
        `INSERT INTO messages (ts_ms, handle, kind, body, to_session, from_name, to_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nowMs, handle, kind, body, to?.sessionId ?? "", fromName, to?.name ?? "");
    this.db
      .query(
        `DELETE FROM messages WHERE id <= (SELECT MAX(id) - ? FROM messages)`,
      )
      .run(MAX_MESSAGES);
  }

  /**
   * Messages this session has not been shown, excluding its own — an agent does
   * not need to be told what it just said.
   *
   * Read and cursor-advance are one transaction so two hooks racing on the same
   * session cannot both deliver the same range.
   */
  /**
   * Like `drainUnread`, but delivers only messages a human or a peer addressed
   * deliberately — directed `say` and human `note` — and leaves everything else
   * for the next ordinary delivery point.
   *
   * WHY: at `Stop`, injecting `additionalContext` CONTINUES the turn (HOOKS.MD:
   * "The conversation continues so Claude can act on it"). Routine chatter must
   * therefore never be delivered there: with several sessions in one tree, each
   * agent's turn-end announcement would extend every other agent's turn, and two
   * agents can bounce `done` lines off each other up to the 8-continuation cap.
   *
   * THE TEST IS "ADDRESSED TO ME", NOT "IS A `say`". It was once the latter,
   * which meant a directed `claim` — another session editing a file THIS one
   * holds — was filtered out here and waited for the next prompt. For a session
   * mid-autonomous-run that is a long time to keep writing a function somebody
   * else is rewriting, and it is precisely the news worth ending a turn for.
   * Broadcasts of every kind still wait; what changed is that a message someone
   * deliberately sent to this session arrives whatever kind it is.
   *
   * THE CURSOR STOPS BELOW THE FIRST ROW IT SKIPPED, not at the last row it
   * delivered. A single monotonic cursor cannot express "delivered id 7 but not
   * id 6", so advancing past a skipped row buries it forever: no later drain
   * looks below the cursor.
   *
   * That is not hypothetical. A peer broadcasts "waterSim.ts is mine" (id N),
   * then anyone sends this session a directed message (id N+1); delivering N+1
   * and advancing to N+1 loses the broadcast permanently — and broadcasts are
   * exactly the stay-off-this-file traffic the tool exists to carry. Holding the
   * cursor below N re-delivers the directed message at the next prompt, which is
   * the cheap side of the trade: a duplicate is noise, a lost claim warning is a
   * conflict nobody saw coming.
   */
  drainDirected(sessionId: string): Message[] {
    const drain = this.db.transaction((): Message[] => {
      const cur = this.db
        .query(`SELECT handle, last_read_id FROM sessions WHERE session_id = ?`)
        .get(sessionId) as { handle: string; last_read_id: number } | null;
      if (!cur) return [];
      const deliverable = `id > ?1 AND handle != ?2 AND (to_session = '' OR to_session = ?3)`;
      const rows = this.db
        .query(
          `SELECT id, ts_ms, handle, kind, body, to_session, from_name, to_name
             FROM messages
            WHERE ${deliverable}
              AND (kind = 'note' OR to_session = ?3)
            ORDER BY id ASC`,
        )
        .all(cur.last_read_id, cur.handle, sessionId) as Array<Record<string, string | number>>;
      if (rows.length === 0) return [];
      // The lowest id this drain did NOT hand over. Everything from here on is
      // still owed to this session, so the cursor must stay beneath it.
      const skipped = this.db
        .query(
          `SELECT MIN(id) AS id FROM messages
            WHERE ${deliverable}
              AND NOT (kind = 'note' OR to_session = ?3)`,
        )
        .get(cur.last_read_id, cur.handle, sessionId) as { id: number | null } | null;
      const lastDelivered = Number(rows[rows.length - 1]?.["id"] ?? cur.last_read_id);
      const firstSkipped = skipped?.id ?? null;
      const advanceTo =
        firstSkipped === null ? lastDelivered : Math.min(lastDelivered, firstSkipped - 1);
      if (advanceTo > cur.last_read_id) {
        this.db
          .query(`UPDATE sessions SET last_read_id = ? WHERE session_id = ?`)
          .run(advanceTo, sessionId);
      }
      return rows.map(toMessage);
    });
    return drain.immediate();
  }

  drainUnread(sessionId: string): Message[] {
    const drain = this.db.transaction((): Message[] => {
      const cur = this.db
        .query(`SELECT handle, last_read_id FROM sessions WHERE session_id = ?`)
        .get(sessionId) as { handle: string; last_read_id: number } | null;
      if (!cur) return [];
      // A directed message reaches ONLY its recipient; a broadcast reaches
      // everyone but its sender. Filtering here rather than at render time is
      // what makes "directed" real: an unaddressed peer never receives the row.
      const rows = this.db
        .query(
          `SELECT id, ts_ms, handle, kind, body, to_session, from_name, to_name
             FROM messages
            WHERE id > ? AND handle != ?
              AND (to_session = '' OR to_session = ?)
            ORDER BY id ASC`,
        )
        .all(cur.last_read_id, cur.handle, sessionId) as Array<
        Record<string, string | number>
      >;
      // Advance past every message in the range, including this session's own
      // filtered-out lines, or they are re-scanned on every turn forever.
      const maxId = this.db.query(`SELECT COALESCE(MAX(id), 0) AS m FROM messages`).get() as {
        m: number;
      };
      this.db
        .query(`UPDATE sessions SET last_read_id = ? WHERE session_id = ?`)
        .run(maxId.m, sessionId);
      return rows.map(toMessage);
    });
    // IMMEDIATE for the same reason `register` is: this reads and then writes,
    // and under WAL a deferred transaction that upgrades after a peer committed
    // fails with SQLITE_BUSY_SNAPSHOT — which `busy_timeout` cannot rescue,
    // because waiting does not freshen a stale snapshot. With several agents
    // posting continuously that is the busy case, i.e. exactly when delivery
    // matters most.
    return drain.immediate();
  }

  /**
   * Last few log lines regardless of cursor — the joining-a-room summary.
   *
   * `forSession` scopes it the same way `drainUnread` does, so a joining agent
   * is not handed history addressed to someone else. Omit it for the CLI, where
   * you are the operator and want the whole picture.
   */
  recent(limit: number, forSession?: string): Message[] {
    // Bound, never interpolated: a session id reaching SQL as source text is a
    // habit that eventually meets a value that isn't a UUID.
    const rows = this.db
      .query(
        `SELECT id, ts_ms, handle, kind, body, to_session, from_name, to_name
           FROM messages
          WHERE ?1 IS NULL OR to_session = '' OR to_session = ?1
          ORDER BY id DESC LIMIT ?2`,
      )
      .all(forSession ?? null, limit) as Array<Record<string, string | number>>;
    return rows.map(toMessage).reverse();
  }

  /** Mirrors a task from a session's private list onto the shared board. */
  upsertTask(sessionId: string, taskId: string, subject: string, nowMs: number): void {
    this.db
      .query(
        `INSERT INTO tasks (session_id, task_id, subject, created_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT (session_id, task_id) DO UPDATE SET subject = excluded.subject`,
      )
      .run(sessionId, taskId, subject, nowMs);
  }

  completeTask(sessionId: string, taskId: string, nowMs: number): void {
    this.db
      .query(`UPDATE tasks SET completed_ms = ? WHERE session_id = ? AND task_id = ?`)
      .run(nowMs, sessionId, taskId);
  }

  /** Open/done counts per session, for the roster's progress column. */
  taskCounts(): Map<string, { open: number; done: number }> {
    const rows = this.db
      .query(
        `SELECT session_id,
                SUM(CASE WHEN completed_ms = 0 THEN 1 ELSE 0 END) AS open,
                SUM(CASE WHEN completed_ms > 0 THEN 1 ELSE 0 END) AS done
           FROM tasks GROUP BY session_id`,
      )
      .all() as Array<Record<string, string | number>>;
    const out = new Map<string, { open: number; done: number }>();
    for (const r of rows) {
      out.set(String(r["session_id"]), { open: Number(r["open"]), done: Number(r["done"]) });
    }
    return out;
  }

  /**
   * When this session last announced a stopping point, or 0 if it never has.
   *
   * Used as the start of "this turn": anything claimed after the previous `done`
   * was claimed since. Cheaper and more honest than tracking turn boundaries
   * separately — the marker already exists and cannot drift out of sync with the
   * thing it marks.
   */
  lastDoneMs(handle: string, sinceMs = 0): number {
    // Bounded by `sinceMs` (the caller passes its own `startedMs`) because
    // handles are RECYCLED once a session is pruned. A new session inheriting
    // `ada` would otherwise adopt the dead ada's last `done` timestamp as its
    // turn start, and silently omit from its first turn-end summary every file
    // it edited before that moment.
    const r = this.db
      .query(
        `SELECT MAX(ts_ms) AS t FROM messages
          WHERE handle = ? AND kind = 'done' AND ts_ms >= ?`,
      )
      .get(handle, sinceMs) as { t: number | null } | null;
    return Math.max(Number(r?.t ?? 0), sinceMs);
  }

  /**
   * True when this session already announced an overlap on `path` recently.
   *
   * Matched on the path inside the body rather than a separate column: the
   * message log is the record of what was said, and "did I already say this"
   * is a question about that record.
   */
  announcedOverlapRecently(handle: string, path: string, nowMs: number): boolean {
    const r = this.db
      .query(
        `SELECT 1 AS hit FROM messages
          WHERE handle = ? AND kind = 'claim' AND ts_ms > ?
            AND body LIKE ? ESCAPE '\\'
          LIMIT 1`,
      )
      .get(handle, nowMs - CLAIM_REANNOUNCE_MS, `also editing ${likeEscape(path)} %`) as {
      hit: number;
    } | null;
    return r !== null;
  }

  /**
   * Records an edit: the live claim, and the permanent history row.
   *
   * BOTH FROM ONE CALL, so the two cannot drift — a claim written without its
   * history row is an edit that blame will never see, and there is no way to
   * notice that afterwards.
   *
   * The `tool`/`worktree` arguments are optional so the older two-argument form
   * still works; a caller that omits them loses only detail, never the row.
   */
  claim(
    sessionId: string,
    path: string,
    nowMs: number,
    detail?: { readonly tool?: string; readonly worktree?: string; readonly branch?: string },
  ): void {
    const run = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO claims (path, session_id, ts_ms) VALUES (?, ?, ?)
             ON CONFLICT (path, session_id) DO UPDATE SET ts_ms = excluded.ts_ms`,
        )
        .run(path, sessionId, nowMs);
      // Resolved NOW and stored, not joined at read time: this row has to still
      // name its author after the session row is gone.
      const s = this.db
        .query(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
        .get(sessionId) as Record<string, string | number> | null;
      const who = s ? displayName(rowToSession(s)) : "";
      this.db
        .query(
          `INSERT INTO edits (ts_ms, path, session_id, agent, worktree, branch, tool)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nowMs,
          path,
          sessionId,
          who,
          detail?.worktree ?? String(s?.["worktree"] ?? ""),
          detail?.branch ?? String(s?.["branch"] ?? ""),
          detail?.tool ?? "",
        );
    });
    run();
  }

  /**
   * Every file an agent has touched, most recent first — the answer to "what
   * else is this peer in?" without reading the log backwards.
   *
   * Deduplicated by path, keeping the LATEST touch, because a file edited
   * fifteen times is one fact about what that agent is working on, not fifteen.
   */
  editsBy(
    sessionId: string,
    sinceMs: number,
    limit = 200,
  ): Array<{ path: string; tsMs: number; worktree: string; tool: string; count: number }> {
    const rows = this.db
      .query(
        `SELECT path, MAX(ts_ms) AS ts_ms, worktree, tool, COUNT(*) AS n
           FROM edits WHERE session_id = ? AND ts_ms > ?
          GROUP BY path ORDER BY MAX(ts_ms) DESC LIMIT ?`,
      )
      .all(sessionId, sinceMs, limit) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      path: String(r["path"]),
      tsMs: Number(r["ts_ms"]),
      worktree: String(r["worktree"] ?? ""),
      tool: String(r["tool"] ?? ""),
      count: Number(r["n"] ?? 1),
    }));
  }

  /**
   * Who has touched a path, most recent first — blame, at file granularity.
   *
   * NOT deduplicated: the whole question is the sequence, and two agents
   * alternating on one file is exactly the thing worth seeing.
   */
  editsOf(
    path: string,
    limit = 50,
  ): Array<{ agent: string; sessionId: string; tsMs: number; worktree: string; tool: string }> {
    // BY TIMESTAMP, not by rowid. Rows normally arrive in time order, so the
    // two agree — until they do not, and then blame reads as a jumble with no
    // hint that it is wrong. `id` breaks ties so two edits in the same
    // millisecond still have a stable order.
    const rows = this.db
      .query(`SELECT * FROM edits WHERE path = ? ORDER BY ts_ms DESC, id DESC LIMIT ?`)
      .all(path, limit) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      agent: String(r["agent"] ?? ""),
      sessionId: String(r["session_id"]),
      tsMs: Number(r["ts_ms"]),
      worktree: String(r["worktree"] ?? ""),
      tool: String(r["tool"] ?? ""),
    }));
  }

  /** Agents seen in the edit history, for resolving a name to a session id. */
  editAgents(sinceMs: number): Array<{ agent: string; sessionId: string; lastMs: number }> {
    const rows = this.db
      .query(
        `SELECT agent, session_id, MAX(ts_ms) AS last_ms FROM edits
          WHERE ts_ms > ? AND agent != '' GROUP BY session_id ORDER BY MAX(ts_ms) DESC`,
      )
      .all(sinceMs) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      agent: String(r["agent"]),
      sessionId: String(r["session_id"]),
      lastMs: Number(r["last_ms"]),
    }));
  }

  /**
   * Records a spawned subagent and returns its sequence number.
   *
   * IDEMPOTENT on `agent_id`: a hook that fires twice must not consume a
   * second number, or the same live minion appears under two names.
   *
   * The number counts every minion this parent has EVER spawned, alive or not,
   * so it is never reused — `MAX(seq)` over the parent's whole history rather
   * than a count of live rows. A reused number would silently repoint a log
   * line that named "Minion #2" at a different minion.
   */
  startMinion(
    agentId: string,
    sessionId: string,
    nowMs: number,
    opts: { task?: string; agentType?: string } = {},
  ): number {
    const claim = this.db.transaction((): number => {
      const existing = this.db
        .query(`SELECT seq FROM minions WHERE agent_id = ?`)
        .get(agentId) as Record<string, number> | null;
      if (existing) return Number(existing["seq"]);

      const row = this.db
        .query(`SELECT MAX(seq) AS top FROM minions WHERE session_id = ?`)
        .get(sessionId) as Record<string, number | null> | null;
      const seq = Number(row?.["top"] ?? 0) + 1;
      this.db
        .query(
          `INSERT INTO minions (agent_id, session_id, seq, task, agent_type, started_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(agentId, sessionId, seq, opts.task ?? "", opts.agentType ?? "", nowMs);
      return seq;
    });
    // IMMEDIATE for the same reason `register` is: MAX(seq) then INSERT is a
    // read-then-write, and two minions spawned at once would otherwise both
    // read the same top and take the same number.
    return claim.immediate();
  }

  /**
   * Closes a minion, keeping the row.
   *
   * The row is history — it says the parent ran this and when — so it is closed
   * rather than deleted, exactly as `edits` keeps what a departed agent touched.
   * `task` is filled in on close when the spawn never carried one, because
   * SubagentStop reports a description that SubagentStart sometimes does not.
   */
  endMinion(agentId: string, nowMs: number, task?: string): void {
    if (task !== undefined && task !== "") {
      this.db
        .query(
          `UPDATE minions SET ended_ms = ?, task = CASE WHEN task = '' THEN ? ELSE task END
            WHERE agent_id = ? AND ended_ms = 0`,
        )
        .run(nowMs, task, agentId);
      return;
    }
    this.db
      .query(`UPDATE minions SET ended_ms = ? WHERE agent_id = ? AND ended_ms = 0`)
      .run(nowMs, agentId);
  }

  /**
   * Minions still running, by parent session id.
   *
   * Live ones only: `who` answers "what is happening now", and a parent that
   * has spawned forty over a session would otherwise bury the roster in
   * finished work.
   */
  liveMinions(nowMs: number): Map<string, Minion[]> {
    const rows = this.db
      .query(
        `SELECT agent_id, session_id, seq, task, agent_type, started_ms
           FROM minions WHERE ended_ms = 0 AND started_ms > ? ORDER BY seq`,
      )
      .all(nowMs - MINION_STALE_MS) as Array<Record<string, string | number>>;
    const byParent = new Map<string, Minion[]>();
    for (const r of rows) {
      const m: Minion = {
        agentId: String(r["agent_id"]),
        sessionId: String(r["session_id"]),
        seq: Number(r["seq"]),
        task: String(r["task"]),
        agentType: String(r["agent_type"]),
        startedMs: Number(r["started_ms"]),
      };
      byParent.set(m.sessionId, [...(byParent.get(m.sessionId) ?? []), m]);
    }
    return byParent;
  }

  /**
   * How many minions each parent has running.
   *
   * Counts only, for the peer-facing roster: a minion cannot be addressed, so
   * a peer given names would have recipients `msg` cannot resolve. `who` uses
   * `liveMinions` instead, because the operator CAN act on what they name.
   */
  minionCounts(nowMs: number): Map<string, number> {
    const rows = this.db
      .query(
        `SELECT session_id, COUNT(*) AS n FROM minions
          WHERE ended_ms = 0 AND started_ms > ? GROUP BY session_id`,
      )
      .all(nowMs - MINION_STALE_MS) as Array<Record<string, string | number>>;
    return new Map(rows.map((r) => [String(r["session_id"]), Number(r["n"])]));
  }

  /**
   * Forgets minions long past. A crashed parent never fires SubagentStop, so
   * without this an abandoned row would read as "running" forever.
   */
  pruneMinions(nowMs: number): void {
    this.db
      .query(`UPDATE minions SET ended_ms = ? WHERE ended_ms = 0 AND started_ms <= ?`)
      .run(nowMs, nowMs - MINION_STALE_MS);
    this.db
      .query(`DELETE FROM minions WHERE ended_ms != 0 AND ended_ms < ?`)
      .run(nowMs - MINION_KEEP_MS);
  }

  /**
   * Drops a claim whose file turned out to be committed.
   *
   * A claim means "my uncommitted work is in this file"; once it is committed
   * that is false, and leaving the row costs every later agent a `git status`
   * to rediscover the same thing. The EDIT HISTORY is untouched — the fact that
   * they edited it stays true and is what `blame` reads.
   */
  releaseClaim(sessionId: string, path: string): void {
    this.db.query(`DELETE FROM claims WHERE session_id = ? AND path = ?`).run(sessionId, path);
  }

  /** Claims on `path` held by OTHER live sessions. */
  conflictingClaims(sessionId: string, path: string, nowMs: number): Claim[] {
    const rows = this.db
      .query(
        `SELECT c.session_id AS session_id, s.handle AS handle,
                CASE WHEN s.alias != '' THEN s.alias ELSE s.name END AS name,
                s.worktree AS worktree, c.path AS path, c.ts_ms AS ts_ms
           FROM claims c JOIN sessions s ON s.session_id = c.session_id
          WHERE c.path = ? AND c.session_id != ? AND s.last_seen_ms > ?
            AND c.ts_ms > ?`,
      )
      .all(path, sessionId, nowMs - STALE_MS, nowMs - CLAIM_TTL_MS) as Array<
        Record<string, string | number>
      >;
    return rows.map(toClaim);
  }

  /**
   * Paths this session claimed since `sinceMs` — what it actually touched,
   * rather than everything it has ever held.
   *
   * This is what makes a turn-end line worth reading. Measured with three live
   * sessions on 2026-07-31: 7 of 7 log rows were `done`, and 4 were the literal
   * string "reached a stopping point". A peer scanning that learns nothing at
   * all, which made the log — the whole point of the system — pure noise.
   */
  claimsSince(sessionId: string, sinceMs: number): string[] {
    const rows = this.db
      .query(
        `SELECT path FROM claims
          WHERE session_id = ? AND ts_ms >= ?
          ORDER BY ts_ms ASC`,
      )
      .all(sessionId, sinceMs) as Array<Record<string, string>>;
    return rows.map((r) => String(r["path"]));
  }

  /** Every live claim, for the roster. */
  /**
   * What this session has already been shown, as `dedupeKey -> stateVersion`.
   *
   * Feeds `pack`'s suppression: a key absent is new, a key whose fingerprint
   * differs has changed and is shown again, a key matching exactly is dropped.
   * Empty for a session that has never been packed, which is the correct
   * "everything is news" answer for a first SessionStart.
   */
  injectionExposures(sessionId: string): Map<string, string> {
    const rows = this.db
      .query(`SELECT dedupe_key AS k, state_ver AS v FROM injection_exposures WHERE session_id = ?`)
      .all(sessionId) as Array<{ k: string; v: string }>;
    return new Map(rows.map((r) => [r.k, r.v]));
  }

  /**
   * Records what was actually put in front of this session.
   *
   * ONLY THE SELECTED. An omitted candidate was not shown, so marking it
   * exposed would suppress it next time on the strength of a delivery that
   * never happened — the failure mode being guarded against here is silence,
   * and that would manufacture it.
   *
   * `REPLACE` because the row is a latest-known-state, not a log: an item
   * re-shown with a new fingerprint should leave one row saying what the
   * session last saw, not two rows disagreeing.
   */

  /**
   * Everything one packed block implies, committed together.
   *
   * TWO CALLS WERE TWO TRANSACTIONS, and the failure between them is silent:
   * exposures land, omissions do not, and the session is now marked as having
   * been shown content whose inbox is empty or stale. The next start suppresses
   * that content, so the agent neither sees it nor can retrieve it — which is
   * precisely the disappearance this feature exists to prevent.
   *
   * `clearFirst` is the `/clear`-and-compact path: SessionStart re-fires with
   * the same session id and a wiped context, so the record of what that context
   * once held has to go with it.
   */
  recordInjectionResult(
    sessionId: string,
    result: {
      readonly shown: ReadonlyArray<InjectionShown>;
      readonly omitted: ReadonlyArray<InjectionOmitted>;
      readonly nowMs: number;
      readonly clearFirst?: boolean;
    },
  ): void {
    // ONE PACKED BLOCK, ONE ID. Grouping the ledger by `(session_id, ts_ms)`
    // reads two hook runs inside the same millisecond as a single delivery —
    // rare, but the failure is a reconstruction that silently merges two blocks
    // and shows a candidate list that was never injected together.
    //
    // Allocated INSIDE the transaction below: several agents write this db at
    // once, and a MAX+1 read outside it is the classic race that hands two
    // concurrent deliveries the same id.
    const nextDeliveryId = this.db.query(
      `SELECT COALESCE(MAX(delivery_id), 0) + 1 AS id FROM injection_ledger`,
    );
    const expose = this.db.query(
      `INSERT OR REPLACE INTO injection_exposures (session_id, dedupe_key, state_ver, ts_ms)
       VALUES (?, ?, ?, ?)`,
    );
    const dropExposures = this.db.query(`DELETE FROM injection_exposures WHERE session_id = ?`);
    const dropOmissions = this.db.query(`DELETE FROM injection_omissions WHERE session_id = ?`);
    const owe = this.db.query(
      `INSERT OR REPLACE INTO injection_omissions
         (session_id, key, text, reason, state_ver, ts_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const log = this.db.query(
      `INSERT INTO injection_ledger
         (session_id, delivery_id, ts_ms, key, dedupe_key, state_ver,
          outcome, form, reason, priority, chars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      const delivery = (nextDeliveryId.get() as { id: number }).id;
      // SUPPRESSION STATE is replaced; the LEDGER is appended. A wiped context
      // means "say it all again", not "it was never said" — so `clearFirst`
      // drops the exposure rows and leaves the history of what was delivered.
      if (result.clearFirst === true) dropExposures.run(sessionId);
      for (const s of result.shown) {
        expose.run(sessionId, s.dedupeKey, s.stateVersion, result.nowMs);
        log.run(
          sessionId, delivery, result.nowMs, s.key, s.dedupeKey, s.stateVersion,
          "selected", s.form, "", s.priority, s.chars,
        );
        const feature = featureForCandidate(s.key);
        if (feature) this.recordFeatureEvent({ sessionId, feature, stage: "exposure", surface: s.actionable === true ? "actionable" : "context", opportunityId: sessionId, sourceKey: `${s.key}:${s.stateVersion}`, deliveryId: delivery, nowMs: result.nowMs });
      }
      // Replaced wholesale: what a session is missing is a current fact, and an
      // item that fitted this time is no longer owed.
      dropOmissions.run(sessionId);
      for (const o of result.omitted) {
        // EVERY omission is history. `duplicate` and `unchanged` are the
        // outcomes that answer "why was this agent never told?", and they were
        // the ones missing.
        log.run(
          sessionId, delivery, result.nowMs, o.key, o.dedupeKey, o.stateVersion,
          "omitted", "", o.reason, o.priority, o.text.length,
        );
        // Only what is OWED. A suppressed candidate was dropped because the
        // session already has it, and a non-actionable one is not work — the
        // block's "N actionable item(s) omitted" line counts exactly this set.
        if (o.reason === "no room" && o.actionable) {
          owe.run(sessionId, o.key, o.text, o.reason, o.stateVersion, result.nowMs);
        }
      }
    })();
  }

  /**
   * Which candidates each delivery contained, newest first.
   *
   * THE QUESTION `cli.ts injection` COULD NOT ANSWER. That command recomputes a
   * block from current state, which is a hypothesis about what a session would
   * get now — useful, and not the same as what it got. Debugging "why did this
   * agent not know about X" needs the delivery, not a re-derivation from state
   * that has since moved.
   */
  injectionHistory(sessionId: string, limit = 50): InjectionLedgerRow[] {
    return this.db
      .query(
        `SELECT delivery_id AS deliveryId, ts_ms AS tsMs, key, dedupe_key AS dedupeKey,
                state_ver AS stateVersion, outcome, form, reason, priority, chars
           FROM injection_ledger WHERE session_id = ?
          ORDER BY delivery_id DESC, priority DESC, key ASC LIMIT ?`,
      )
      .all(sessionId, limit) as InjectionLedgerRow[];
  }

  /**
   * Forgets what a session was shown, because its context no longer holds it.
   *
   * Called when SessionStart reports `clear`, `compact` or `fork`: the row
   * survives, the conversation does not. Measured 2026-08-02 — 19 identity
   * injections after one compact boundary under an unchanged session id.
   */
  clearInjectionExposures(sessionId: string): void {
    this.db.query(`DELETE FROM injection_exposures WHERE session_id = ?`).run(sessionId);
  }

  /**
   * Drops injection state for sessions nobody will resume.
   *
   * Its own horizon rather than `STALE_MS`: a session goes off the roster after
   * 90 minutes of silence but can still be resumed hours later, and resume is
   * the one case where suppression is correct. Borrowing the roster's TTL would
   * quietly make suppression useless for exactly that path.
   */
  pruneInjectionState(nowMs: number, keepMs: number): void {
    const cutoff = nowMs - keepMs;
    this.db.query(`DELETE FROM injection_exposures WHERE ts_ms < ?`).run(cutoff);
    this.db.query(`DELETE FROM injection_omissions WHERE ts_ms < ?`).run(cutoff);
    this.db.query(`DELETE FROM injection_ledger WHERE ts_ms < ?`).run(cutoff);
  }

  /**
   * What was dropped for length, and is therefore owed to `inbox`.
   *
   * Replaced wholesale per session rather than appended: the block a session
   * was just shown is the current truth about what it is missing, and a
   * candidate that fitted this time is no longer owed.
   */
  /** Everything `inbox` should hand back, oldest first. */
  injectionOmissions(
    sessionId: string,
  ): Array<{ key: string; text: string; reason: string; stateVersion: string }> {
    return this.db
      .query(
        `SELECT key, text, reason, state_ver AS stateVersion FROM injection_omissions
          WHERE session_id = ? ORDER BY ts_ms ASC, key ASC`,
      )
      .all(sessionId) as Array<{
      key: string;
      text: string;
      reason: string;
      stateVersion: string;
    }>;
  }

  allClaims(nowMs: number): Claim[] {
    const rows = this.db
      .query(
        // The chosen name wins here too, in SQL rather than at each call site:
        // an overlap warning that calls an agent `traffic-56` while the roster
        // calls it something else reads as two different agents.
        `SELECT c.session_id AS session_id, s.handle AS handle,
                CASE WHEN s.alias != '' THEN s.alias ELSE s.name END AS name,
                s.worktree AS worktree, c.path AS path, c.ts_ms AS ts_ms
           FROM claims c JOIN sessions s ON s.session_id = c.session_id
          WHERE s.last_seen_ms > ? AND c.ts_ms > ? ORDER BY c.ts_ms ASC`,
      )
      .all(nowMs - STALE_MS, nowMs - CLAIM_TTL_MS) as Array<Record<string, string | number>>;
    return rows.map(toClaim);
  }

  /**
   * Drops rows for sessions that stopped heartbeating.
   *
   * Tasks go with them: they were the only table nothing ever cleaned, so a
   * machine that has run agents for months accumulates every task any dead
   * session ever created. Every other table here prunes; this one was simply
   * missed.
   */
  pruneStale(nowMs: number): void {
    const cutoff = nowMs - STALE_MS;
    const dead = `(SELECT session_id FROM sessions WHERE last_seen_ms <= ?)`;
    this.db.query(`DELETE FROM claims WHERE session_id IN ${dead}`).run(cutoff);
    this.db.query(`DELETE FROM tasks WHERE session_id IN ${dead}`).run(cutoff);
    this.db.query(`DELETE FROM sessions WHERE last_seen_ms <= ?`).run(cutoff);
    // Edit history outlives everything else here — it is the only table that
    // answers a question about the PAST, and its horizon is configurable
    // (`editKeepMs`) because thirty days is a guess and someone's audit is not.
    this.db.query(`DELETE FROM edits WHERE ts_ms <= ?`).run(nowMs - loadConfig().editKeepMs);
    // WORK RECORDS ARE NOT SWEPT WITH THE SESSION. They are keyed on the agent
    // precisely so they outlive the terminal that opened them — a record that
    // evaporated when a session went stale could not answer "who moved the
    // baselines?" a day later, which is the question it exists for. They expire
    // on their own, longer clock, and only once CLOSED.
    new WorkStore(this.db).pruneWork(nowMs);
  }
}

function toMessage(r: Record<string, string | number>): Message {
  // `from_name` is empty on rows written before names existed; the handle is the
  // honest fallback rather than a blank sender.
  const from = String(r["from_name"] ?? "");
  return {
    id: Number(r["id"]),
    tsMs: Number(r["ts_ms"]),
    from: from !== "" ? from : String(r["handle"]),
    to: String(r["to_name"] ?? ""),
    kind: String(r["kind"]) as MessageKind,
    body: String(r["body"]),
  };
}

/**
 * Escapes LIKE's wildcards. Real paths contain both — `_` in `waterTexture_2.ts`
 * and `%` in an encoded name — and an unescaped `_` matches any character, so a
 * lookup for one file would answer for its neighbour.
 */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function toClaim(r: Record<string, string | number>): Claim {
  return {
    sessionId: String(r["session_id"]),
    handle: String(r["handle"]),
    name: String(r["name"] ?? ""),
    path: String(r["path"]),
    worktree: String(r["worktree"]),
    tsMs: Number(r["ts_ms"]),
  };
}

/** The name a human should see for a claim: the session's, else its handle. */
export function claimName(c: Claim): string {
  return c.name !== "" ? c.name : c.handle;
}

export function agoText(fromMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - fromMs) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}
