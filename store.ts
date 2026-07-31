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

import { ensureBaseDir } from "./repo.ts";

/**
 * A session with no heartbeat for this long is treated as gone. Sessions die by
 * closing a terminal far more often than by exiting cleanly, so the SessionEnd
 * hook cannot be the only way a row disappears — without a timeout the roster
 * fills with ghosts and stops being worth reading.
 */
export const STALE_MS = 90 * 60 * 1000; // 90 min

/** Rows kept in the log; old ones are pruned so the file cannot grow forever. */
const MAX_MESSAGES = 2000;

/**
 * Handles are for humans reading a roster, so they are short and pronounceable.
 * ORDER IS LOAD-BEARING: `colour.ts` colours an agent by its index here, so
 * reordering this list reshuffles every agent's colour.
 */
export const HANDLES = [
  "ada",
  "turing",
  "hopper",
  "lovelace",
  "knuth",
  "dijkstra",
  "ritchie",
  "thompson",
] as const;

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
export type MessageKind = "say" | "claim" | "release" | "done" | "note";

export interface Session {
  readonly sessionId: string;
  /**
   * Claude Code's own name for the session (`traffic-12`, `water-sim-f7`), when
   * known. Preferred over `handle` everywhere a human or agent reads a name: it
   * is the label you already see in your terminal, so the roster and your
   * windows agree.
   */
  readonly name: string;
  /** Fallback identity assigned by this system when no real name is known. */
  readonly handle: string;
  /** `idle` / `busy` from Claude Code, or "" when it has not been sampled. */
  readonly status: string;
  /** Why the session is stuck, when it is; "" otherwise. Beats `status`. */
  readonly blocked: string;
  /** The session's working tree — differs per worktree within one repo. */
  readonly worktree: string;
  readonly branch: string;
  readonly intent: string;
  readonly lastSeenMs: number;
  readonly startedMs: number;
}

/** What a peer is called: the real session name when known, else the handle. */
export function displayName(s: Pick<Session, "name" | "handle">): string {
  return s.name !== "" ? s.name : s.handle;
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

export interface Claim {
  readonly handle: string;
  readonly path: string;
  /** The claimant's working tree — same tree means a real on-disk collision. */
  readonly worktree: string;
  readonly tsMs: number;
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
  // WAL survives across connections once set, but setting it every open is
  // cheap and means a deleted db file comes back correctly configured.
  db.exec("PRAGMA journal_mode = WAL");
  // Without a busy timeout a concurrent writer throws SQLITE_BUSY instead of
  // waiting; 5 s is far longer than any write here takes.
  db.exec("PRAGMA busy_timeout = 5000");
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
      last_read_id INTEGER NOT NULL DEFAULT 0
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
  `);
  return db;
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

export class Store {
  constructor(private readonly db: Database) {}

  /** Sessions seen recently enough to be plausibly alive, oldest first. */
  liveSessions(nowMs: number): Session[] {
    const rows = this.db
      .query(
        `SELECT session_id, handle, name, status, blocked, worktree, branch, intent,
                last_seen_ms, started_ms
           FROM sessions WHERE last_seen_ms > ? ORDER BY started_ms ASC`,
      )
      .all(nowMs - STALE_MS) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      sessionId: String(r["session_id"]),
      handle: String(r["handle"]),
      name: String(r["name"] ?? ""),
      status: String(r["status"] ?? ""),
      blocked: String(r["blocked"] ?? ""),
      worktree: String(r["worktree"]),
      branch: String(r["branch"]),
      intent: String(r["intent"]),
      lastSeenMs: Number(r["last_seen_ms"]),
      startedMs: Number(r["started_ms"]),
    }));
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

      // Every handle in the table, not just live ones: a stale row still owns
      // its name until pruned, and the UNIQUE index would reject a reuse.
      const taken = new Set(
        (this.db.query(`SELECT handle FROM sessions`).all() as Array<{ handle: string }>).map(
          (r) => r.handle,
        ),
      );
      const handle = HANDLES.find((h) => !taken.has(h)) ?? `agent-${sessionId.slice(0, 6)}`;
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

  setIntent(sessionId: string, intent: string): void {
    this.db.query(`UPDATE sessions SET intent = ? WHERE session_id = ?`).run(intent, sessionId);
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
    const exact = live.find((s) => s.name.toLowerCase() === q || s.handle.toLowerCase() === q);
    if (exact) return exact;
    const prefixed = live.filter(
      (s) => s.name.toLowerCase().startsWith(q) || s.handle.toLowerCase().startsWith(q),
    );
    // Ambiguous is not a match: silently picking one would send to the wrong peer.
    return prefixed.length === 1 ? (prefixed[0] ?? null) : null;
  }

  unregister(sessionId: string): void {
    this.db.query(`DELETE FROM claims WHERE session_id = ?`).run(sessionId);
    this.db.query(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
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
    const from = this.db
      .query(`SELECT name, handle FROM sessions WHERE handle = ?`)
      .get(handle) as { name: string; handle: string } | null;
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
   * "The conversation continues so Claude can act on it"). Routine `done` and
   * `claim` chatter must therefore never be delivered there: with several
   * sessions in one tree, each agent's turn-end announcement would extend every
   * other agent's turn, and two agents can bounce `done` lines off each other up
   * to the 8-continuation cap. A question actually addressed to this session is
   * worth continuing for; a peer's bookkeeping is not.
   *
   * The cursor advances only past what was DELIVERED, so a skipped `done` line
   * still arrives on the next prompt rather than being silently dropped.
   */
  drainDirected(sessionId: string): Message[] {
    const drain = this.db.transaction((): Message[] => {
      const cur = this.db
        .query(`SELECT handle, last_read_id FROM sessions WHERE session_id = ?`)
        .get(sessionId) as { handle: string; last_read_id: number } | null;
      if (!cur) return [];
      const rows = this.db
        .query(
          `SELECT id, ts_ms, handle, kind, body, to_session, from_name, to_name
             FROM messages
            WHERE id > ? AND handle != ?
              AND (to_session = '' OR to_session = ?)
              AND (kind = 'note' OR (kind = 'say' AND to_session = ?))
            ORDER BY id ASC`,
        )
        .all(cur.last_read_id, cur.handle, sessionId, sessionId) as Array<
        Record<string, string | number>
      >;
      if (rows.length === 0) return [];
      // Only past the last row actually handed over — undelivered chatter keeps
      // its place in the queue for the next prompt.
      const lastId = Number(rows[rows.length - 1]?.["id"] ?? cur.last_read_id);
      this.db
        .query(`UPDATE sessions SET last_read_id = ? WHERE session_id = ?`)
        .run(lastId, sessionId);
      return rows.map(toMessage);
    });
    return drain();
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
    return drain();
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

  claim(sessionId: string, path: string, nowMs: number): void {
    this.db
      .query(
        `INSERT INTO claims (path, session_id, ts_ms) VALUES (?, ?, ?)
           ON CONFLICT (path, session_id) DO UPDATE SET ts_ms = excluded.ts_ms`,
      )
      .run(path, sessionId, nowMs);
  }

  /** Claims on `path` held by OTHER live sessions. */
  conflictingClaims(sessionId: string, path: string, nowMs: number): Claim[] {
    const rows = this.db
      .query(
        `SELECT s.handle AS handle, s.worktree AS worktree, c.path AS path, c.ts_ms AS ts_ms
           FROM claims c JOIN sessions s ON s.session_id = c.session_id
          WHERE c.path = ? AND c.session_id != ? AND s.last_seen_ms > ?`,
      )
      .all(path, sessionId, nowMs - STALE_MS) as Array<Record<string, string | number>>;
    return rows.map(toClaim);
  }

  /** Every live claim, for the roster. */
  allClaims(nowMs: number): Claim[] {
    const rows = this.db
      .query(
        `SELECT s.handle AS handle, s.worktree AS worktree, c.path AS path, c.ts_ms AS ts_ms
           FROM claims c JOIN sessions s ON s.session_id = c.session_id
          WHERE s.last_seen_ms > ? ORDER BY c.ts_ms ASC`,
      )
      .all(nowMs - STALE_MS) as Array<Record<string, string | number>>;
    return rows.map(toClaim);
  }

  /** Drops rows for sessions that stopped heartbeating. */
  pruneStale(nowMs: number): void {
    const cutoff = nowMs - STALE_MS;
    this.db
      .query(
        `DELETE FROM claims WHERE session_id IN
           (SELECT session_id FROM sessions WHERE last_seen_ms <= ?)`,
      )
      .run(cutoff);
    this.db.query(`DELETE FROM sessions WHERE last_seen_ms <= ?`).run(cutoff);
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

function toClaim(r: Record<string, string | number>): Claim {
  return {
    handle: String(r["handle"]),
    path: String(r["path"]),
    worktree: String(r["worktree"]),
    tsMs: Number(r["ts_ms"]),
  };
}

export function agoText(fromMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((nowMs - fromMs) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}
