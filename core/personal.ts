/**
 * The personal diary: what one agent has learned about the OPERATOR.
 *
 * NOT facts about the code, which are shared. The test is "would another agent
 * be wrong to act on this?". Keyed on a LINEAGE (a name), not a conversation,
 * so memories outlive the transcript. Entries default to project-scoped, and
 * `global` marks the ones that travel. See docs/design-notes.md, "The personal
 * diary" — including why the operator can always read and delete it.
 */

import { Database } from "bun:sqlite";

import { BASE_DIR } from "./repo.ts";

/**
 * Deliberately outside `resolveProject`: this is the one store that is NOT
 * per-repo, and the resolver would silently make it so. `PRESENCE_TEST_DB`
 * still redirects it, so a test can never reach the real store.
 */
export function personalDbPath(): string {
  const test = process.env["PRESENCE_TEST_DB"] ?? "";
  if (test !== "") return `${test}.personal`;
  return `${BASE_DIR}/personal.db`;
}

export const MEMORY_TITLE_MAX = 200;
export const MEMORY_BODY_MAX = 2000;

export interface Memory {
  readonly id: number;
  readonly tsMs: number;
  /** The agent that learned it — its conversation uuid. Frozen, for history. */
  readonly sessionId: string;
  /** The agent's name when it wrote this, for the operator's benefit. */
  readonly agent: string;
  /**
   * The body of knowledge this belongs to: a lowercased agent name.
   *
   * What `forSession` filters on, so a successor adopting the lineage reads it.
   * Falls back to the session uuid when an agent has no name — which keeps the
   * old per-conversation behaviour rather than pooling every anonymous session
   * into one shared identity.
   */
  readonly lineage: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  /** Which repo it was learned in; "" for a global. */
  readonly project: string;
  /** True when it travels between repos. */
  readonly global: boolean;
}

export function createPersonalTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms      INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      agent      TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '',
      -- The repo this was learned in. Kept even on a global, because "where did
      -- I learn this" is the first question when one turns out to be wrong.
      project    TEXT NOT NULL DEFAULT '',
      is_global  INTEGER NOT NULL DEFAULT 0,
      -- The body of knowledge, not the conversation: a lowercased agent name.
      -- See the header. Empty only on rows written before this existed.
      lineage    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS memories_agent ON memories (session_id, id);
  `);
  // AFTER the table, never inside the CREATE above. `CREATE TABLE IF NOT
  // EXISTS` leaves an existing table alone, so on a live db the column arrives
  // only by migration -- and an index or query naming it inside that statement
  // would run against a column that is not there. This tool has already shipped
  // that exact bug once (`work.plan_doc`), and a fresh-db test cannot see it.
  addPersonalColumn(db, "lineage", "TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE INDEX IF NOT EXISTS memories_lineage ON memories (lineage, id)`);
}

/** `ALTER TABLE ADD COLUMN` guarded by what the table already has. */
function addPersonalColumn(db: Database, column: string, decl: string): void {
  const cols = db.query(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE memories ADD COLUMN ${column} ${decl}`);
}

/**
 * The lineage a name belongs to. Lowercased, so `Hopper` and `hopper` are one
 * body of knowledge. An empty name falls back to the uuid, keeping an anonymous
 * session private to itself rather than pooling every unnamed agent.
 */
export function lineageKey(name: string, sessionId: string): string {
  const n = name.trim().toLowerCase();
  return n === "" ? `session:${sessionId}` : n;
}

/** Opens the personal store, creating it on first use. */
export function withPersonal<T>(fn: (store: PersonalStore) => T): T {
  const db = new Database(personalDbPath(), { create: true });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    createPersonalTables(db);
    return fn(new PersonalStore(db));
  } finally {
    db.close();
  }
}

export type MemoryCheck =
  | { ok: true; title: string; body: string; tags: string[] }
  | { ok: false; why: string };

export function checkMemory(title: string, body: string, tags: readonly string[]): MemoryCheck {
  const t = title.trim().replace(/\s+/g, " ");
  if (t === "") return { ok: false, why: "a memory needs something to remember" };
  if ([...t].length > MEMORY_TITLE_MAX) {
    return {
      ok: false,
      why:
        `keep it to ${MEMORY_TITLE_MAX} characters or fewer (yours is ${[...t].length}) — ` +
        `this is injected at every session start, so it is paid for over and over. ` +
        `Put the detail in --body.`,
    };
  }
  const b = body.trim();
  if ([...b].length > MEMORY_BODY_MAX) {
    return { ok: false, why: `a body must be ${MEMORY_BODY_MAX} characters or fewer` };
  }
  const clean = [...new Set(tags.map((x) => x.trim().toLowerCase()).filter((x) => x !== ""))];
  return { ok: true, title: t, body: b, tags: clean.slice(0, 8) };
}

export class PersonalStore {
  constructor(private readonly db: Database) {}

  /**
   * `lineage` is passed in rather than derived from `agent`, because the writer
   * may be a DISCIPLE: vega writing under hopper's lineage stores `agent: vega`
   * (who learned it) and `lineage: hopper` (whose body of knowledge it joins).
   * Deriving one from the other would collapse that distinction.
   */
  remember(
    sessionId: string,
    agent: string,
    m: { title: string; body: string; tags: readonly string[] },
    project: string,
    isGlobal: boolean,
    nowMs: number,
    lineage: string,
  ): number {
    this.db
      .query(
        `INSERT INTO memories
           (ts_ms, session_id, agent, title, body, tags, project, is_global, lineage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        nowMs,
        sessionId,
        agent,
        m.title,
        m.body,
        m.tags.join(","),
        project,
        isGlobal ? 1 : 0,
        lineage,
      );
    return Number((this.db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
  }

  /**
   * What this agent should be told at session start: what it learned HERE, plus
   * everything it marked as travelling.
   *
   * The project filter is the whole reason the column exists. Without it an
   * agent carries one repo's specifics into another and acts on them
   * confidently — worse than not remembering at all.
   */
  forLineage(lineage: string, project: string, opts: { allProjects?: boolean } = {}): Memory[] {
    const rows = opts.allProjects
      ? (this.db
          .query(`SELECT * FROM memories WHERE lineage = ? ORDER BY id`)
          .all(lineage) as Array<Record<string, string | number>>)
      : (this.db
          .query(
            `SELECT * FROM memories WHERE lineage = ? AND (is_global = 1 OR project = ?)
              ORDER BY id`,
          )
          .all(lineage, project) as Array<Record<string, string | number>>);
    return rows.map(toMemory);
  }

  /**
   * What THIS CONVERSATION learned, by uuid, falling back to its lineage.
   *
   * The uuid is the durable key, so a rename cannot orphan knowledge. The
   * lineage arm is not legacy support: a disciple inherits by NAME, which the
   * uuid alone cannot express.
   */
  forConversation(
    sessionId: string,
    lineage: string,
    project: string,
    opts: { allProjects?: boolean } = {},
  ): Memory[] {
    const scope = opts.allProjects ? `` : ` AND (is_global = 1 OR project = ?)`;
    const args: Array<string> = opts.allProjects
      ? [sessionId, lineage]
      : [sessionId, lineage, project];
    const rows = this.db
      .query(
        `SELECT * FROM memories WHERE (session_id = ? OR (lineage != '' AND lineage = ?))${scope}
          ORDER BY id`,
      )
      .all(...args) as Array<Record<string, string | number>>;
    return rows.map(toMemory);
  }

  /** Lineages with anything recorded, newest first — what `inherit` picks from. */
  lineages(): Array<{ lineage: string; agents: string[]; count: number; lastMs: number }> {
    const rows = this.db
      .query(
        `SELECT lineage, COUNT(*) AS n, MAX(ts_ms) AS last,
                GROUP_CONCAT(DISTINCT agent) AS who
           FROM memories WHERE lineage != '' GROUP BY lineage ORDER BY last DESC`,
      )
      .all() as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      lineage: String(r["lineage"]),
      agents: String(r["who"] ?? "")
        .split(",")
        .filter((a) => a !== ""),
      count: Number(r["n"]),
      lastMs: Number(r["last"]),
    }));
  }

  get(id: number): Memory | null {
    const r = this.db.query(`SELECT * FROM memories WHERE id = ?`).get(id) as Record<
      string,
      string | number
    > | null;
    return r ? toMemory(r) : null;
  }

  /**
   * How many memories exist at all, for `crew stats`.
   *
   * Not derived by summing `lineages()`, which is the obvious shortcut and is
   * wrong: that query filters `lineage != ''`, so every row written before the
   * lineage column existed would be silently dropped from a total whose whole
   * job is to say whether the feature has ever been used.
   */
  count(): number {
    const r = this.db.query(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number } | null;
    return Number(r?.n ?? 0);
  }

  /**
   * DELETES, where the shared diary deprecates. A wrong belief about a PERSON
   * is injected every session and compounds, and a tombstone would let an agent
   * still read what it was told to forget.
   */
  forget(id: number): boolean {
    return this.db.query(`DELETE FROM memories WHERE id = ?`).run(id).changes > 0;
  }
}

function toMemory(r: Record<string, string | number>): Memory {
  return {
    id: Number(r["id"]),
    tsMs: Number(r["ts_ms"]),
    sessionId: String(r["session_id"]),
    agent: String(r["agent"]),
    title: String(r["title"]),
    body: String(r["body"]),
    tags: String(r["tags"])
      .split(",")
      .filter((t) => t !== ""),
    project: String(r["project"]),
    global: Number(r["is_global"]) === 1,
    lineage: String(r["lineage"] ?? ""),
  };
}
