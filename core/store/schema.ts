import { Database } from "bun:sqlite";

import { ensureBaseDir } from "../repo.ts";
import { createWorkTables } from "../work.ts";
import { createDiaryTables } from "../diary.ts";
import { createQuestionTables } from "../questions.ts";
import { createObligationTables } from "../obligations.ts";

interface ColumnMigration {
  readonly table: string;
  readonly column: string;
  readonly declaration: string;
}

const COLUMN_MIGRATIONS = [
  ["sessions", "code_version", "TEXT NOT NULL DEFAULT ''"],
  ["sessions", "title", "TEXT NOT NULL DEFAULT ''"],
  ["sessions", "summary", "TEXT NOT NULL DEFAULT ''"],
  ["sessions", "summary_ms", "INTEGER NOT NULL DEFAULT 0"],
  ["sessions", "transcript", "TEXT NOT NULL DEFAULT ''"],
  ["sessions", "alias", "TEXT NOT NULL DEFAULT ''"],
  ["sessions", "role", "TEXT NOT NULL DEFAULT ''"],
  ["sessions", "behind_base", "INTEGER NOT NULL DEFAULT -1"],
  ["sessions", "base_branch", "TEXT NOT NULL DEFAULT ''"],
  ["sessions", "lineage_from", "TEXT NOT NULL DEFAULT ''"],
  ["aliases", "ts_ms", "INTEGER NOT NULL DEFAULT 0"],
  ["injection_omissions", "state_ver", "TEXT NOT NULL DEFAULT ''"],
  ["feature_events", "delivery_id", "INTEGER NOT NULL DEFAULT 0"],
  ["feature_events", "feature_set_version", "INTEGER NOT NULL DEFAULT 0"],
  ["injection_ledger", "delivery_id", "INTEGER NOT NULL DEFAULT 0"],
  ["work", "auto", "INTEGER NOT NULL DEFAULT 0"],
  ["work", "plan_doc", "TEXT NOT NULL DEFAULT ''"],
  ["diary", "fixed_by", "INTEGER NOT NULL DEFAULT 0"],
  ["diary", "fixed_ms", "INTEGER NOT NULL DEFAULT 0"],
] as const satisfies ReadonlyArray<readonly [
  ColumnMigration["table"], ColumnMigration["column"], ColumnMigration["declaration"],
]>;

/**
 * Applies one compile-time schema migration. Callers must never pass identifiers
 * or declarations derived from external input.
 */
export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((candidate) => candidate.name === column)) return;
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to migrate ${table}.${column}: ${detail}`, { cause: error });
  }
}


export function openDb(dbPath: string): Database {
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
  for (const [table, column, declaration] of COLUMN_MIGRATIONS) {
    addColumnIfMissing(db, table, column, declaration);
  }
  // Index creation follows migrations because existing tables may lack these columns.

  db.query(
    `CREATE INDEX IF NOT EXISTS injection_ledger_session
       ON injection_ledger (session_id, delivery_id DESC)`,
  ).run();
  db.exec(`CREATE INDEX IF NOT EXISTS work_plan ON work (plan_doc) WHERE plan_doc != ''`);
  return db;
}
