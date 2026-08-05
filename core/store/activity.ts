import type { Database } from "bun:sqlite";
import type { Claim } from "./types.ts";

export interface EditSummary {
  readonly path: string;
  readonly tsMs: number;
  readonly worktree: string;
  readonly tool: string;
  readonly count: number;
}

export interface LiveMinion {
  readonly agentId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly task: string;
  readonly agentType: string;
  readonly startedMs: number;
}

/** Read models over append-only edit and minion activity. */
export class ActivityStore {
  constructor(
    private readonly db: Database,
    private readonly minionStaleMs: number,
    private readonly staleMs: number,
  ) {}

  editsBy(sessionId: string, sinceMs: number, limit: number): EditSummary[] {
    const rows = this.db.query(
      `WITH ranked AS (
         SELECT path, ts_ms, worktree, tool, id,
                COUNT(*) OVER (PARTITION BY path) AS n,
                ROW_NUMBER() OVER (PARTITION BY path ORDER BY ts_ms DESC, id DESC) AS position
           FROM edits WHERE session_id = ? AND ts_ms > ?
       )
       SELECT path, ts_ms, worktree, tool, n FROM ranked WHERE position = 1
        ORDER BY ts_ms DESC, id DESC LIMIT ?`,
    ).all(sessionId, sinceMs, limit) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      path: String(row["path"]),
      tsMs: Number(row["ts_ms"]),
      worktree: String(row["worktree"] ?? ""),
      tool: String(row["tool"] ?? ""),
      count: Number(row["n"] ?? 1),
    }));
  }

  liveMinions(nowMs: number): Map<string, LiveMinion[]> {
    const rows = this.db.query(
      `SELECT agent_id, session_id, seq, task, agent_type, started_ms
         FROM minions WHERE ended_ms = 0 AND started_ms > ? ORDER BY seq`,
    ).all(nowMs - this.minionStaleMs) as Array<Record<string, string | number>>;
    const byParent = new Map<string, LiveMinion[]>();
    for (const row of rows) {
      const minion: LiveMinion = {
        agentId: String(row["agent_id"]), sessionId: String(row["session_id"]),
        seq: Number(row["seq"]), task: String(row["task"]),
        agentType: String(row["agent_type"]), startedMs: Number(row["started_ms"]),
      };
      const siblings = byParent.get(minion.sessionId);
      if (siblings) siblings.push(minion);
      else byParent.set(minion.sessionId, [minion]);
    }
    return byParent;
  }

  upsertTask(sessionId: string, taskId: string, subject: string, nowMs: number): void {
    this.db.query(
      `INSERT INTO tasks (session_id, task_id, subject, created_ms) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, task_id) DO UPDATE SET subject = excluded.subject`,
    ).run(sessionId, taskId, subject, nowMs);
  }

  completeTask(sessionId: string, taskId: string, nowMs: number): void {
    this.db.query(`UPDATE tasks SET completed_ms = ? WHERE session_id = ? AND task_id = ?`)
      .run(nowMs, sessionId, taskId);
  }

  taskCounts(): Map<string, { open: number; done: number }> {
    const rows = this.db.query(
      `SELECT session_id,
              SUM(CASE WHEN completed_ms = 0 THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN completed_ms > 0 THEN 1 ELSE 0 END) AS done
         FROM tasks GROUP BY session_id`,
    ).all() as Array<Record<string, string | number>>;
    return new Map(rows.map((row) => [String(row["session_id"]), {
      open: Number(row["open"]), done: Number(row["done"]),
    }]));
  }

  claim(
    sessionId: string,
    path: string,
    nowMs: number,
    detail?: { readonly tool?: string; readonly worktree?: string; readonly branch?: string },
  ): void {
    const claim = this.db.transaction(() => {
      this.db.query(
        `INSERT INTO claims (path, session_id, ts_ms) VALUES (?, ?, ?)
         ON CONFLICT (path, session_id) DO UPDATE SET ts_ms = excluded.ts_ms`,
      ).run(path, sessionId, nowMs);
      const session = this.db.query(
        `SELECT CASE WHEN alias != '' THEN alias WHEN handle != '' THEN handle ELSE name END AS agent,
                worktree, branch FROM sessions WHERE session_id = ?`,
      ).get(sessionId) as { agent: string; worktree: string; branch: string } | null;
      this.db.query(
        `INSERT INTO edits (ts_ms, path, session_id, agent, worktree, branch, tool)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        nowMs, path, sessionId, session?.agent ?? "",
        detail?.worktree ?? session?.worktree ?? "",
        detail?.branch ?? session?.branch ?? "", detail?.tool ?? "",
      );
    });
    claim.immediate();
  }

  editsOf(path: string, limit: number): Array<{
    agent: string; sessionId: string; tsMs: number; worktree: string; tool: string;
  }> {
    const rows = this.db.query(
      `SELECT * FROM edits WHERE path = ? ORDER BY ts_ms DESC, id DESC LIMIT ?`,
    ).all(path, limit) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      agent: String(row["agent"] ?? ""), sessionId: String(row["session_id"]),
      tsMs: Number(row["ts_ms"]), worktree: String(row["worktree"] ?? ""),
      tool: String(row["tool"] ?? ""),
    }));
  }

  editAgents(sinceMs: number): Array<{ agent: string; sessionId: string; lastMs: number }> {
    const rows = this.db.query(
      `SELECT agent, session_id, MAX(ts_ms) AS last_ms FROM edits
        WHERE ts_ms > ? AND agent != '' GROUP BY session_id ORDER BY MAX(ts_ms) DESC`,
    ).all(sinceMs) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      agent: String(row["agent"]), sessionId: String(row["session_id"]),
      lastMs: Number(row["last_ms"]),
    }));
  }

  startMinion(
    agentId: string, sessionId: string, nowMs: number,
    options: { readonly task?: string; readonly agentType?: string },
  ): number {
    const start = this.db.transaction(() => {
      const current = this.db.query(`SELECT seq FROM minions WHERE agent_id = ?`)
        .get(agentId) as { seq: number } | null;
      if (current) return current.seq;
      const next = this.db.query(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM minions WHERE session_id = ?`,
      ).get(sessionId) as { seq: number };
      this.db.query(
        `INSERT INTO minions (agent_id, session_id, seq, task, agent_type, started_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(agentId, sessionId, next.seq, options.task ?? "", options.agentType ?? "", nowMs);
      return next.seq;
    });
    return start.immediate();
  }

  endMinion(agentId: string, nowMs: number, task?: string): void {
    if (task !== undefined && task !== "") {
      this.db.query(
        `UPDATE minions SET ended_ms = ?, task = CASE WHEN task = '' THEN ? ELSE task END
          WHERE agent_id = ? AND ended_ms = 0`,
      ).run(nowMs, task, agentId);
      return;
    }
    this.db.query(`UPDATE minions SET ended_ms = ? WHERE agent_id = ? AND ended_ms = 0`)
      .run(nowMs, agentId);
  }

  minionCounts(nowMs: number): Map<string, number> {
    const rows = this.db.query(
      `SELECT session_id, COUNT(*) AS count FROM minions
        WHERE ended_ms = 0 AND started_ms > ? GROUP BY session_id`,
    ).all(nowMs - this.minionStaleMs) as Array<Record<string, string | number>>;
    return new Map(rows.map((row) => [String(row["session_id"]), Number(row["count"])]));
  }

  pruneMinions(nowMs: number, keepMs: number): void {
    this.db.query(`DELETE FROM minions WHERE ended_ms > 0 AND ended_ms <= ?`).run(nowMs - keepMs);
    this.db.query(`UPDATE minions SET ended_ms = ? WHERE ended_ms = 0 AND started_ms <= ?`)
      .run(nowMs, nowMs - this.minionStaleMs);
  }

  releaseClaim(sessionId: string, path: string): void {
    this.db.query(`DELETE FROM claims WHERE session_id = ? AND path = ?`).run(sessionId, path);
  }

  conflictingClaims(sessionId: string, path: string, nowMs: number, claimTtlMs: number): Claim[] {
    return this.claimRows(
      `c.path = ? AND c.session_id != ? AND s.last_seen_ms > ? AND c.ts_ms > ?`,
      [path, sessionId, nowMs - this.staleMs, nowMs - claimTtlMs],
    );
  }

  claimsSince(sessionId: string, sinceMs: number): string[] {
    const rows = this.db.query(
      `SELECT path FROM claims WHERE session_id = ? AND ts_ms >= ? ORDER BY ts_ms ASC`,
    ).all(sessionId, sinceMs) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  allClaims(nowMs: number, claimTtlMs: number): Claim[] {
    return this.claimRows(
      `s.last_seen_ms > ? AND c.ts_ms > ?`,
      [nowMs - this.staleMs, nowMs - claimTtlMs],
    );
  }

  private claimRows(where: string, parameters: Array<string | number>): Claim[] {
    const rows = this.db.query(
      `SELECT c.session_id, s.handle,
              CASE WHEN s.alias != '' THEN s.alias ELSE s.name END AS name,
              s.worktree, c.path, c.ts_ms
         FROM claims c JOIN sessions s ON s.session_id = c.session_id
        WHERE ${where} ORDER BY c.ts_ms ASC`,
    ).all(...parameters) as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      sessionId: String(row["session_id"]), handle: String(row["handle"]),
      name: String(row["name"] ?? ""), path: String(row["path"]),
      worktree: String(row["worktree"]), tsMs: Number(row["ts_ms"]),
    }));
  }
}
