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
 * KEYED ON THE SESSION ID, which is the conversation uuid and survives a
 * restart. Hopper's read of the operator is not Luna's, deliberately — that is
 * the feature, not a limitation to design around.
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
  /** The agent that learned it — its conversation uuid. */
  readonly sessionId: string;
  /** The agent's name when it wrote this, for the operator's benefit. */
  readonly agent: string;
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
      is_global  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memories_agent ON memories (session_id, id);
  `);
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

  remember(
    sessionId: string,
    agent: string,
    m: { title: string; body: string; tags: readonly string[] },
    project: string,
    isGlobal: boolean,
    nowMs: number,
  ): number {
    this.db
      .query(
        `INSERT INTO memories (ts_ms, session_id, agent, title, body, tags, project, is_global)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nowMs, sessionId, agent, m.title, m.body, m.tags.join(","), project, isGlobal ? 1 : 0);
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
  forSession(sessionId: string, project: string, opts: { allProjects?: boolean } = {}): Memory[] {
    const rows = opts.allProjects
      ? (this.db
          .query(`SELECT * FROM memories WHERE session_id = ? ORDER BY id`)
          .all(sessionId) as Array<Record<string, string | number>>)
      : (this.db
          .query(
            `SELECT * FROM memories WHERE session_id = ? AND (is_global = 1 OR project = ?)
              ORDER BY id`,
          )
          .all(sessionId, project) as Array<Record<string, string | number>>);
    return rows.map(toMemory);
  }

  /** Every agent that has recorded something, so the operator can audit them. */
  agents(): Array<{ sessionId: string; agent: string; count: number }> {
    const rows = this.db
      .query(
        `SELECT session_id, agent, COUNT(*) AS n FROM memories
          GROUP BY session_id ORDER BY MAX(ts_ms) DESC`,
      )
      .all() as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      sessionId: String(r["session_id"]),
      agent: String(r["agent"]),
      count: Number(r["n"]),
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
  };
}
