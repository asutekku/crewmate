/**
 * The personal diary: what one agent has learned about the operator.
 *
 * NOT facts about the code — those are shared, and putting one here hides it
 * from everyone. The test is: WOULD ANOTHER AGENT BE WRONG TO ACT ON THIS?
 * Yes, it is personal ("hands me rendering changes to check visually rather
 * than screenshotting"). No, it belongs in the shared diary.
 *
 * ONE DB, OUTSIDE THE PER-PROJECT FILES, which is the only piece of new
 * plumbing in the diary work. Everything else the tool stores is per-repo,
 * because everything else is about a repo; this is about a PERSON, and a
 * preference they stated in one project is usually true in the next.
 *
 * But not always — "run the water tests alone, this box is loaded" is about
 * this machine and this project. So every entry carries the project it was
 * learned in, and `global` marks the ones that travel. Default is
 * project-scoped: a preference carried into the wrong repo is acted on
 * confidently and wrongly, which is worse than not remembering it.
 *
 * KEYED ON A LINEAGE, NOT A CONVERSATION. Hopper's read of the operator is not
 * Luna's — that part is deliberate and stays. But a conversation uuid is the
 * wrong grain for it: delete the transcript and the agent is gone, so memories
 * keyed on the uuid die with the one thing guaranteed not to outlive them. The
 * operator said it plainly: starting a new roadworks session when a roadworks
 * agent already exists "might create a completely new empty state that has to
 * learn everything from scratch".
 *
 * A LINEAGE IS A NAME. Not a new synthetic id — `aliases` already maps uuid to
 * name durably (it survives `pruneStale`, which drops `sessions` rows at 90
 * minutes), a name is held for 60 h against four sources, and a name is what
 * the operator types and remembers. Adding a second identifier beside it would
 * be a column that has to be kept in sync with the one that already works.
 *
 * `session_id` stays on every row untouched, frozen at write time, so "which
 * conversation learned this" is still answerable after that conversation is
 * gone — the same split the diary and `edits` already use.
 *
 * READABLE BY THE OPERATOR. `about-me` shows what an agent believes about
 * them, and `forget` is as easy to reach as `remember`. A private model of a
 * person that the person cannot read is the one shape this must not take.
 */

import { Database } from "bun:sqlite";

import { BASE_DIR } from "./repo.ts";

/**
 * Deliberately outside `resolveProject`: this is the one store that is NOT
 * per-repo, and routing it through the project resolver would silently make it
 * per-repo again.
 *
 * `PRESENCE_TEST_DB` still redirects it, for the same reason it redirects
 * everything else — a test that reaches the real store is how the live roster
 * got polluted with fake agents once already.
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
 * The lineage a name belongs to.
 *
 * Lowercased so `Hopper` and `hopper` are one body of knowledge — names are
 * matched case-insensitively everywhere else in this tool, and two lineages
 * differing only in case would be invisible to the operator who typed them.
 * Empty name falls back to the uuid, keeping an anonymous session private to
 * itself rather than pooling every unnamed agent together.
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
   * DELETES, where the shared diary deprecates.
   *
   * The asymmetry is deliberate. A shared finding that stopped being true is
   * still history worth keeping — somebody believed it for a reason. A wrong
   * belief about a PERSON has no such value: it is injected every session, it
   * compounds, and the operator asked for it gone. Keeping a tombstone would
   * mean an agent could still read what it was told to forget.
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
