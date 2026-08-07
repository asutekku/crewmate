/**
 * What a session leaves behind when its roster row goes.
 *
 * A crashed terminal is the case this exists for: the operator wants the
 * conversation back, and by then the row is deleted -- a clean exit removes it,
 * the stale sweep reaps it. The name ledger already outlives the session, but it
 * holds a name and nothing about the WORK, so it cannot answer "which session
 * was doing the battlepasses?".
 */

import type { Database } from "bun:sqlite";

/** One conversation the roster no longer shows. */
export interface PastSession {
  readonly sessionId: string;
  readonly handle: string;
  readonly alias: string;
  readonly role: string;
  readonly worktree: string;
  readonly branch: string;
  readonly title: string;
  readonly summary: string;
  readonly transcript: string;
  readonly startedMs: number;
  readonly endedMs: number;
}

function rowToPast(row: Record<string, string | number>): PastSession {
  return {
    sessionId: String(row["session_id"]), handle: String(row["handle"] ?? ""),
    alias: String(row["alias"] ?? ""), role: String(row["role"] ?? ""),
    worktree: String(row["worktree"] ?? ""), branch: String(row["branch"] ?? ""),
    title: String(row["title"] ?? ""), summary: String(row["summary"] ?? ""),
    transcript: String(row["transcript"] ?? ""),
    startedMs: Number(row["started_ms"] ?? 0), endedMs: Number(row["ended_ms"] ?? 0),
  };
}

export class PastSessionStore {
  constructor(private readonly db: Database) {}

  /**
   * Copies a live row into the archive. Call INSIDE the deleting transaction,
   * while the row is still readable.
   *
   * `INSERT OR REPLACE`: a conversation that ran, ended and was resumed archives
   * again, and the later record is the true one.
   */
  archive(sessionId: string, nowMs: number): void {
    this.db.query(
      `INSERT OR REPLACE INTO past_sessions
         (session_id, handle, alias, role, worktree, branch, title, summary,
          transcript, started_ms, ended_ms)
       SELECT session_id, handle, alias, role, worktree, branch, title, summary,
              transcript, started_ms, ?
         FROM sessions WHERE session_id = ?`,
    ).run(nowMs, sessionId);
  }

  /** Archives every row the stale sweep is about to delete, in one statement. */
  archiveStale(cutoffMs: number, nowMs: number): void {
    this.db.query(
      `INSERT OR REPLACE INTO past_sessions
         (session_id, handle, alias, role, worktree, branch, title, summary,
          transcript, started_ms, ended_ms)
       SELECT session_id, handle, alias, role, worktree, branch, title, summary,
              transcript, started_ms, ?
         FROM sessions WHERE last_seen_ms <= ?`,
    ).run(nowMs, cutoffMs);
  }

  find(sessionId: string): PastSession | null {
    const row = this.db.query(`SELECT * FROM past_sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, string | number> | null;
    return row ? rowToPast(row) : null;
  }

  /** Every archived conversation, newest first. */
  all(): PastSession[] {
    return (this.db.query(
      `SELECT * FROM past_sessions ORDER BY ended_ms DESC`,
    ).all() as Array<Record<string, string | number>>).map(rowToPast);
  }
}
