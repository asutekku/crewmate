/**
 * Questions: a message you can answer.
 *
 * WHY NOT A MESSAGE WITH A FLAG. `msg` is fire-and-forget, and that is right
 * for "waterSim.ts is mine for the next hour". It is wrong for "have you
 * finished with roadSection?", where the sender needs a reply and needs to know
 * when one is not coming. A question has STATE -- asked, answered, expired --
 * and a table with state is a different table. Bolting a nullable answer column
 * onto every chat line, or storing a reply as a second row that has to find its
 * parent, are both worse than one small table that says what it is.
 *
 * IT MUST EXPIRE, and that is the part worth getting right. A question aimed at
 * a session that then dies would otherwise sit open forever, and the tool has
 * already shipped one row nobody ever closed: `asked_turn_ms` had a column and a
 * setter and NO CALLER for months, so every work item dangled on the board.
 * Here the rule is explicit -- a question whose target has been gone longer than
 * the staleness window is reported back to the asker as unanswerable, rather
 * than quietly remaining "open" and meaning nothing.
 *
 * NEVER BLOCKING. Nothing waits for an answer. Questions arrive as ordinary
 * context at a prompt boundary like every other piece of peer news, because a
 * hook that waited would stall a turn on a peer that may never reply.
 */

import type { Database } from "bun:sqlite";

/** Cap on a question, so one cannot become an essay nobody reads. */
export const QUESTION_MAX = 500;

/** Cap on an answer. Generous: the answer is the payload. */
export const ANSWER_MAX = 2000;

export type QuestionState = "open" | "answered" | "expired";

export interface Question {
  readonly id: number;
  readonly askerSession: string;
  /** Frozen at ask time — the log must still read after that session exits. */
  readonly askerName: string;
  readonly targetSession: string;
  readonly targetName: string;
  readonly text: string;
  readonly answer: string;
  readonly askedMs: number;
  /** 0 while unanswered. */
  readonly answeredMs: number;
  /** 0 unless the target went away without answering. */
  readonly expiredMs: number;
  /** True once the asker has been shown the answer or the expiry. */
  readonly deliveredMs: number;
}

export function createQuestionTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS questions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      asker_session  TEXT NOT NULL,
      -- Names FROZEN at ask time, exactly as message senders are: resolving
      -- them at read time blanks out every historical row the moment a session
      -- exits, which is precisely when the log is read.
      asker_name     TEXT NOT NULL DEFAULT '',
      target_session TEXT NOT NULL,
      target_name    TEXT NOT NULL DEFAULT '',
      text           TEXT NOT NULL,
      answer         TEXT NOT NULL DEFAULT '',
      asked_ms       INTEGER NOT NULL,
      answered_ms    INTEGER NOT NULL DEFAULT 0,
      expired_ms     INTEGER NOT NULL DEFAULT 0,
      -- When the ASKER was shown the outcome. Without this the answer is
      -- delivered on every prompt for the rest of the session, which is how a
      -- helpful line becomes noise that gets skipped.
      delivered_ms   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS questions_target ON questions (target_session, answered_ms, expired_ms);
    CREATE INDEX IF NOT EXISTS questions_asker ON questions (asker_session, delivered_ms);
  `);
}

function rowToQuestion(r: Record<string, string | number>): Question {
  return {
    id: Number(r["id"]),
    askerSession: String(r["asker_session"]),
    askerName: String(r["asker_name"] ?? ""),
    targetSession: String(r["target_session"]),
    targetName: String(r["target_name"] ?? ""),
    text: String(r["text"]),
    answer: String(r["answer"] ?? ""),
    askedMs: Number(r["asked_ms"]),
    answeredMs: Number(r["answered_ms"] ?? 0),
    expiredMs: Number(r["expired_ms"] ?? 0),
    deliveredMs: Number(r["delivered_ms"] ?? 0),
  };
}

export function questionState(q: Question): QuestionState {
  if (q.answeredMs > 0) return "answered";
  if (q.expiredMs > 0) return "expired";
  return "open";
}

/** Trims and caps, so storage never holds what rendering cannot show. */
export function clampText(raw: string, max: number): string {
  const s = raw.trim().replace(/\s+/g, " ");
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

export class QuestionStore {
  constructor(private readonly db: Database) {}

  ask(
    askerSession: string,
    askerName: string,
    targetSession: string,
    targetName: string,
    text: string,
    nowMs: number,
  ): number {
    this.db
      .query(
        `INSERT INTO questions (asker_session, asker_name, target_session, target_name, text, asked_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        askerSession,
        askerName,
        targetSession,
        targetName,
        clampText(text, QUESTION_MAX),
        nowMs,
      );
    return Number(
      (
        this.db.query(`SELECT last_insert_rowid() AS id`).get() as {
          id: number;
        }
      ).id,
    );
  }

  get(id: number): Question | null {
    const row = this.db
      .query(`SELECT * FROM questions WHERE id = ?`)
      .get(id) as Record<string, string | number> | null;
    return row ? rowToQuestion(row) : null;
  }

  /**
   * Answers a question. Returns false if it is unknown or already resolved.
   *
   * ANSWERING AN EXPIRED QUESTION IS ALLOWED and lands as a normal answer: the
   * target may simply have been slow, and refusing the reply would throw away
   * the very thing the asker wanted over a timer that exists to prevent
   * *silence*, not to prevent late honesty. Only a second answer is refused.
   */
  answer(id: number, text: string, nowMs: number): boolean {
    const run = this.db.transaction((): boolean => {
      const q = this.get(id);
      if (!q || q.answeredMs > 0) return false;
      this.db
        .query(
          `UPDATE questions SET answer = ?, answered_ms = ?, expired_ms = 0 WHERE id = ?`,
        )
        .run(clampText(text, ANSWER_MAX), nowMs, id);
      return true;
    });
    return run();
  }

  /** Authenticated answer transition: validation and mutation share one transaction. */
  answerFor(
    id: number,
    targetSession: string,
    text: string,
    nowMs: number,
  ):
    | { readonly ok: true; readonly question: Question }
    | {
        readonly ok: false;
        readonly kind: "not_found" | "wrong_target" | "already_answered";
        readonly question?: Question;
      } {
    const run = this.db.transaction(() => {
      const question = this.get(id);
      if (!question) return { ok: false, kind: "not_found" } as const;
      if (question.targetSession !== targetSession)
        return { ok: false, kind: "wrong_target", question } as const;
      if (question.answeredMs > 0)
        return { ok: false, kind: "already_answered", question } as const;
      this.db
        .query(
          `UPDATE questions SET answer = ?, answered_ms = ?, expired_ms = 0 WHERE id = ?`,
        )
        .run(clampText(text, ANSWER_MAX), nowMs, id);
      return { ok: true, question } as const;
    });
    return run.immediate();
  }

  /** Expires stale rows, then returns both ordered open views for one session. */
  openSnapshot(
    sessionId: string,
    nowMs: number,
    staleMs: number,
  ): {
    readonly mine: readonly Question[];
    readonly waiting: readonly Question[];
  } {
    this.expireStale(nowMs, staleMs);
    return {
      mine: this.openFor(sessionId),
      waiting: this.pendingFrom(sessionId),
    };
  }

  /** Open questions aimed at this session, oldest first. */
  openFor(targetSession: string): Question[] {
    const rows = this.db
      .query(
        `SELECT * FROM questions
          WHERE target_session = ? AND answered_ms = 0 AND expired_ms = 0
          ORDER BY id ASC`,
      )
      .all(targetSession) as Array<Record<string, string | number>>;
    return rows.map(rowToQuestion);
  }

  /** Everything this session asked that is still waiting on someone. */
  pendingFrom(askerSession: string): Question[] {
    const rows = this.db
      .query(
        `SELECT * FROM questions
          WHERE asker_session = ? AND answered_ms = 0 AND expired_ms = 0
          ORDER BY id ASC`,
      )
      .all(askerSession) as Array<Record<string, string | number>>;
    return rows.map(rowToQuestion);
  }

  /**
   * Resolved questions the asker has not been shown yet, marking them delivered.
   *
   * READ-THEN-WRITE IN ONE IMMEDIATE TRANSACTION. Two hooks firing at once
   * would otherwise both read the same undelivered row and both report it, which
   * is the same race the message drain already guards.
   */
  drainResolved(askerSession: string, nowMs: number): Question[] {
    const run = this.db.transaction((): Question[] => {
      const rows = this.db
        .query(
          `SELECT * FROM questions
            WHERE asker_session = ? AND delivered_ms = 0
              AND (answered_ms > 0 OR expired_ms > 0)
            ORDER BY id ASC`,
        )
        .all(askerSession) as Array<Record<string, string | number>>;
      const found = rows.map(rowToQuestion);
      if (found.length === 0) return [];
      this.db
        .query(
          `UPDATE questions SET delivered_ms = ? WHERE id IN (${found.map(() => "?").join(",")})`,
        )
        .run(nowMs, ...found.map((q) => q.id));
      // Same correction as `expireStale`: the rows were read before the UPDATE,
      // so `deliveredMs` on them would otherwise read 0 -- "not yet delivered"
      // on the very rows being delivered.
      return found.map((q) => ({ ...q, deliveredMs: nowMs }));
    });
    return run.immediate();
  }

  /**
   * Expires questions whose target has gone quiet, returning what was expired.
   *
   * THE TARGET'S LIVENESS DECIDES, not the question's age. A question asked two
   * hours ago of an agent that is still working is still a live question; one
   * asked a minute ago of a session that has since exited is already dead. Age
   * alone would get both backwards.
   */
  expireStale(nowMs: number, staleMs: number): Question[] {
    const run = this.db.transaction((): Question[] => {
      const rows = this.db
        .query(
          `SELECT q.* FROM questions q
             LEFT JOIN sessions s ON s.session_id = q.target_session
            WHERE q.answered_ms = 0 AND q.expired_ms = 0
              AND (s.session_id IS NULL OR s.last_seen_ms < ?)`,
        )
        .all(nowMs - staleMs) as Array<Record<string, string | number>>;
      const found = rows.map(rowToQuestion);
      if (found.length === 0) return [];
      this.db
        .query(
          `UPDATE questions SET expired_ms = ? WHERE id IN (${found.map(() => "?").join(",")})`,
        )
        .run(nowMs, ...found.map((q) => q.id));
      // Returned with the expiry APPLIED. The rows were read before the UPDATE,
      // so handing them back as-is would report every freshly expired question
      // as still `open` -- a caller asking `questionState` on the result of
      // `expireStale` would be told the opposite of what just happened.
      return found.map((q) => ({ ...q, expiredMs: nowMs }));
    });
    return run.immediate();
  }

  /** Drops resolved-and-delivered questions past their keep window. */
  prune(nowMs: number, keepMs: number): number {
    const res = this.db
      .query(
        `DELETE FROM questions
          WHERE delivered_ms > 0 AND (answered_ms > 0 OR expired_ms > 0)
            AND COALESCE(NULLIF(answered_ms, 0), expired_ms) < ?`,
      )
      .run(nowMs - keepMs);
    return res.changes;
  }
}
