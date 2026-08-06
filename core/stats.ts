/**
 * What this tool has actually accumulated — every aggregate `stats` prints.
 *
 * PURE OVER A `Database`, so tests assert on numbers and `cli.ts` colours them.
 * TABLES ARE DISCOVERED, NEVER LISTED: the schema grows by live migration, so
 * every query naming an optional table is guarded by `hasTable`.
 */

import type { Database } from "bun:sqlite";
import { FEATURES, featureLabel, type FeatureId } from "./features.ts";

/** One table and how many rows are in it. */
export interface TableCount {
  readonly table: string;
  readonly rows: number;
}

/** How many distinct agents each part of the store has ever seen. */
export interface AgentCounts {
  readonly edits: number;
  readonly messages: number;
  readonly work: number;
  readonly diary: number;
}

/** One agent's span in the edit history. */
export interface AgentActivity {
  readonly agent: string;
  readonly edits: number;
  readonly firstMs: number;
  readonly lastMs: number;
}

/** How often N agents were co-present, in whole hours of edit activity. */
export interface Concurrency {
  /** `agents` → how many distinct hours had exactly that many agents editing. */
  readonly buckets: ReadonlyArray<{ agents: number; hours: number }>;
  /** Hours in which anybody edited anything — the denominator for the buckets. */
  readonly activeHours: number;
  /** The most agents ever seen editing within one hour. 0 when there are none. */
  readonly peak: number;
}

export interface MessageStats {
  readonly byKind: ReadonlyArray<{ kind: string; count: number }>;
  /** `say` messages aimed at one agent (`to_name` set) rather than broadcast. */
  readonly directedSays: number;
  readonly broadcastSays: number;
}

/**
 * One optional feature's usage.
 *
 * `detail` carries the split that makes the number mean something (open vs
 * closed, asked vs answered) and is empty when a bare count says it all.
 */
export interface FeatureUse {
  readonly id: FeatureId;
  readonly feature: string;
  readonly rows: number;
  readonly detail: string;
  readonly availability: FeatureMeasure;
  readonly exposure: FeatureMeasure;
  readonly use: FeatureMeasure;
}

export interface FeatureMeasure {
  readonly observations: number;
  readonly sessions: number;
  readonly opportunities: number;
  readonly surfaces: ReadonlyArray<{ surface: string; observations: number; sessions: number }>;
}

export interface Stats {
  readonly sample: Sample;
  readonly tables: readonly TableCount[];
  readonly agents: AgentCounts;
  readonly activity: readonly AgentActivity[];
  readonly concurrency: Concurrency;
  readonly messages: MessageStats;
  readonly features: readonly FeatureUse[];
}

/** At or below this, a feature was used once or never — equally uninformative. */
export const SPARSE_ROWS = 1;

/**
 * The window these numbers describe.
 *
 * EVERY AGGREGATE BELOW IS A SAMPLE: a low count measures how one week went,
 * not what the system supports. Printed ABOVE the tables, because a caveat
 * under a number is read second and quoted never.
 */
export interface Sample {
  /** Hours in which anybody edited. The denominator for everything here. */
  readonly activeHours: number;
  /** Wall-clock span from the first recorded edit to the last. */
  readonly spanMs: number;
}

export function sample(db: Database): Sample {
  const c = concurrency(db);
  if (!hasTable(db, "edits")) return { activeHours: 0, spanMs: 0 };
  const row = db
    .query(`SELECT MIN(ts_ms) AS first, MAX(ts_ms) AS last FROM edits WHERE agent != ''`)
    .get() as { first: number | null; last: number | null } | null;
  const first = Number(row?.first ?? 0);
  const last = Number(row?.last ?? 0);
  return { activeHours: c.activeHours, spanMs: first > 0 ? last - first : 0 };
}

/**
 * True when a table exists in THIS db.
 *
 * Cheap enough to call per query, and calling it per query is the point: one
 * cached list computed at the top would go stale the moment a caller reached
 * for a table added by a migration mid-run.
 */
export function hasTable(db: Database, table: string): boolean {
  const row = db
    .query(`SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { hit: number } | null;
  return row !== null;
}

/**
 * Tables worth counting: sqlite's bookkeeping and the FTS shadow tables are not
 * state this tool accumulated. A substring rule rather than a name list, which
 * would need editing when nobody is thinking about it.
 */
export function countableTable(name: string): boolean {
  return !name.startsWith("sqlite_") && !name.includes("_fts");
}

/** Every real table with its row count, biggest first. */
export function tableCounts(db: Database): TableCount[] {
  const names = (
    db.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as Array<{
      name: string;
    }>
  )
    .map((r) => r.name)
    .filter(countableTable);
  const out: TableCount[] = [];
  for (const table of names) {
    // The name came from `sqlite_master`, so interpolation cannot carry
    // anything a caller supplied — and a table name is not bindable.
    const row = db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number } | null;
    out.push({ table, rows: Number(row?.n ?? 0) });
  }
  // Ties by name so two empty tables do not swap places between runs.
  return out.sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));
}

/**
 * How many rows are in a table, or 0 when it does not exist here.
 *
 * `where` is a literal fragment rather than a bound parameter, and every caller
 * in this file passes a constant. That is safe only because nothing here takes
 * user input — `stats` has no arguments — and it stays that way: a filter built
 * from anything typed at the CLI must be bound, not interpolated.
 */
function count(db: Database, table: string, where = ""): number {
  if (!hasTable(db, table)) return 0;
  const clause = where === "" ? "" : ` WHERE ${where}`;
  const row = db.query(`SELECT COUNT(*) AS n FROM "${table}"${clause}`).get() as {
    n: number;
  } | null;
  return Number(row?.n ?? 0);
}

/** Distinct non-empty values of one column, or 0 when the table is absent. */
function distinct(db: Database, table: string, column: string): number {
  if (!hasTable(db, table)) return 0;
  const row = db
    .query(`SELECT COUNT(DISTINCT "${column}") AS n FROM "${table}" WHERE "${column}" != ''`)
    .get() as { n: number } | null;
  return Number(row?.n ?? 0);
}

/**
 * Distinct agents per source.
 *
 * FOUR NUMBERS, NOT ONE, because they disagree and the disagreement is the
 * finding. `messages` IS NOT COMPARABLE to the other three: it is a cumulative
 * historical roll, so the printer marks that row.
 */
export function agentCounts(db: Database): AgentCounts {
  return {
    edits: distinct(db, "edits", "agent"),
    messages: distinct(db, "messages", "handle"),
    work: distinct(db, "work", "agent_name"),
    diary: distinct(db, "diary", "agent"),
  };
}

/**
 * The busiest agents by edit count, with the span they were alive for.
 *
 * Keyed on the NAME, not the session id: a conversation that resumes arrives as
 * a fresh uuid holding the same name, and splitting one agent's 36-hour life
 * into four rows would hide precisely the long-lived outlier this is for.
 */
export function agentActivity(db: Database, limit: number): AgentActivity[] {
  if (!hasTable(db, "edits")) return [];
  const rows = db
    .query(
      `SELECT agent, COUNT(*) AS n, MIN(ts_ms) AS first, MAX(ts_ms) AS last
         FROM edits WHERE agent != ''
         GROUP BY agent ORDER BY n DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, string | number>>;
  return rows.map((r) => ({
    agent: String(r["agent"]),
    edits: Number(r["n"]),
    firstMs: Number(r["first"]),
    lastMs: Number(r["last"]),
  }));
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * How many agents were ever actually working at the same time.
 *
 * An HOUR bucket: a minute undercounts, since two agents rarely edit within the
 * same 60 seconds, and a day folds a night of sequential shifts into
 * "co-present". The hour proxies "close enough to collide".
 */
export function concurrency(db: Database): Concurrency {
  if (!hasTable(db, "edits")) return { buckets: [], activeHours: 0, peak: 0 };
  const rows = db
    .query(
      `SELECT COUNT(DISTINCT agent) AS agents
         FROM edits WHERE agent != ''
         GROUP BY ts_ms / ${HOUR_MS}`,
    )
    .all() as Array<{ agents: number }>;
  const byCount = new Map<number, number>();
  let peak = 0;
  for (const r of rows) {
    const n = Number(r.agents);
    byCount.set(n, (byCount.get(n) ?? 0) + 1);
    if (n > peak) peak = n;
  }
  const buckets = [...byCount.entries()]
    .map(([agents, hours]) => ({ agents, hours }))
    .sort((a, b) => a.agents - b.agents);
  return { buckets, activeHours: rows.length, peak };
}

/**
 * Message volume by kind, and how much of `say` was ever aimed at one agent.
 *
 * `to_name`, not `to_session`: a directed message keeps the name it was
 * addressed to even after that session's row is swept at 90 minutes, so the
 * session column reads as empty for most of the history.
 */
export function messageStats(db: Database): MessageStats {
  if (!hasTable(db, "messages")) {
    return { byKind: [], directedSays: 0, broadcastSays: 0 };
  }
  const byKind = (
    db
      .query(`SELECT kind, COUNT(*) AS n FROM messages GROUP BY kind ORDER BY n DESC`)
      .all() as Array<Record<string, string | number>>
  ).map((r) => ({ kind: String(r["kind"]), count: Number(r["n"]) }));
  return {
    byKind,
    directedSays: count(db, "messages", `kind = 'say' AND to_name != ''`),
    broadcastSays: count(db, "messages", `kind = 'say' AND to_name = ''`),
  };
}

/**
 * Every optional feature, with the count that says whether anyone uses it.
 *
 * ORDER IS FIXED AND INCLUDES THE ZEROES, or a dead feature reads as absent.
 * `memories` is passed in because it lives in a different database.
 */
export function featureUse(db: Database, memories: number): FeatureUse[] {
  const questions = count(db, "questions");
  const answered = count(db, "questions", "answered_ms > 0");
  const findings = count(db, "diary");
  const authors = distinct(db, "diary", "agent");
  const work = count(db, "work");
  const open = count(db, "work", "closed_ms = 0");
  const bugs = count(db, "diary", `kind = 'error'`);
  const fixed = count(db, "diary", `kind = 'error' AND fixed_ms > 0`);
  const evidence=allFeatureMeasures(db);
  const rowData:Partial<Record<FeatureId,{rows:number;detail:string}>>={questions:{rows:questions,detail:`${answered} answered`},diary:{rows:findings,detail:`${authors} authors; ${bugs} bugs, ${fixed} fixed`},work:{rows:work,detail:`${open} open, ${work-open} closed`},minions:{rows:count(db,"minions"),detail:""},aliases:{rows:count(db,"aliases"),detail:""},claims:{rows:count(db,"claims"),detail:"live only, TTL-swept"},tasks:{rows:count(db,"tasks"),detail:""},memories:{rows:memories,detail:"separate db"},obligations:{rows:count(db,"obligations"),detail:"append-only fold"},clearances:{rows:count(db,"clearances"),detail:"own lifecycle"},hazards:{rows:count(db,"hazard_notices"),detail:"orthogonal notices"},corrections:{rows:count(db,"message_acts",`act_type = 'correction'`),detail:"explicit only"},messages:{rows:count(db,"messages"),detail:""}};
  return FEATURES.map(({id})=>{const base=rowData[id]??{rows:0,detail:"telemetry only"};const m=evidence.get(id)??emptyStages();return {id,feature:featureLabel(id),...base,availability:m.availability,exposure:m.exposure,use:{...m.use,opportunities:m.exposure.opportunities}};});
}

type MutableMeasure={observations:number;sessions:number;opportunities:number;surfaces:Array<{surface:string;observations:number;sessions:number}>};
type Stages={availability:MutableMeasure;exposure:MutableMeasure;use:MutableMeasure};
const emptyMeasure=():MutableMeasure=>({observations:0,sessions:0,opportunities:0,surfaces:[]});
const emptyStages=():Stages=>({availability:emptyMeasure(),exposure:emptyMeasure(),use:emptyMeasure()});
function allFeatureMeasures(db:Database):Map<FeatureId,Stages>{const out=new Map<FeatureId,Stages>();if(!hasTable(db,"feature_events"))return out;const rows=db.query(`WITH evidence AS (SELECT * FROM feature_events) SELECT feature,stage,'' surface,COUNT(*) observations,COUNT(DISTINCT session_id) sessions,COUNT(DISTINCT opportunity_id) opportunities FROM evidence GROUP BY feature,stage UNION ALL SELECT feature,stage,surface,COUNT(*),COUNT(DISTINCT session_id),COUNT(DISTINCT opportunity_id) FROM evidence GROUP BY feature,stage,surface ORDER BY feature,stage,surface`).all() as Array<{feature:FeatureId;stage:keyof Stages;surface:string;observations:number;sessions:number;opportunities:number}>;for(const r of rows){const stages=out.get(r.feature)??emptyStages();const m=stages[r.stage];if(r.surface===""){m.observations=Number(r.observations);m.sessions=Number(r.sessions);m.opportunities=Number(r.opportunities);}else m.surfaces=[...m.surfaces,{surface:r.surface,observations:Number(r.observations),sessions:Number(r.sessions)}];out.set(r.feature,stages);}return out;}

/** Everything in one pass, for a caller that just wants to print it. */
export function collectStats(db: Database, memories: number, topAgents = 10): Stats {
  return {
    sample: sample(db),
    tables: tableCounts(db),
    agents: agentCounts(db),
    activity: agentActivity(db, topAgents),
    concurrency: concurrency(db),
    messages: messageStats(db),
    features: featureUse(db, memories),
  };
}

/** `36.2h`, or `18m` when an agent lived less than an hour. */
export function spanText(fromMs: number, toMs: number): string {
  const ms = Math.max(0, toMs - fromMs);
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / HOUR_MS).toFixed(1)}h`;
}

/** `1.4 MB` — a file size a reader can compare against a disk quota by eye. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a low row count is, and — deliberately — not what it means.
 *
 * NOT "DEAD", NOT "UNUSED": a feature at zero may be unwanted, or new, or never
 * named to any session. `no rows in sample` is a fact and `unused` is a
 * conclusion, so it reports the observation and stops.
 */
export function usageFlag(rows: number, exposureOpportunities = 0): string {
  if (exposureOpportunities > 0 && rows === 0) return `(no rows across ${exposureOpportunities} exposed session opportunities)`;
  if (exposureOpportunities > 0 && rows <= SPARSE_ROWS) return `(${rows} row across ${exposureOpportunities} exposed session opportunities)`;
  if (rows === 0) return "(no rows in sample — exposure unknown)";
  if (rows <= SPARSE_ROWS) return `(${rows} row in sample — exposure unknown)`;
  return "";
}
