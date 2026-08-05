/**
 * The shared diary: findings agents write for each other, searchable by topic,
 * tag and folder.
 *
 * WHY IT IS IN THE DB AND NOT IN MARKDOWN. Claude Code keys its memory
 * directory on the WORKING directory, so an agent in a worktree writes to a
 * directory nobody reads and which dies with the branch — measured 2026-08-01,
 * all 46 of this repo's worktree memory dirs are empty, while CLAUDE.md tells
 * agents to take a worktree for any large feature. The presence db is resolved
 * per-REPO (`resolveProject` keys on `--git-common-dir`, identical across every
 * worktree), so a finding written in a worktree is readable from the main tree
 * and from every other worktree. That is the hole this closes.
 *
 * It follows that no entry carries a project id: the db IS the project, and a
 * column would be the filename stored inside the file.
 *
 * THE BOARD IS NOT THIS. `work.ts` answers "what is happening now" and prunes
 * after a week, deliberately. This answers "has anyone hit this before".
 */

import type { Database } from "bun:sqlite";

import { loadConfig } from "./config.ts";

/**
 * What kind of thing an entry is. Deliberately closed, not a free string: a
 * `warning` interrupts an edit and a `finding` does not, so the set has to be
 * closed for the reader to mean anything by it.
 *
 * `decision` records what was CHOSEN, which is a different claim from a
 * `finding`'s what is TRUE — "we use pipes over cellular automata" is not
 * falsifiable the way "waterSurface is -Infinity when dry" is. It is the manual
 * path; a choice settled through structured acts is folded from the obligation
 * events instead (see `decisionsFrom` in core/obligations.ts).
 */
export type DiaryKind = "finding" | "warning" | "error" | "optimization" | "decision";

export const DIARY_KINDS: readonly DiaryKind[] = [
  "finding",
  "warning",
  "error",
  "optimization",
  "decision",
];

/**
 * The kinds worth interrupting an edit for; see `hooks/pre-edit.ts`.
 *
 * A decision is NOT here on purpose. Interrupting an edit is the most intrusive
 * surface this tool has, and a decision is not an error — it rides the quiet
 * scope-matched path with findings.
 */
export const LOUD_KINDS: readonly DiaryKind[] = ["warning", "error"];

/**
 * A title is one sentence that makes a CLAIM, and this cap is measured rather
 * than guessed.
 *
 * The 137 notes in this repo's memory dir each carry a one-line description;
 * across them the length is median 140, p90 193, max 362, min 85 (measured
 * 2026-08-01). Nobody wrote a two-word title even with no rule asking them not
 * to. So 200 fits what agents actually write and only bites the outliers — a
 * "keep it short, 60 chars" rule would have fought every real example.
 */
export const TITLE_MAX = 200;

/**
 * The body is optional detail, read on demand. This cap is a runaway guard, not
 * a style rule: it exists so one entry cannot become a document.
 */
export const BODY_MAX = 2000;

/** Belt and braces on the tag list; the real limit is that tags are for finding. */
export const MAX_TAGS = 8;

/**
 * How old a live entry gets before `diary check` calls it unverified.
 *
 * NOT an expiry — the entry stays, stays searchable, and is probably still
 * true. It is a prompt to re-check, because a claim about code that nobody has
 * looked at in three months is a different kind of thing from one made last
 * week, and saying so is cheaper than letting a reader guess.
 */
export const STALE_ENTRY_MS = 90 * 24 * 60 * 60 * 1000;

/** Something wrong with the diary as a whole, with the command that fixes it. */
export interface DiaryProblem {
  readonly kind:
    | "near-duplicate-topic"
    | "dangling-reference"
    | "unscoped"
    | "deprecated-without-reason"
    | "unverified";
  readonly detail: string;
  /** A command the reader can actually run. Empty when there is nothing to run. */
  readonly fix: string;
}

export interface DiaryEntry {
  readonly id: number;
  readonly tsMs: number;
  /** Frozen at write time, resolved to the live name when the author is around. */
  readonly agent: string;
  readonly sessionId: string;
  readonly title: string;
  readonly body: string;
  readonly topic: string;
  readonly tags: readonly string[];
  readonly kind: DiaryKind;
  /** Tree-relative folder this is about; "" means repo-wide. */
  readonly scope: string;
  /** When it stopped being true; 0 while it still is. */
  readonly deprecatedMs: number;
  /** Why it stopped being true. Required when deprecating — see `deprecate`. */
  readonly deprecatedWhy: string;
  /** The entry that replaced this one, or 0. */
  readonly supersededBy: number;
  /**
   * The entry recording the fix, or 0 while unfixed.
   *
   * Only meaningful on `kind: "error"`. A finding has no open state — it is a
   * fact, not a task — so `fix` refuses anything else.
   */
  readonly fixedBy: number;
  /** When it was fixed; 0 while open. */
  readonly fixedMs: number;
}

export function createDiaryTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS diary (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms        INTEGER NOT NULL,
      -- The author's name at write time, kept as a FALLBACK exactly as the work
      -- board does it: an entry read after that session exits must still say who
      -- wrote it, while an author who renames itself should still be credited
      -- under the name people now use. Queries prefer live, fall back to this.
      agent        TEXT NOT NULL DEFAULT '',
      session_id   TEXT NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL DEFAULT '',
      topic        TEXT NOT NULL,
      -- Comma-wrapped (",a,b,") so a LIKE on ",tag," cannot match a prefix of a
      -- longer tag. A join table would be tidier and is not worth a second table
      -- for a list that is capped at 8 and never queried on its own.
      tags         TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT 'finding',
      scope        TEXT NOT NULL DEFAULT '',
      deprecated_ms INTEGER NOT NULL DEFAULT 0,
      deprecated_why TEXT NOT NULL DEFAULT '',
      superseded_by INTEGER NOT NULL DEFAULT 0,
      -- WHAT SEPARATES A BUG LIST FROM A LOG: state. A finding is true forever,
      -- a bug is open until something fixes it. Only kind='error' carries this
      -- -- a finding has no open state, and offering one invites an agent to
      -- "close" a piece of knowledge.
      --
      -- Deliberately NOT auto-closed from a commit: a quiet commit prints
      -- nothing, so a sha-triggered close would work sometimes and silently
      -- miss the rest, and a bug list that closes bugs at random is worse than
      -- one that closes none.
      fixed_by     INTEGER NOT NULL DEFAULT 0,
      fixed_ms     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS diary_topic ON diary (topic, id);
    -- What pre-edit hits on every Edit/Write. Scope first because that is the
    -- equality term; deprecated so the common "live entries only" filter is in
    -- the index rather than a scan.
    CREATE INDEX IF NOT EXISTS diary_scope ON diary (scope, deprecated_ms, id);
    CREATE INDEX IF NOT EXISTS diary_author ON diary (session_id, id);

    -- Search over title AND body, so a body that explains the evidence is
    -- findable by the words in it even when the title does not carry them.
    -- content= makes this an EXTERNAL CONTENT index: the text lives once, in
    -- diary, and FTS stores only the terms. Without it every entry is stored
    -- twice and the two copies can disagree after an update.
    CREATE VIRTUAL TABLE IF NOT EXISTS diary_fts USING fts5(
      title, body, topic, tags,
      content='diary', content_rowid='id', tokenize='porter unicode61'
    );
  `);
}

/** A topic or tag: one lowercase word, hyphens allowed. */
export function normaliseTerm(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  for (const piece of raw.split(",")) {
    const t = normaliseTerm(piece);
    if (t !== "") seen.add(t);
  }
  return [...seen].slice(0, MAX_TAGS);
}

/** `",a,b,"` — see the schema note on why tags are wrapped. */
export function packTags(tags: readonly string[]): string {
  return tags.length === 0 ? "" : `,${tags.join(",")},`;
}

export function unpackTags(packed: string): string[] {
  return packed.split(",").filter((t) => t !== "");
}

/**
 * A tree-relative folder. A FILE path is accepted and reduced to its directory,
 * because an agent that just edited `src/sim/water/flow.ts` will naturally pass
 * that, and refusing it teaches nothing.
 */
export function normaliseScope(raw: string, looksLikeFile = /[^/.]\.[a-z0-9]+$/i): string {
  const s = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (s === "" || s === ".") return "";
  // A TOP-LEVEL DOTTED NAME REDUCES TO REPO-WIDE, and that is correct for the
  // common case (`README.md`, `package.json`) and wrong for the rare one (a
  // folder actually named `my.module`). The text cannot tell them apart, so
  // `crew note` REPORTS the reduction rather than resolving it — see the
  // "no --scope" line there. Scoping `README.md` to a folder named `README.md`
  // would match no file at all, which is strictly worse than repo-wide.
  return looksLikeFile.test(s) ? s.split("/").slice(0, -1).join("/") : s;
}

/**
 * Every folder an entry could be scoped to for this path, nearest LAST.
 *
 * This is what makes `pre-edit` affordable: the candidates are the path's own
 * prefixes, so the lookup is a handful of indexed equality tests bounded by
 * path depth — not a LIKE scan over every entry. Verified 2026-08-01:
 * `src/sim/water/flow.ts` and `src/sim/water/sources/spring.ts` both match a
 * `src/sim/water` entry, `src/sim/traffic/engine.ts` does not.
 *
 * "" is included and means repo-wide.
 */
export function scopeCandidates(path: string): string[] {
  const clean = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = clean.split("/").filter((p) => p !== "");
  const out = [""];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Whether two topics are near enough that one is probably meant to be the other.
 *
 * Deliberately NOT an edit distance. The duplicates that actually appear are
 * `water` / `water-sim` / `water-dynamics` — a shared stem with a qualifier —
 * and a distance metric loose enough to catch those also pairs `gen` with
 * `net`. So: one contains the other as a whole hyphen-separated part.
 *
 * Only ever a suggestion. Merging is the operator's call, and a false positive
 * that nags is how a hint gets ignored.
 */
export function nearTopic(a: string, b: string): boolean {
  if (a === b) return false;
  const pa = a.split("-");
  const pb = b.split("-");
  const [shorter, longer] = pa.length <= pb.length ? [pa, pb] : [pb, pa];
  // Every part of the shorter appears in the longer, in order, from the start:
  // `water` vs `water-sim` yes, `gen` vs `net` no, `water` vs `deep-water` no
  // (a leading qualifier changes the subject rather than narrowing it).
  return shorter.every((part, i) => longer[i] === part);
}

export interface NoteInput {
  readonly title: string;
  readonly body?: string;
  readonly topic: string;
  readonly tags?: readonly string[];
  readonly kind?: DiaryKind;
  readonly scope?: string;
}

export type NoteCheck = { ok: true; note: Required<NoteInput> } | { ok: false; why: string };

/**
 * Validates an entry before it is written.
 *
 * The refusals name the repair, following the one-word-name rule: an agent that
 * is told only "no" retries with the same shape of input.
 */
export function checkNote(input: NoteInput): NoteCheck {
  const title = input.title.trim().replace(/\s+/g, " ");
  if (title === "") return { ok: false, why: "an entry needs a title — one sentence stating what you found" };
  if ([...title].length > TITLE_MAX) {
    return {
      ok: false,
      why:
        `a title must be ${TITLE_MAX} characters or fewer (yours is ${[...title].length}). ` +
        `It is what a search shows, so keep the claim and move the evidence to --body.`,
    };
  }
  const body = (input.body ?? "").trim();
  if ([...body].length > BODY_MAX) {
    return {
      ok: false,
      why:
        `a body must be ${BODY_MAX} characters or fewer (yours is ${[...body].length}). ` +
        `An entry longer than that is a document — write it in audit_reports/ and ` +
        `leave a diary entry pointing at it.`,
    };
  }
  const topic = normaliseTerm(input.topic);
  if (topic === "") {
    return { ok: false, why: "an entry needs a topic — one word, like `water` or `roads`" };
  }
  const kind = input.kind ?? "finding";
  if (!DIARY_KINDS.includes(kind)) {
    return { ok: false, why: `kind must be one of: ${DIARY_KINDS.join(", ")}` };
  }
  const tags = (input.tags ?? []).map(normaliseTerm).filter((t) => t !== "");
  return {
    ok: true,
    note: {
      title,
      body,
      topic,
      tags: [...new Set(tags)].slice(0, MAX_TAGS),
      kind,
      scope: normaliseScope(input.scope ?? ""),
    },
  };
}

/**
 * Resolves the author's name the way the work board does: the LIVE name when
 * that session still exists and has renamed itself, else the copy frozen at
 * write time. Both halves matter — an agent that renamed itself would otherwise
 * be credited under a name nobody uses, and an exited one has no live row.
 */
const AUTHOR = `COALESCE(NULLIF((SELECT s.alias FROM sessions s
                                  WHERE s.session_id = diary.session_id), ''),
                NULLIF((SELECT s.handle FROM sessions s
                         WHERE s.session_id = diary.session_id), ''),
                NULLIF(diary.agent, ''),
                'someone') AS author`;

const COLUMNS = `diary.id, diary.ts_ms, diary.session_id, diary.title, diary.body,
     diary.topic, diary.tags, diary.kind, diary.scope, diary.deprecated_ms,
     diary.deprecated_why, diary.superseded_by, diary.fixed_by, diary.fixed_ms, ${AUTHOR}`;

function toEntry(r: Record<string, string | number>): DiaryEntry {
  return {
    id: Number(r["id"]),
    tsMs: Number(r["ts_ms"]),
    agent: String(r["author"] ?? ""),
    sessionId: String(r["session_id"]),
    title: String(r["title"]),
    body: String(r["body"]),
    topic: String(r["topic"]),
    tags: unpackTags(String(r["tags"])),
    kind: String(r["kind"]) as DiaryKind,
    scope: String(r["scope"]),
    deprecatedMs: Number(r["deprecated_ms"]),
    deprecatedWhy: String(r["deprecated_why"]),
    supersededBy: Number(r["superseded_by"]),
    fixedBy: Number(r["fixed_by"] ?? 0),
    fixedMs: Number(r["fixed_ms"] ?? 0),
  };
}

export interface RecallFilter {
  readonly query?: string;
  readonly topic?: string;
  readonly tag?: string;
  readonly kind?: DiaryKind;
  readonly scope?: string;
  readonly sessionId?: string;
  /** Include deprecated entries, which are hidden by default. */
  readonly all?: boolean;
  readonly limit?: number;
}

export interface TopicSummary {
  readonly topic: string;
  readonly count: number;
  readonly lastMs: number;
}

export type WriteAndFixResult =
  | { readonly ok: true; readonly entryId: number; readonly fixed: DiaryEntry }
  | {
      readonly ok: false;
      readonly reason: "missing" | "not-error" | "already-fixed";
      readonly target?: DiaryEntry;
    };

export class DiaryStore {
  constructor(private readonly db: Database) {}

  /** Validates the referenced error before atomically writing and linking its fix. */
  writeAndFix(
    sessionId: string,
    agent: string,
    note: Required<NoteInput>,
    targetId: number,
    nowMs: number,
  ): WriteAndFixResult {
    const run = this.db.transaction((): WriteAndFixResult => {
      const target = this.get(targetId);
      if (!target) return { ok: false, reason: "missing" };
      if (target.kind !== "error")
        return { ok: false, reason: "not-error", target };
      if (target.fixedMs > 0)
        return { ok: false, reason: "already-fixed", target };
      const entryId = this.write(sessionId, agent, note, nowMs);
      const changed = this.db
        .query(`UPDATE diary SET fixed_by = ?, fixed_ms = ? WHERE id = ? AND fixed_ms = 0`)
        .run(entryId, nowMs, targetId).changes;
      if (changed !== 1) throw new Error("diary fix target changed during transaction");
      return { ok: true, entryId, fixed: target };
    });
    return run.immediate();
  }

  write(sessionId: string, agent: string, note: Required<NoteInput>, nowMs: number): number {
    const run = this.db.transaction((): number => {
      this.db
        .query(
          `INSERT INTO diary (ts_ms, agent, session_id, title, body, topic, tags, kind, scope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nowMs,
          agent,
          sessionId,
          note.title,
          note.body,
          note.topic,
          packTags(note.tags),
          note.kind,
          note.scope,
        );
      const id = Number(
        (this.db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id,
      );
      // The FTS index is EXTERNAL CONTENT, so it does not populate itself — the
      // row has to be pushed in explicitly. Missing this is silent: writes work,
      // and `recall` simply never finds anything.
      this.db
        .query(
          `INSERT INTO diary_fts (rowid, title, body, topic, tags)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, note.title, note.body, note.topic, note.tags.join(" "));
      return id;
    });
    return run.immediate();
  }

  get(id: number): DiaryEntry | null {
    const r = this.db.query(`SELECT ${COLUMNS} FROM diary WHERE id = ?`).get(id) as Record<
      string,
      string | number
    > | null;
    return r ? toEntry(r) : null;
  }

  /**
   * Search. With a query it is FTS-ranked; without one it is newest-first,
   * which is what `topic <name>` and the scope lookups want.
   */
  recall(f: RecallFilter): DiaryEntry[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.topic !== undefined && f.topic !== "") {
      where.push("diary.topic = ?");
      args.push(normaliseTerm(f.topic));
    }
    if (f.tag !== undefined && f.tag !== "") {
      // Wrapped on both sides so `,perf,` cannot match `,perf-regression,`.
      where.push("diary.tags LIKE ?");
      args.push(`%,${normaliseTerm(f.tag)},%`);
    }
    if (f.kind !== undefined) {
      where.push("diary.kind = ?");
      args.push(f.kind);
    }
    if (f.scope !== undefined && f.scope !== "") {
      // COVERS, not equals — the same relation `forPath` uses, so a scope that
      // pre-edit reported can be typed straight back into `recall`. Equality
      // made the hook's own pointer return nothing (caught live 2026-08-01):
      // entries at `.claude/hooks/presence` did not match a query for
      // `.claude/hooks/presence/hooks`, which is the folder being edited.
      //
      // A FILE is accepted too, for the same reason `normaliseScope` accepts
      // one: the caller usually has a path, not a folder.
      const cands = scopeCandidates(f.scope).filter((c) => c !== "");
      const self = normaliseScope(f.scope);
      if (self !== "" && !cands.includes(self)) cands.push(self);
      if (cands.length > 0) {
        where.push(`diary.scope IN (${cands.map(() => "?").join(",")})`);
        args.push(...cands);
      }
    }
    if (f.sessionId !== undefined && f.sessionId !== "") {
      where.push("diary.session_id = ?");
      args.push(f.sessionId);
    }
    if (f.all !== true) where.push("diary.deprecated_ms = 0");

    const limit = f.limit ?? 20;
    const query = (f.query ?? "").trim();
    if (query === "") {
      const sql = `SELECT ${COLUMNS} FROM diary
                   ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
                   ORDER BY diary.id DESC LIMIT ?`;
      const rows = this.db.query(sql).all(...args, limit) as Array<Record<string, string | number>>;
      return rows.map(toEntry);
    }
    // Ranked by FTS, filtered by the same predicates. `bm25` ascending is best
    // first; the title is weighted above the body because an entry whose TITLE
    // matches is the one the searcher meant.
    const sql = `SELECT ${COLUMNS} FROM diary
                   JOIN diary_fts ON diary_fts.rowid = diary.id
                  WHERE diary_fts MATCH ?
                    ${where.length > 0 ? `AND ${where.join(" AND ")}` : ""}
                  ORDER BY bm25(diary_fts, 8.0, 2.0, 4.0, 4.0) LIMIT ?`;
    const rows = this.db.query(sql).all(ftsQuery(query), ...args, limit) as Array<
      Record<string, string | number>
    >;
    return rows.map(toEntry);
  }

  /**
   * Entries whose scope covers `path`, nearest folder first.
   *
   * The hot one: `pre-edit` runs this on every Edit/Write. Bounded by path
   * depth (a handful of equality tests against an index), never a LIKE scan.
   */
  forPath(path: string, opts: { limit?: number; kinds?: readonly DiaryKind[] } = {}): DiaryEntry[] {
    const cands = scopeCandidates(path);
    const holes = cands.map(() => "?").join(",");
    const kinds = opts.kinds;
    const kindClause = kinds && kinds.length > 0 ? ` AND diary.kind IN (${kinds.map(() => "?").join(",")})` : "";
    const sql = `SELECT ${COLUMNS} FROM diary
                  WHERE diary.scope IN (${holes}) AND diary.deprecated_ms = 0${kindClause}
                  ORDER BY LENGTH(diary.scope) DESC, diary.id DESC LIMIT ?`;
    const rows = this.db
      .query(sql)
      .all(...cands, ...(kinds ?? []), opts.limit ?? 5) as Array<Record<string, string | number>>;
    return rows.map(toEntry);
  }

  /** How many live entries cover this path, without building any of them. */
  countForPath(path: string): number {
    const cands = scopeCandidates(path);
    const holes = cands.map(() => "?").join(",");
    const r = this.db
      .query(
        `SELECT COUNT(*) AS n FROM diary
          WHERE scope IN (${holes}) AND deprecated_ms = 0`,
      )
      .get(...cands) as { n: number };
    return Number(r.n);
  }

  topics(): TopicSummary[] {
    const rows = this.db
      .query(
        `SELECT topic, COUNT(*) AS n, MAX(ts_ms) AS last_ms FROM diary
          WHERE deprecated_ms = 0 GROUP BY topic ORDER BY n DESC, last_ms DESC`,
      )
      .all() as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      topic: String(r["topic"]),
      count: Number(r["n"]),
      lastMs: Number(r["last_ms"]),
    }));
  }

  /** Every tag with a count, commonest first. */
  tagCloud(): Array<{ tag: string; count: number }> {
    const rows = this.db
      .query(`SELECT tags FROM diary WHERE deprecated_ms = 0 AND tags != ''`)
      .all() as Array<{ tags: string }>;
    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const t of unpackTags(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /**
   * Marks an entry no longer true, with a reason.
   *
   * NOT A DELETE, on purpose. The fact that this was believed, and why it
   * stopped being true, is usually worth more than the claim was — this repo's
   * own memory has notes that exist only to say "OBSOLETE, and a memory can be
   * confidently wrong". Deprecated entries stay searchable behind `--all`.
   */
  deprecate(id: number, why: string, nowMs: number): boolean {
    const r = this.db
      .query(`UPDATE diary SET deprecated_ms = ?, deprecated_why = ? WHERE id = ? AND deprecated_ms = 0`)
      .run(nowMs, why.trim(), id);
    return r.changes > 0;
  }

  /**
   * Fills in a MISSING reason on an entry already marked no longer true.
   *
   * Separate from `deprecate`, which refuses an entry that is already retired —
   * a guard that also made an empty reason permanently unrepairable, so
   * `diary check` would report a problem no command could fix. This writes only
   * into a blank field: a reason somebody wrote is never overwritten, which is
   * the property that guard was actually protecting.
   */
  explainDeprecation(id: number, why: string): boolean {
    const trimmed = why.trim();
    if (trimmed === "") return false;
    return (
      this.db
        .query(
          `UPDATE diary SET deprecated_why = ?
            WHERE id = ? AND deprecated_ms != 0 AND deprecated_why = ''`,
        )
        .run(trimmed, id).changes > 0
    );
  }

  /**
   * Points a stale entry at the one that replaced it, and deprecates it.
   *
   * SUPERSEDING IS ITSELF THE REASON, so it fills one in. `diary check` flags a
   * deprecation with no reason, and it flagged both entries this had retired —
   * correctly, since "no longer true" with nothing after it is the least useful
   * thing an entry can say. The reason here is not a guess: the replacement IS
   * the explanation, and naming it beats leaving the field blank.
   */
  /**
   * Marks an error fixed, pointing at the entry that records the fix.
   *
   * ONLY AN ERROR CAN BE FIXED. A finding is a fact — "an UPDATE on an
   * external-content FTS5 table does nothing to the index" stays true after
   * someone works around it — so a `fixed` marker on one would mean "we have
   * stopped believing this", which is what `deprecate` is for. Refusing here is
   * what keeps `bugs` a list of things to do rather than a list of things known.
   *
   * The error is NOT deprecated by being fixed. It remains true as history: the
   * bug was real, and the next reader hitting the same symptom wants to find it
   * and follow the link to the fix.
   */
  fix(id: number, byId: number, nowMs: number): boolean {
    if (id === byId) return false;
    const entry = this.get(id);
    if (entry === null || entry.kind !== "error" || entry.fixedMs > 0) return false;
    if (byId !== 0 && this.get(byId) === null) return false;
    const r = this.db
      .query(`UPDATE diary SET fixed_by = ?, fixed_ms = ? WHERE id = ?`)
      .run(byId, nowMs, id);
    return r.changes > 0;
  }

  /**
   * Errors nobody has fixed, newest first. Scope-filtered like everything else.
   *
   * Deprecated entries are excluded: an error that stopped being true is not an
   * open bug, it is a mistake in the record.
   */
  openBugs(scope = "", limit = 20): DiaryEntry[] {
    const args: Array<string | number> = [];
    let clause = `WHERE diary.kind = 'error' AND diary.fixed_ms = 0 AND diary.deprecated_ms = 0`;
    if (scope !== "") {
      const candidates = [...scopeCandidates(scope), scope];
      clause += ` AND diary.scope IN (${candidates.map(() => "?").join(",")})`;
      args.push(...candidates);
    }
    const rows = this.db
      .query(`SELECT ${COLUMNS} FROM diary ${clause} ORDER BY diary.id DESC LIMIT ?`)
      .all(...args, limit) as Array<Record<string, string | number>>;
    return rows.map(toEntry);
  }

  supersede(id: number, byId: number, nowMs: number): boolean {
    if (id === byId) return false;
    const replacement = this.get(byId);
    if (replacement === null) return false;
    const r = this.db
      .query(
        `UPDATE diary
            SET superseded_by = ?,
                deprecated_ms = CASE WHEN deprecated_ms = 0 THEN ? ELSE deprecated_ms END,
                deprecated_why = CASE WHEN deprecated_why = '' THEN ? ELSE deprecated_why END
          WHERE id = ?`,
      )
      .run(byId, nowMs, `superseded by #${byId}: ${replacement.title}`, id);
    return r.changes > 0;
  }

  /**
   * Folds one topic into another, so `water`, `water-sim` and `hydrology` do not
   * quietly fragment every search.
   *
   * Merging has to exist from the start: retrofitting it after forty
   * near-duplicate topics is a data migration nobody will do.
   */
  mergeTopic(from: string, into: string): number {
    const a = normaliseTerm(from);
    const b = normaliseTerm(into);
    if (a === "" || b === "" || a === b) return 0;
    const run = this.db.transaction((): number => {
      // The rows have to be identified BEFORE the base table moves, because the
      // FTS repair below is driven by rowid and `topic = a` stops matching the
      // moment the UPDATE lands.
      const moved = this.db.query(`SELECT id FROM diary WHERE topic = ?`).all(a) as Array<{
        id: number;
      }>;
      const n = this.db.query(`UPDATE diary SET topic = ? WHERE topic = ?`).run(b, a).changes;
      // AN EXTERNAL-CONTENT INDEX IS NOT UPDATABLE BY AN ORDINARY UPDATE, and
      // the failure is invisible from every direction a reviewer looks: a plain
      // `UPDATE diary_fts SET topic = ?` reports rows changed, and a later
      // `SELECT topic FROM diary_fts` reads THROUGH to the content table and so
      // shows the new value — while the index itself still holds the old term.
      // Measured 2026-08-01: after merging `water-sim` into `hydrology`,
      // `MATCH "water-sim"` still returned the row and `MATCH "hydrology"`
      // returned nothing, so a merge silently broke search under both names.
      //
      // The supported repair is the delete/insert pair: the 'delete' command
      // must be handed the values CURRENTLY IN THE INDEX (the old topic) so FTS
      // can find the terms it is retracting, and the insert then adds the new
      // ones.
      const del = this.db.prepare(
        `INSERT INTO diary_fts (diary_fts, rowid, title, body, topic, tags)
         VALUES ('delete', ?, ?, ?, ?, ?)`,
      );
      const ins = this.db.prepare(
        `INSERT INTO diary_fts (rowid, title, body, topic, tags) VALUES (?, ?, ?, ?, ?)`,
      );
      const read = this.db.prepare(`SELECT title, body, tags FROM diary WHERE id = ?`);
      for (const { id } of moved) {
        const r = read.get(id) as { title: string; body: string; tags: string } | null;
        if (!r) continue;
        const tagText = unpackTags(r.tags).join(" ");
        del.run(id, r.title, r.body, a, tagText);
        ins.run(id, r.title, r.body, b, tagText);
      }
      return n;
    });
    return run.immediate();
  }

  /**
   * What is wrong with the diary as an organised thing, rather than with any
   * one entry.
   *
   * WHY THIS SHIPS WITH THE FEATURE and not after it: the memory dir this
   * replaces has 4 dangling wikilinks out of 99 targets, all near-misses of
   * notes that exist, because nothing ever checked. A graph with no integrity
   * check rots silently, and the rot is invisible precisely to the person who
   * would fix it.
   */
  check(nowMs: number): DiaryProblem[] {
    const problems: DiaryProblem[] = [];

    // Topics one hyphen apart. The duplicate that actually happens, and the one
    // that quietly halves every search that uses either name.
    const all = this.topics();
    const seen = new Set<string>();
    for (const a of all) {
      for (const b of all) {
        if (a.topic === b.topic) continue;
        const key = [a.topic, b.topic].sort().join(" ");
        if (seen.has(key) || !nearTopic(a.topic, b.topic)) continue;
        seen.add(key);
        problems.push({
          kind: "near-duplicate-topic",
          detail: `\`${a.topic}\` (${a.count}) and \`${b.topic}\` (${b.count}) look like one topic`,
          fix: `crew topic merge ${a.count <= b.count ? `${a.topic} ${b.topic}` : `${b.topic} ${a.topic}`}`,
        });
      }
    }

    // A superseded_by pointing at an entry that was pruned or never existed.
    // The exact failure the old wikilinks had: a reference that reads as a
    // promise and delivers nothing.
    const dangling = this.db
      .query(
        `SELECT d.id AS id, d.superseded_by AS target FROM diary d
          WHERE d.superseded_by != 0
            AND NOT EXISTS (SELECT 1 FROM diary o WHERE o.id = d.superseded_by)`,
      )
      .all() as Array<Record<string, number>>;
    for (const r of dangling) {
      problems.push({
        kind: "dangling-reference",
        detail: `#${r["id"]} says it was superseded by #${r["target"]}, which does not exist`,
        fix: `crew note ${r["id"]}`,
      });
    }

    // An entry with no scope is findable but never volunteered — it cannot
    // reach anyone through `pre-edit`, which is where the diary earns its keep.
    const unscoped = this.db
      .query(`SELECT COUNT(*) AS n FROM diary WHERE scope = '' AND deprecated_ms = 0`)
      .get() as { n: number };
    if (Number(unscoped.n) > 0) {
      const n = Number(unscoped.n);
      problems.push({
        kind: "unscoped",
        detail: `${n} live ${n === 1 ? "entry has" : "entries have"} no --scope, so nothing surfaces them at edit time`,
        // No single command repairs these — each needs a human decision about
        // which folder it is about. Listing them is the honest next step.
        fix: "crew recall --limit 100",
      });
    }

    // Deprecated without a reason. "This stopped being true" and nothing else
    // is the least useful thing an entry can say — the reason IS the value.
    const noWhy = this.db
      .query(`SELECT id FROM diary WHERE deprecated_ms != 0 AND deprecated_why = ''`)
      .all() as Array<{ id: number }>;
    for (const r of noWhy) {
      problems.push({
        kind: "deprecated-without-reason",
        detail: `#${r.id} is marked no-longer-true but does not say why`,
        fix: `crew note ${r.id}`,
      });
    }

    // Entries old enough that the code they describe has probably moved. NOT
    // an error: an old finding is not wrong, it is UNVERIFIED, which is a
    // different thing and cheaper to say than to guess at.
    const stale = this.db
      .query(`SELECT COUNT(*) AS n FROM diary WHERE deprecated_ms = 0 AND ts_ms < ?`)
      .get(nowMs - STALE_ENTRY_MS) as { n: number };
    if (Number(stale.n) > 0) {
      problems.push({
        kind: "unverified",
        detail: `${stale.n} live ${Number(stale.n) === 1 ? "entry is" : "entries are"} over ${Math.round(STALE_ENTRY_MS / (24 * 60 * 60 * 1000))} days old — not wrong, but unverified against the code as it is now`,
        fix: "crew recall --all",
      });
    }
    return problems;
  }

  /** Drops entries past the retention window. Deprecated ones go early. */
  prune(nowMs: number): void {
    const cfg = loadConfig();
    this.db.query(`DELETE FROM diary WHERE ts_ms < ?`).run(nowMs - cfg.diaryKeepMs);
    this.db
      .query(`DELETE FROM diary WHERE deprecated_ms != 0 AND deprecated_ms < ?`)
      .run(nowMs - cfg.diaryDeprecatedKeepMs);
    // FTS rows for deleted content would otherwise survive as phantom hits.
    this.db.exec(`INSERT INTO diary_fts (diary_fts) VALUES ('rebuild')`);
  }
}

/**
 * Turns a user's words into an FTS5 query that cannot be a syntax error.
 *
 * FTS5 MATCH has an operator language — bare `-`, `"` or `*` from a search for
 * `dist2 - linear` throws rather than returning nothing, and a throw inside
 * `pre-edit` is a hook that fails on an ordinary word. Each term is quoted, so
 * the input is data.
 */
export function ftsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    // A NUL is stripped along with the quote, and for a harder reason. SQLite
    // binds a JS string as a C string, so a NUL TRUNCATES the statement text:
    // the closing quote this function just added lands after the cut and the
    // driver throws `unterminated string`. Quoting made the input data for every
    // operator character except this one, and a throw inside `pre-edit` is a
    // hook that fails on an ordinary edit. Measured 2026-08-01: a NUL in ANY
    // position — leading, middle, trailing, alone — threw.
    .map((t) => t.replace(/["\u0000]/g, "").trim())
    .filter((t) => t !== "");
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" OR ");
}
