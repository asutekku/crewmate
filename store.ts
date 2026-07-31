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

/** Handles are for humans reading a roster, so they are short and pronounceable. */
const HANDLES = [
  "ada",
  "turing",
  "hopper",
  "lovelace",
  "knuth",
  "dijkstra",
  "ritchie",
  "thompson",
] as const;

export type MessageKind = "status" | "claim" | "release" | "done" | "note";

export interface Session {
  readonly sessionId: string;
  readonly handle: string;
  /** The session's working tree — differs per worktree within one repo. */
  readonly worktree: string;
  readonly branch: string;
  readonly intent: string;
  readonly lastSeenMs: number;
  readonly startedMs: number;
}

export interface Message {
  readonly id: number;
  readonly tsMs: number;
  readonly handle: string;
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
      worktree     TEXT NOT NULL,
      branch       TEXT NOT NULL DEFAULT '',
      intent       TEXT NOT NULL DEFAULT '',
      last_seen_ms INTEGER NOT NULL,
      started_ms   INTEGER NOT NULL,
      last_read_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms     INTEGER NOT NULL,
      handle    TEXT NOT NULL,
      kind      TEXT NOT NULL,
      body      TEXT NOT NULL
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
        `SELECT session_id, handle, worktree, branch, intent, last_seen_ms, started_ms
           FROM sessions WHERE last_seen_ms > ? ORDER BY started_ms ASC`,
      )
      .all(nowMs - STALE_MS) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      sessionId: String(r["session_id"]),
      handle: String(r["handle"]),
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
   */
  register(sessionId: string, worktree: string, branch: string, nowMs: number): string {
    const existing = this.db
      .query(`SELECT handle FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { handle: string } | null;
    if (existing) {
      this.db
        .query(`UPDATE sessions SET last_seen_ms = ?, worktree = ?, branch = ? WHERE session_id = ?`)
        .run(nowMs, worktree, branch, sessionId);
      return existing.handle;
    }

    const taken = new Set(this.liveSessions(nowMs).map((s) => s.handle));
    const handle =
      HANDLES.find((h) => !taken.has(h)) ?? `agent${(taken.size + 1).toString()}`;
    this.db
      .query(
        `INSERT INTO sessions
           (session_id, handle, worktree, branch, intent, last_seen_ms, started_ms, last_read_id)
         VALUES (?, ?, ?, ?, '', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
      )
      .run(sessionId, handle, worktree, branch, nowMs, nowMs);
    return handle;
  }

  /**
   * A new session's cursor starts at the current max id, so it is not shown a
   * backlog of chatter that predates it — `register` does this inline above.
   * Recent history is surfaced separately by `recent()`, which is a deliberate
   * one-off summary rather than unread mail.
   */
  touch(sessionId: string, nowMs: number): void {
    this.db.query(`UPDATE sessions SET last_seen_ms = ? WHERE session_id = ?`).run(nowMs, sessionId);
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

  unregister(sessionId: string): void {
    this.db.query(`DELETE FROM claims WHERE session_id = ?`).run(sessionId);
    this.db.query(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
  }

  post(handle: string, kind: MessageKind, body: string, nowMs: number): void {
    this.db
      .query(`INSERT INTO messages (ts_ms, handle, kind, body) VALUES (?, ?, ?, ?)`)
      .run(nowMs, handle, kind, body);
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
  drainUnread(sessionId: string): Message[] {
    const drain = this.db.transaction((): Message[] => {
      const cur = this.db
        .query(`SELECT handle, last_read_id FROM sessions WHERE session_id = ?`)
        .get(sessionId) as { handle: string; last_read_id: number } | null;
      if (!cur) return [];
      const rows = this.db
        .query(
          `SELECT id, ts_ms, handle, kind, body FROM messages
             WHERE id > ? AND handle != ? ORDER BY id ASC`,
        )
        .all(cur.last_read_id, cur.handle) as Array<Record<string, string | number>>;
      // Advance past every message in the range, including this session's own
      // filtered-out lines, or they are re-scanned on every turn forever.
      const maxId = this.db.query(`SELECT COALESCE(MAX(id), 0) AS m FROM messages`).get() as {
        m: number;
      };
      this.db
        .query(`UPDATE sessions SET last_read_id = ? WHERE session_id = ?`)
        .run(maxId.m, sessionId);
      return rows.map((r) => ({
        id: Number(r["id"]),
        tsMs: Number(r["ts_ms"]),
        handle: String(r["handle"]),
        kind: String(r["kind"]) as MessageKind,
        body: String(r["body"]),
      }));
    });
    return drain();
  }

  /** Last few log lines regardless of cursor — the joining-a-room summary. */
  recent(limit: number): Message[] {
    const rows = this.db
      .query(`SELECT id, ts_ms, handle, kind, body FROM messages ORDER BY id DESC LIMIT ?`)
      .all(limit) as Array<Record<string, string | number>>;
    return rows
      .map((r) => ({
        id: Number(r["id"]),
        tsMs: Number(r["ts_ms"]),
        handle: String(r["handle"]),
        kind: String(r["kind"]) as MessageKind,
        body: String(r["body"]),
      }))
      .reverse();
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
