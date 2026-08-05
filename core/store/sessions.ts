import type { Database } from "bun:sqlite";
import type { Session } from "./types.ts";
import { pickName } from "../names.ts";
import { liveConversations, OwnershipStore } from "./ownership.ts";

export const SESSION_COLUMNS = `session_id, handle, name, alias, role, status, blocked, worktree, branch,
  behind_base, base_branch, lineage_from, intent, title, summary, summary_ms, last_seen_ms, started_ms`;

export function rowToSession(row: Record<string, string | number>): Session {
  return {
    sessionId: String(row["session_id"]), handle: String(row["handle"]),
    name: String(row["name"] ?? ""), alias: String(row["alias"] ?? ""),
    role: String(row["role"] ?? ""), status: String(row["status"]),
    blocked: String(row["blocked"]), worktree: String(row["worktree"]),
    branch: String(row["branch"]), behindBase: Number(row["behind_base"] ?? -1),
    baseBranch: String(row["base_branch"] ?? ""), lineageFrom: String(row["lineage_from"] ?? ""),
    intent: String(row["intent"]), title: String(row["title"] ?? ""),
    summary: String(row["summary"] ?? ""), summaryMs: Number(row["summary_ms"] ?? 0),
    lastSeenMs: Number(row["last_seen_ms"]), startedMs: Number(row["started_ms"]),
  };
}

/** Session identity, liveness, aliases, and roster metadata. */
export class SessionStore {
  private readonly owners: OwnershipStore;

  constructor(
    private readonly db: Database,
    private readonly staleMs: number,
    /** Transcript dir for the ownership check; empty keeps every name held. */
    private readonly transcriptDirPath = "",
  ) {
    this.owners = new OwnershipStore(db);
  }

  register(sessionId: string, worktree: string, branch: string, nowMs: number): string {
    // Outside the transaction: a readdir over hundreds of files does not belong
    // inside a write lock several starting sessions contend for.
    const liveIds = liveConversations(this.transcriptDirPath);
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

      // What a stranger may not take: names owned by a surviving conversation,
      // plus names in use right now (covering rows with no ledger entry). The
      // old activity windows measured how recently an agent had TYPED.
      const taken = new Set<string>();
      for (const r of this.db.query(`SELECT handle, alias FROM sessions`).all() as Array<{
        handle: string;
        alias: string;
      }>) {
        taken.add(r.handle.toLowerCase());
        if (r.alias !== "") taken.add(r.alias.toLowerCase());
      }
      for (const name of this.owners.reserved(liveIds)) taken.add(name);

      // A returning conversation keeps its name permanently: the roster row is
      // always gone by now (clean exit deletes it, pruneStale reaps it), so the
      // ledger is what remembers, keyed on the uuid. See ownership.ts.
      const mine = this.owners.nameFor(sessionId);
      // Should be unreachable now that `taken` holds every reserved name, but
      // two agents on one name makes `msg` ambiguous — and a restored backup
      // can genuinely disagree with the ledger.
      const heldByPeer =
        mine !== "" &&
        this.db
          .query(
            `SELECT 1 FROM sessions WHERE session_id != ?
              AND (LOWER(handle) = LOWER(?) OR LOWER(alias) = LOWER(?)) LIMIT 1`,
          )
          .get(sessionId, mine, mine) !== null;
      const handle = mine !== "" && !heldByPeer ? mine : pickName(taken);
      this.db
        .query(
          `INSERT INTO sessions
             (session_id, handle, worktree, branch, intent, last_seen_ms, started_ms, last_read_id)
           VALUES (?, ?, ?, ?, '', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages))`,
        )
        .run(sessionId, handle, worktree, branch, nowMs, nowMs);
      // Every assignment, not just hand-picked names — the half `aliases` never
      // did, and why it cannot answer "who was this conversation?".
      this.owners.claim(sessionId, handle, nowMs);
      return handle;
    });
    // IMMEDIATE, not DEFERRED: a deferred transaction still starts read-only and
    // upgrades at the INSERT, which is exactly the window this must close.
    return claim.immediate();
  }

  live(nowMs: number): Session[] {
    return (this.db.query(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE last_seen_ms > ? ORDER BY started_ms ASC`,
    ).all(nowMs - this.staleMs) as Array<Record<string, string | number>>).map(rowToSession);
  }

  /** Heartbeat. Clears `blocked` too: a session doing something is not stuck. */
  touch(sessionId: string, nowMs: number): void {
    this.db.query(`UPDATE sessions SET last_seen_ms = ?, blocked = '' WHERE session_id = ?`)
      .run(nowMs, sessionId);
  }

  handleFor(sessionId: string): string | null {
    const row = this.db.query(`SELECT handle FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { handle: string } | null;
    return row?.handle ?? null;
  }

  setWorktree(sessionId: string, worktree: string, branch: string): void {
    this.db.query(`UPDATE sessions SET worktree = ?, branch = ? WHERE session_id = ?`)
      .run(worktree, branch, sessionId);
  }

  setBaseDistance(sessionId: string, behind: number, base: string): void {
    this.db.query(`UPDATE sessions SET behind_base = ?, base_branch = ? WHERE session_id = ?`)
      .run(behind, base, sessionId);
  }

  setLineage(sessionId: string, from: string): void {
    this.db.query(`UPDATE sessions SET lineage_from = ? WHERE session_id = ?`)
      .run(from.trim().toLowerCase(), sessionId);
  }

  liveHolder(lineage: string, nowMs: number): Session | null {
    const key = lineage.trim().toLowerCase();
    if (key === "") return null;
    const row = this.db.query(
      `SELECT ${SESSION_COLUMNS} FROM sessions
        WHERE last_seen_ms > ?
          AND (LOWER(handle) = ? OR LOWER(alias) = ? OR LOWER(lineage_from) = ?)
        ORDER BY last_seen_ms DESC LIMIT 1`,
    ).get(nowMs - this.staleMs, key, key, key) as Record<string, string | number> | null;
    return row ? rowToSession(row) : null;
  }

  worktreeOf(sessionId: string): string | null {
    const row = this.db.query(`SELECT worktree FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { worktree: string } | null;
    return row?.worktree ?? null;
  }

  setIntent(sessionId: string, intent: string): void {
    this.db.query(`UPDATE sessions SET intent = ? WHERE session_id = ?`).run(intent, sessionId);
  }

  setAlias(sessionId: string, alias: string, nowMs: number): string | null {
    const normalized = alias.trim();
    if (normalized === "" || /\s/.test(normalized)) return null;
    const set = this.db.transaction((): string | null => {
      const taken = this.db.query(
        `SELECT 1 FROM sessions WHERE last_seen_ms > ? AND session_id != ?
          AND (LOWER(alias) = LOWER(?) OR LOWER(handle) = LOWER(?)
               OR (alias = '' AND LOWER(name) = LOWER(?))) LIMIT 1`,
      ).get(nowMs - this.staleMs, sessionId, normalized, normalized, normalized);
      if (taken) return null;
      this.db.query(`UPDATE sessions SET alias = ? WHERE session_id = ?`).run(normalized, sessionId);
      this.db.query(
        `INSERT OR REPLACE INTO aliases (session_id, alias, ts_ms) VALUES (?, ?, ?)`,
      ).run(sessionId, normalized, nowMs);
      // A name chosen by hand is the STRONGEST ownership claim there is, so the
      // ledger follows it. Without this the conversation would come back under
      // the handle it was assigned rather than the name it picked.
      this.owners.claim(sessionId, normalized, nowMs);
      return normalized;
    });
    return set.immediate();
  }

  setRole(sessionId: string, role: string): void {
    this.db.query(`UPDATE sessions SET role = ? WHERE session_id = ?`).run(role, sessionId);
  }

  setTitle(sessionId: string, title: string): void {
    this.db.query(`UPDATE sessions SET title = ? WHERE session_id = ?`).run(title, sessionId);
  }

  restoreAlias(sessionId: string, nowMs: number): string | null {
    const restore = this.db.transaction((): string | null => {
      const self = this.db.query(`SELECT alias FROM sessions WHERE session_id = ?`)
        .get(sessionId) as { alias: string } | null;
      if (!self || self.alias !== "") return null;
      const prior = this.db.query(`SELECT alias FROM aliases WHERE session_id = ?`)
        .get(sessionId) as { alias: string } | null;
      if (!prior || prior.alias === "") return null;
      const held = this.db.query(
        `SELECT 1 FROM sessions WHERE session_id != ? AND last_seen_ms > ?
          AND (LOWER(alias) = LOWER(?) OR LOWER(handle) = LOWER(?)
               OR (alias = '' AND LOWER(name) = LOWER(?))) LIMIT 1`,
      ).get(sessionId, nowMs - this.staleMs, prior.alias, prior.alias, prior.alias);
      if (held) return null;
      this.db.query(`UPDATE sessions SET alias = ? WHERE session_id = ?`).run(prior.alias, sessionId);
      return prior.alias;
    });
    return restore.immediate();
  }

  setTranscript(sessionId: string, path: string): void {
    this.db.query(`UPDATE sessions SET transcript = ? WHERE session_id = ?`).run(path, sessionId);
  }

  transcriptOf(sessionId: string): string {
    const row = this.db.query(`SELECT transcript FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { transcript: string } | null;
    return row?.transcript ?? "";
  }

  setSummary(sessionId: string, summary: string, nowMs: number): void {
    this.db.query(`UPDATE sessions SET summary = ?, summary_ms = ? WHERE session_id = ?`)
      .run(summary, nowMs, sessionId);
  }

  staleSummaries(nowMs: number, ttlMs: number): Array<{ sessionId: string; path: string }> {
    return this.db.query(
      `SELECT session_id AS sessionId, transcript AS path FROM sessions
        WHERE last_seen_ms > ? AND transcript != '' AND summary_ms <= ? ORDER BY summary_ms ASC`,
    ).all(nowMs - this.staleMs, nowMs - ttlMs) as Array<{ sessionId: string; path: string }>;
  }

  setBlocked(sessionId: string, blocked: string): void {
    this.db.query(`UPDATE sessions SET blocked = ? WHERE session_id = ?`).run(blocked, sessionId);
  }

  syncAgents(agents: ReadonlyArray<{ sessionId: string; name: string; status: string }>): void {
    const update = this.db.query(`UPDATE sessions SET name = ?, status = ? WHERE session_id = ?`);
    const sync = this.db.transaction(() => {
      for (const agent of agents) update.run(agent.name, agent.status, agent.sessionId);
    });
    sync.immediate();
  }

  findByName(query: string, nowMs: number): Session | null {
    const sessions = this.live(nowMs);
    const needle = query.toLowerCase();
    const exact = sessions.filter((session) =>
      session.alias.toLowerCase() === needle || session.name.toLowerCase() === needle ||
      session.handle.toLowerCase() === needle);
    if (exact.length === 1) return exact[0] ?? null;
    if (exact.length > 1) return null;
    const prefixes = sessions.filter((session) =>
      session.alias.toLowerCase().startsWith(needle) || session.name.toLowerCase().startsWith(needle) ||
      session.handle.toLowerCase().startsWith(needle));
    return prefixes.length === 1 ? prefixes[0] ?? null : null;
  }

  findBySession(sessionId: string): Session | null {
    const row = this.db.query(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
      .get(sessionId) as Record<string, string | number> | null;
    return row ? rowToSession(row) : null;
  }

  unregister(sessionId: string, nowMs: number): void {
    const row = this.db.query(`SELECT handle, alias FROM sessions WHERE session_id = ?`)
      .get(sessionId) as { handle: string; alias: string } | null;
    const remembered = row ? row.alias || row.handle : "";
    if (remembered !== "") {
      this.db.query(
        `INSERT OR REPLACE INTO aliases (session_id, alias, ts_ms) VALUES (?, ?, ?)`,
      ).run(sessionId, remembered, nowMs);
    }
    this.db.query(`DELETE FROM claims WHERE session_id = ?`).run(sessionId);
    this.db.query(`DELETE FROM tasks WHERE session_id = ?`).run(sessionId);
    this.db.query(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
  }
}
