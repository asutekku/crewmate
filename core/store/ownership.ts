/**
 * WHO OWNS A NAME: a name belongs to a conversation for as long as that
 * conversation exists on disk (user ruling, 2026-08-05). Resume after a month
 * and the same agent answers, because the conversation IS the agent.
 *
 * Replaces a 60 h hold that answered two questions with one number: "may a
 * stranger take this name yet?" (a pool question, rightly bounded) and "is this
 * returning conversation still hopper?" (identity, which must never expire).
 * MEASURED: session c5ce05bc was reaped after 90 idle minutes and came back
 * 68 h later as `akari`, mid-conversation.
 *
 * The transcript is the source of truth rather than a timestamp: it exists
 * exactly as long as the conversation is resumable, so deleting a conversation
 * is what frees its name, and the ledger cannot outgrow what is on disk.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import type { Database } from "bun:sqlite";

/**
 * Conversation ids with a transcript on disk. One readdir, not a stat per row.
 *
 * EMPTY MEANS "COULD NOT TELL", never "nobody": callers must keep names
 * reserved, since releasing the ledger on an unreadable path would rename every
 * agent at once.
 */
export function liveConversations(projectDir: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const entry of readdirSync(projectDir)) {
      if (entry.endsWith(".jsonl")) ids.add(entry.slice(0, -".jsonl".length).toLowerCase());
    }
  } catch {
    // Missing or unreadable: report "unknown" and let the caller keep names.
  }
  return ids;
}

/**
 * Where Claude Code keeps this project's transcripts: the absolute path with
 * every non-alphanumeric run collapsed to a dash. Derived rather than taken
 * from a payload because `pruneStale` needs it with no payload in hand.
 */
export function projectTranscriptDir(projectRoot: string): string {
  const base = process.env["CLAUDE_CONFIG_DIR"] ?? `${homedir()}/.claude`;
  // ONE DASH PER CHARACTER, not one per run. Claude Code replaces each
  // character it does not keep, so `I:/Projects/Traffic` is
  // `I--Projects-Traffic` — the `:` and the `/` each get a dash. Collapsing the
  // run with `+` gave `I-Projects-Traffic`, which matched no directory that has
  // ever existed: measured 2026-08-05, every folder under `~/.claude/projects`
  // uses the doubled form, and this function had therefore NEVER resolved. It
  // fails silently — `liveConversations` reads a missing directory as "none",
  // which `owners.release` treats as "unknown" and keeps every name.
  const slug = projectRoot.replace(/[^a-zA-Z0-9]/g, "-");
  return `${base}/projects/${slug}`;
}

/** The directory holding a transcript. Preferred over deriving the slug. */
export function transcriptDir(transcriptPath: string): string {
  if (transcriptPath === "") return "";
  const cut = Math.max(transcriptPath.lastIndexOf("/"), transcriptPath.lastIndexOf("\\"));
  return cut > 0 ? transcriptPath.slice(0, cut) : "";
}

/** A name, and the conversation that owns it. */
export interface Ownership {
  readonly sessionId: string;
  readonly name: string;
}

/**
 * The name ledger: one row per conversation that has ever been named.
 *
 * Distinct from `aliases`, which records only a name chosen by hand and is
 * empty for most agents (measured: 11 rows against 593 conversations).
 */
export class OwnershipStore {
  constructor(private readonly db: Database) {}

  /** `INSERT OR REPLACE`: a later rename is the name to come back to. */
  claim(sessionId: string, name: string, nowMs: number): void {
    const normalized = name.trim().toLowerCase();
    if (sessionId === "" || normalized === "") return;
    this.db.query(
      `INSERT OR REPLACE INTO name_owners (session_id, name, claimed_ms) VALUES (?, ?, ?)`,
    ).run(sessionId, normalized, nowMs);
  }

  /**
   * Seeds the ledger from names already recorded elsewhere.
   *
   * Without it every conversation predating the ledger loses its name once —
   * the bug, reintroduced by the fix. Idempotent, so it runs on every open.
   *
   * ONE NAME, ONE OWNER — enforced HERE, because the table cannot. `session_id`
   * is the primary key and `name` carries only a non-unique index, so nothing
   * in the schema stops two conversations holding one name; `INSERT OR IGNORE`
   * deduplicates SESSIONS and is blind to that. History is full of reused
   * names: measured 2026-08-05 on this repo's live db, one backfill seeded 11
   * rows in a single millisecond and gave `akira` to two different sessions,
   * which rendered as two separate agents on the board, each with its own work.
   *
   * Newest claim wins, matching `claim()` — a name belongs to the conversation
   * that answered to it most recently, and the older one has moved on.
   */
  backfill(nowMs: number): number {
    const seed = this.db.transaction((): number => {
      const insert = this.db.query(
        `INSERT OR IGNORE INTO name_owners (session_id, name, claimed_ms) VALUES (?, ?, ?)`,
      );
      let added = 0;
      // Oldest first, so where two sources disagree the newest write survives.
      const rows = this.db.query(
        `SELECT session_id, alias AS name, ts_ms FROM aliases WHERE alias != ''
          UNION ALL
         SELECT session_id, CASE WHEN alias != '' THEN alias ELSE handle END, last_seen_ms
           FROM sessions
          ORDER BY ts_ms ASC`,
      ).all() as Array<{ session_id: string; name: string }>;
      const claimed = new Map<string, string>();
      for (const row of this.db
        .query(`SELECT session_id, name FROM name_owners`)
        .all() as Array<{ session_id: string; name: string }>) {
        claimed.set(row.name, row.session_id);
      }
      for (const row of rows) {
        if (row.session_id === "" || row.name === "") continue;
        const name = row.name.toLowerCase();
        const holder = claimed.get(name);
        if (holder !== undefined && holder !== row.session_id) continue;
        const changes = insert.run(row.session_id, name, nowMs).changes;
        if (changes > 0) claimed.set(name, row.session_id);
        added += changes;
      }
      return added;
    });
    return seed.immediate();
  }

  /**
   * Drops all but the newest owner of any name held more than once.
   *
   * Repairs ledgers seeded before `backfill` enforced the invariant. Runs on
   * open beside `backfill`, and is a no-op on a healthy ledger.
   */
  dedupe(): number {
    const fix = this.db.transaction((): number => {
      // ROW_NUMBER over each name, newest first; everything after the first
      // goes. Written as a window function rather than a correlated subquery
      // because the obvious `WHERE inner.name = outer.name` form rebinds `name`
      // to the inner scope and matched EVERY row — it deleted a name that had
      // only one owner, which a two-name fixture caught immediately.
      const dropped = this.db
        .query(
          `DELETE FROM name_owners WHERE rowid IN (
             SELECT rowid FROM (
               SELECT rowid, ROW_NUMBER() OVER (
                        PARTITION BY name ORDER BY claimed_ms DESC, rowid DESC
                      ) AS rank
                 FROM name_owners
             ) WHERE rank > 1)`,
        )
        .run();
      return dropped.changes;
    });
    return fix.immediate();
  }

  /** The name this conversation last answered to, or "" if it never had one. */
  nameFor(sessionId: string): string {
    const row = this.db.query(`SELECT name FROM name_owners WHERE session_id = ?`)
      .get(sessionId) as { name: string } | null;
    return row?.name ?? "";
  }

  /**
   * Names spoken for, because the conversation holding each still exists.
   * An empty `live` set means unreadable, so every ledgered name stays held.
   */
  reserved(live: ReadonlySet<string>): Set<string> {
    const names = new Set<string>();
    const rows = this.db.query(`SELECT session_id, name FROM name_owners`).all() as Array<
      { session_id: string; name: string }
    >;
    const unknown = live.size === 0;
    for (const row of rows) {
      if (row.name === "") continue;
      if (unknown || live.has(row.session_id.toLowerCase())) names.add(row.name.toLowerCase());
    }
    return names;
  }

  /**
   * Drops rows whose conversation is gone from disk — the only way a name
   * returns to the pool. Never runs on an empty `live` set (see above).
   */
  release(live: ReadonlySet<string>): number {
    if (live.size === 0) return 0;
    const rows = this.db.query(`SELECT session_id FROM name_owners`).all() as Array<
      { session_id: string }
    >;
    const gone = rows.map((r) => r.session_id).filter((id) => !live.has(id.toLowerCase()));
    if (gone.length === 0) return 0;
    const drop = this.db.query(`DELETE FROM name_owners WHERE session_id = ?`);
    const run = this.db.transaction(() => {
      for (const id of gone) drop.run(id);
    });
    run.immediate();
    return gone.length;
  }

  /** Every ledgered ownership, newest claim first. */
  all(): Ownership[] {
    return (this.db.query(
      `SELECT session_id, name FROM name_owners ORDER BY claimed_ms DESC`,
    ).all() as Array<{ session_id: string; name: string }>).map((r) => ({
      sessionId: r.session_id,
      name: r.name,
    }));
  }
}
