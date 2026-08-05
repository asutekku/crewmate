import type { Database } from "bun:sqlite";
import { Database as SqliteDatabase } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Message, MessageKind } from "./types.ts";

export interface StoreDiagnostic {
  readonly subsystem: "message-probe";
  readonly detail: string;
}

/** Fast fail-open probe; expected absence and operational failure stay distinct. */
export function hasUnreadMessages(
  dbPath: string,
  sessionId: string,
  diagnostic: (event: StoreDiagnostic) => void = (event) => console.error(event.detail),
): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    const db = new SqliteDatabase(dbPath, { readonly: true });
    try {
      const row = db.query(
        `SELECT EXISTS(
           SELECT 1 FROM messages m JOIN sessions s ON s.session_id = ?1
            WHERE m.id > s.last_read_id AND m.handle != s.handle
              AND (m.to_session = '' OR m.to_session = ?1)
         ) AS any_unread`,
      ).get(sessionId) as { any_unread: number } | null;
      return (row?.any_unread ?? 0) === 1;
    } finally {
      db.close();
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    diagnostic({ subsystem: "message-probe", detail: `message probe degraded: ${detail}` });
    return false;
  }
}

function toMessage(row: Record<string, string | number>): Message {
  return {
    id: Number(row["id"]),
    tsMs: Number(row["ts_ms"]),
    from: String(row["from_name"] || row["handle"]),
    to: String(row["to_name"] ?? ""),
    kind: String(row["kind"]) as MessageKind,
    body: String(row["body"]),
  };
}

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Message persistence and cursor delivery. No identity or rendering policy lives here. */
export class MessageStore {
  constructor(
    private readonly db: Database,
    private readonly maxMessages: number,
    private readonly claimReannounceMs: number,
  ) {}

  post(
    handle: string,
    kind: MessageKind,
    body: string,
    nowMs: number,
    to?: { readonly sessionId: string; readonly name: string },
  ): void {
    const from = this.db.query(
      `SELECT CASE WHEN alias != '' THEN alias WHEN handle != '' THEN handle ELSE name END AS label
         FROM sessions WHERE handle = ?`,
    ).get(handle) as { label: string } | null;
    this.db.query(
      `INSERT INTO messages (ts_ms, handle, kind, body, to_session, from_name, to_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(nowMs, handle, kind, body, to?.sessionId ?? "", from?.label ?? handle, to?.name ?? "");
    this.db.query(
      `DELETE FROM messages WHERE id <= (SELECT MAX(id) - ? FROM messages)`,
    ).run(this.maxMessages);
  }

  /**
   * Only messages addressed deliberately — directed anything, plus human `note`.
   * At `Stop` an injection CONTINUES the turn, so routine broadcasts delivered
   * here would let peers extend each other's turns to the 8-continuation cap.
   */
  drainDirected(sessionId: string): Message[] {
    const drain = this.db.transaction((): Message[] => {
      const cursor = this.db.query(
        `SELECT handle, last_read_id FROM sessions WHERE session_id = ?`,
      ).get(sessionId) as { handle: string; last_read_id: number } | null;
      if (!cursor) return [];
      const deliverable = `id > ?1 AND handle != ?2 AND (to_session = '' OR to_session = ?3)`;
      const rows = this.db.query(
        `SELECT id, ts_ms, handle, kind, body, to_session, from_name, to_name
           FROM messages WHERE ${deliverable} AND (kind = 'note' OR to_session = ?3)
          ORDER BY id ASC`,
      ).all(cursor.last_read_id, cursor.handle, sessionId) as Array<Record<string, string | number>>;
      if (rows.length === 0) return [];
      const skipped = this.db.query(
        `SELECT MIN(id) AS id FROM messages WHERE ${deliverable}
          AND NOT (kind = 'note' OR to_session = ?3)`,
      ).get(cursor.last_read_id, cursor.handle, sessionId) as { id: number | null } | null;
      // The cursor stops BELOW the first skipped row: one monotonic integer
      // cannot say "delivered 7 but not 6", so advancing past 6 buries it.
      const lastDelivered = Number(rows[rows.length - 1]?.["id"] ?? cursor.last_read_id);
      const advanceTo = skipped?.id == null
        ? lastDelivered
        : Math.min(lastDelivered, skipped.id - 1);
      if (advanceTo > cursor.last_read_id) {
        this.db.query(`UPDATE sessions SET last_read_id = ? WHERE session_id = ?`)
          .run(advanceTo, sessionId);
      }
      return rows.map(toMessage);
    });
    return drain.immediate();
  }

  drainUnread(sessionId: string): Message[] {
    const drain = this.db.transaction((): Message[] => {
      const cursor = this.db.query(
        `SELECT handle, last_read_id FROM sessions WHERE session_id = ?`,
      ).get(sessionId) as { handle: string; last_read_id: number } | null;
      if (!cursor) return [];
      const rows = this.db.query(
        `SELECT id, ts_ms, handle, kind, body, to_session, from_name, to_name
           FROM messages WHERE id > ? AND handle != ?
            AND (to_session = '' OR to_session = ?) ORDER BY id ASC`,
      ).all(cursor.last_read_id, cursor.handle, sessionId) as Array<Record<string, string | number>>;
      const maximum = this.db.query(`SELECT COALESCE(MAX(id), 0) AS id FROM messages`).get() as { id: number };
      this.db.query(`UPDATE sessions SET last_read_id = ? WHERE session_id = ?`)
        .run(maximum.id, sessionId);
      return rows.map(toMessage);
    });
    return drain.immediate();
  }

  recent(limit: number, forSession?: string): Message[] {
    const rows = this.db.query(
      `SELECT id, ts_ms, handle, kind, body, to_session, from_name, to_name
         FROM messages WHERE ?1 IS NULL OR to_session = '' OR to_session = ?1
        ORDER BY id DESC LIMIT ?2`,
    ).all(forSession ?? null, limit) as Array<Record<string, string | number>>;
    return rows.map(toMessage).reverse();
  }

  lastDoneMs(handle: string, sinceMs: number): number {
    const row = this.db.query(
      `SELECT MAX(ts_ms) AS value FROM messages
        WHERE handle = ? AND kind = 'done' AND ts_ms >= ?`,
    ).get(handle, sinceMs) as { value: number | null } | null;
    return Math.max(Number(row?.value ?? 0), sinceMs);
  }

  announcedOverlapRecently(handle: string, path: string, nowMs: number): boolean {
    return this.db.query(
      `SELECT 1 AS hit FROM messages WHERE handle = ? AND kind = 'claim' AND ts_ms > ?
        AND body LIKE ? ESCAPE '\\' LIMIT 1`,
    ).get(handle, nowMs - this.claimReannounceMs, `also editing ${likeEscape(path)} %`) !== null;
  }
}
