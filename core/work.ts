/**
 * Work records: what each agent is doing, as a timeline rather than a status.
 *
 * WHY THREE TABLES AND NOT ONE STATUS COLUMN. A row that is overwritten answers
 * "what now?" and destroys "what happened?", and the second question is the one
 * asked days later ("who moved the baselines?"). So current state is a FOLD over
 * an append-only event log, not a stored column — `board` and `board --history`
 * read the same rows and therefore cannot disagree.
 *
 * `work_steps` is the one deliberate exception. Which phases remain is asked on
 * every `Stop`, and that has to be one indexed query rather than a replay of an
 * agent's whole history, so a step's `done_ms` is mutable in place.
 *
 * KEYED ON THE CONVERSATION, which is what a session id already is — see
 * `agentKey`. Claude Code's `traffic-XX` label moves across a restart; the
 * session id does not, so yesterday's `traffic-aa` and today's `traffic-a0`
 * resolve to one timeline without any matching heuristic.
 */

import type { Database } from "bun:sqlite";

import { loadConfig } from "./config.ts";

/**
 * How long a closed record is kept, when no config says otherwise.
 *
 * This is the first thing in the tool that is deliberately HISTORY rather than
 * live state, so it is exempt from the roster's `STALE_MS` sweep and needs its
 * own. Seven days covers "who broke this?" asked the following week; anything
 * longer is an archive nobody reads.
 *
 * `pruneWork` reads `loadConfig().workKeepMs`, which defaults to this. Kept as
 * an export because tests assert against it — but it is the DEFAULT, not the
 * value in force, and reading it as the latter is what let the config setting
 * silently do nothing.
 */
export const WORK_KEEP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Open items past this many are summarised as a count rather than listed. */
export const BOARD_OPEN_SHOWN = 3;

/** Everything that can happen to a work item, in the order it tends to happen. */
export type WorkEventKind =
  | "started"
  | "step"
  | "did"
  | "add"
  | "landed"
  | "breaks"
  | "needs"
  | "note"
  /** Pointed at the plan document it executes; `ref` carries the path. */
  | "linked"
  | "closed";

export type WorkOutcome = "" | "done" | "abandoned";

export interface WorkItem {
  readonly workId: number;
  /** Stable across restarts; see `agentKey`. */
  readonly agentId: string;
  /**
   * What to call the agent on the board: its current name if it is still around,
   * else the one frozen when the item was opened.
   */
  readonly agentName: string;
  readonly subject: string;
  readonly startedMs: number;
  /** 0 while open. */
  readonly closedMs: number;
  readonly outcome: WorkOutcome;
  /** Any event or step tick; what `board` sorts on. */
  readonly updatedMs: number;
  /**
   * The turn this item last asked its agent to reconcile. Guards the idle check
   * against re-asking within one turn — P2 reads it, P0 only has to store it.
   */
  readonly askedTurnMs: number;
  /** True when a hook opened this as a placeholder rather than the agent. */
  readonly auto: boolean;
  /**
   * The plan document this item executes, repo-relative; "" when none.
   *
   * A plan's own file history cannot answer "did this get built" — an agent
   * writes the plan, implements it, and never touches the file again. This link
   * is what lets `landed` shas on an item stand as proof about the plan.
   */
  readonly planDoc: string;
}

export interface WorkStep {
  readonly workId: number;
  readonly idx: number;
  readonly text: string;
  /** 0 while outstanding. */
  readonly doneMs: number;
  /** What actually happened, when the agent bothered to say. */
  readonly note: string;
}

export interface WorkEvent {
  readonly id: number;
  readonly workId: number;
  readonly tsMs: number;
  readonly kind: WorkEventKind;
  readonly body: string;
  /** A sha for `landed`, a step index for `step`/`did`, else "". */
  readonly ref: string;
}

/**
 * The durable identity of an agent across restarts.
 *
 * IT IS THE SESSION ID, and that is not the tautology it looks like.
 * `CLAUDE_CODE_SESSION_ID` is not a per-process label — it is the CONVERSATION
 * uuid, the same one that names the transcript on disk and that
 * `claude --resume <uuid>` takes. Measured 2026-07-31 on this very tool's own
 * conversation: the terminal was restarted mid-session, Claude Code's display
 * name moved `traffic-a0` -> `traffic-7c`, and the session id stayed
 * `c5ce05bc-…` throughout — the roster row was never replaced, only relabelled.
 *
 * An earlier version keyed on the conversation TITLE, reasoning that a restart
 * issued a new session id. It does not. The title was strictly worse on two
 * counts: it is model-written and REWRITTEN as a conversation develops, so
 * renaming a conversation silently orphaned every record filed under the old
 * name; and it is empty until the first title lands, so early records fell back
 * to a second key and split one agent's timeline in two.
 *
 * `title` is still taken, and deliberately ignored, so that every call site
 * reads as "identity, given what we know about this session" rather than being
 * quietly rewritten to pass one argument fewer.
 */
export function agentKey(_title: string, sessionId: string): string {
  return `session:${sessionId}`;
}

export function createWorkTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work (
      work_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      -- "session:" + the conversation uuid. Stored rather than recomputed so a
      -- record still names its owner once that session is gone.
      agent_id   TEXT NOT NULL,
      -- The name at creation, kept as a FALLBACK: a board read after the session
      -- exits must still say who did the work. It is not the whole answer,
      -- because an agent can rename itself after opening an item — the queries
      -- below prefer the live name and fall back to this one.
      agent_name TEXT NOT NULL DEFAULT '',
      subject    TEXT NOT NULL,
      started_ms INTEGER NOT NULL,
      closed_ms  INTEGER NOT NULL DEFAULT 0,
      outcome    TEXT NOT NULL DEFAULT '',
      updated_ms INTEGER NOT NULL,
      asked_turn_ms INTEGER NOT NULL DEFAULT 0,
      -- 1 when a hook opened this rather than the agent. An auto row is a
      -- PLACEHOLDER: it says "this session is working, here is roughly what on",
      -- which is worth more than the blank the board showed before. The moment
      -- the agent opens a real item the placeholder is closed, because two rows
      -- for one piece of work is worse than none.
      auto       INTEGER NOT NULL DEFAULT 0,
      -- The plan document this item executes, repo-relative and forward-slashed.
      -- THE JOIN THAT MAKES A PLAN'S STATE KNOWABLE. An agent writes a plan and
      -- then implements it, never touching the file again -- so a plan's own git
      -- history says nothing about whether its work happened. Measured: one
      -- agent had 4 of 6 steps done and a sha landed while its plan file had
      -- zero commits. The work moved; the document did not.
      --
      -- Empty for the ordinary item, which is most of them. A required link
      -- would be a field agents fill with noise.
      plan_doc   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS work_agent ON work (agent_id, closed_ms);
    CREATE TABLE IF NOT EXISTS work_steps (
      work_id INTEGER NOT NULL,
      idx     INTEGER NOT NULL,
      text    TEXT NOT NULL,
      done_ms INTEGER NOT NULL DEFAULT 0,
      note    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (work_id, idx)
    );
    CREATE TABLE IF NOT EXISTS work_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL,
      ts_ms   INTEGER NOT NULL,
      kind    TEXT NOT NULL,
      body    TEXT NOT NULL,
      ref     TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS work_events_item ON work_events (work_id, id);
  `);
}

/**
 * What every work query selects, so the three cannot drift apart.
 *
 * `agent_name` resolves to the LIVE name when that agent is still around and
 * has renamed itself, falling back to the copy frozen at creation. Both halves
 * are load-bearing: an agent that renames itself mid-item would otherwise be
 * credited under a name nobody uses any more, and an agent that has exited has
 * no live row to resolve against at all.
 *
 * IT MUST TRY ALL THREE COLUMNS, in `displayName`'s order: alias, then handle,
 * then Claude Code's label. Reading `alias` alone looked right because an agent
 * that renames itself by hand writes there — but the ORDINARY case is a session
 * whose name is its given handle with `alias` empty, and for that one the
 * subquery returned nothing and every row fell back to its frozen string. One
 * agent then rendered under as many names as it had been frozen under: an item
 * opened as `tooling` stayed `tooling` while its newer siblings read `hopper`.
 *
 * The join is on the agent key, which is `session:<uuid>` — the conversation
 * uuid, so it still matches after a restart.
 *
 * THE LEDGER OUTRANKS THE FROZEN COPY, and both outrank nothing. `sessions`
 * holds only LIVE rows, so resolving through it alone means an agent that has
 * exited — or whose row was cleared — falls back to whatever name was frozen
 * when the item was opened. Measured 2026-08-05: `crew clear` emptied
 * `sessions` and one agent's own open item immediately re-rendered under a name
 * it had been renamed away from two days earlier. `name_owners` is the durable
 * answer to "what is this conversation called", so it sits between them.
 */
const WORK_COLUMNS = `work.work_id, work.agent_id, work.subject, work.started_ms,
     work.closed_ms, work.outcome, work.updated_ms, work.asked_turn_ms, work.auto,
     work.plan_doc,
     COALESCE(NULLIF((SELECT COALESCE(NULLIF(s.alias, ''), NULLIF(s.handle, ''), s.name)
                        FROM sessions s
                       WHERE 'session:' || s.session_id = work.agent_id), ''),
              NULLIF((SELECT o.name FROM name_owners o
                       WHERE 'session:' || o.session_id = work.agent_id), ''),
              NULLIF(work.agent_name, ''), '') AS agent_name`;

function rowToItem(r: Record<string, string | number>): WorkItem {
  return {
    workId: Number(r["work_id"]),
    agentId: String(r["agent_id"]),
    agentName: String(r["agent_name"] ?? ""),
    subject: String(r["subject"]),
    startedMs: Number(r["started_ms"]),
    closedMs: Number(r["closed_ms"] ?? 0),
    outcome: String(r["outcome"] ?? "") as WorkOutcome,
    updatedMs: Number(r["updated_ms"]),
    askedTurnMs: Number(r["asked_turn_ms"] ?? 0),
    auto: Number(r["auto"] ?? 0) === 1,
    planDoc: String(r["plan_doc"] ?? ""),
  };
}

function rowToStep(r: Record<string, string | number>): WorkStep {
  return {
    workId: Number(r["work_id"]),
    idx: Number(r["idx"]),
    text: String(r["text"]),
    doneMs: Number(r["done_ms"] ?? 0),
    note: String(r["note"] ?? ""),
  };
}

function rowToEvent(r: Record<string, string | number>): WorkEvent {
  return {
    id: Number(r["id"]),
    workId: Number(r["work_id"]),
    tsMs: Number(r["ts_ms"]),
    kind: String(r["kind"]) as WorkEventKind,
    body: String(r["body"]),
    ref: String(r["ref"] ?? ""),
  };
}

/**
 * Splits a `--plan` string into steps.
 *
 * Semicolons first, because that is what the prompt shows and what an agent
 * writing prose will reach for. Newlines too, so a heredoc works. A leading
 * `1.`/`-`/`*` is stripped: agents number their own lists reflexively, and
 * storing "1. delete buildGraph" as step 1 renders as "1. 1. delete buildGraph".
 */
export function parsePlan(plan: string): string[] {
  return plan
    .split(/[;\n]/)
    .map((s) => s.trim().replace(/^(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((s) => s !== "");
}

/**
 * A plan document path, as it is stored and compared.
 *
 * NOT `normaliseScope`, which strips a filename to reach its folder — that is
 * right for a diary scope and exactly wrong here, where the FILE is the thing
 * being named. Two items linking one plan must produce byte-identical strings
 * or the join silently splits into two plans, so the shape is pinned: forward
 * slashes, no `./`, no leading or trailing slash, no repo prefix.
 *
 * An absolute path is reduced to its repo-relative tail when it contains a
 * recognisable anchor, because agents paste what the IDE gives them
 * (`i:\Projects\Traffic\audit_reports\...`) and a stored absolute path would
 * never match the same plan opened from a worktree.
 */
export function normalisePlanPath(raw: string): string {
  let s = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (s === "" || s === ".") return "";
  // Reduce an absolute path to the first anchor folder we recognise. Anything
  // unrecognised is left alone rather than guessed at -- a wrong reduction
  // silently splits one plan in two, which is worse than a long path.
  const anchor = /(?:^|\/)((?:audit_reports|docs|plans|\.claude)\/.+)$/i.exec(s);
  if (anchor?.[1] !== undefined) s = anchor[1];
  return s.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** One plan, as derived from the work items that reference it. */
export interface PlanRollup {
  readonly planDoc: string;
  /** Every item linked to it, newest first. */
  readonly items: readonly WorkItem[];
  /** Distinct agent names that worked it, in first-seen order. */
  readonly agents: readonly string[];
  readonly stepsDone: number;
  readonly stepsTotal: number;
  /** Shas from `landed` events on the linked items — proof, not claim. */
  readonly shas: readonly string[];
  /** Newest `updated_ms` across the linked items. */
  readonly updatedMs: number;
  readonly openItems: number;
  readonly closedItems: number;
}

/**
 * The work-record half of the store. Held by `Store` rather than opened
 * separately, so a hook pays for one connection and one transaction boundary.
 */
export class WorkStore {
  constructor(private readonly db: Database) {}

  /** Atomically replaces inferred work with an agent-authored item. */
  replaceAutoWithWork(
    agentId: string,
    agentName: string,
    subject: string,
    steps: readonly string[],
    nowMs: number,
    planDoc = "",
  ): number {
    const run = this.db.transaction(() => {
      this.closeAuto(agentId, nowMs);
      return this.open(agentId, agentName, subject, steps, nowMs, planDoc);
    });
    return run.immediate();
  }

  /** Opens an item. Steps are optional — an item with none is a valid end state. */
  open(
    agentId: string,
    agentName: string,
    subject: string,
    steps: readonly string[],
    nowMs: number,
    planDoc = "",
  ): number {
    const run = this.db.transaction((): number => {
      this.db
        .query(
          `INSERT INTO work (agent_id, agent_name, subject, started_ms, updated_ms, plan_doc)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(agentId, agentName, subject, nowMs, nowMs, normalisePlanPath(planDoc));
      const row = this.db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number };
      const workId = Number(row.id);
      const ins = this.db.prepare(`INSERT INTO work_steps (work_id, idx, text) VALUES (?, ?, ?)`);
      for (const [i, text] of steps.entries()) ins.run(workId, i + 1, text);
      this.db
        .query(`INSERT INTO work_events (work_id, ts_ms, kind, body) VALUES (?, ?, 'started', ?)`)
        .run(workId, nowMs, steps.length > 0 ? steps.join(" → ") : subject);
      return workId;
    });
    return run();
  }

  /**
   * The item a bare command means.
   *
   * MOST RECENTLY TOUCHED, unless a subject substring is given. With several
   * items open every command needs to know which, and this matches how an agent
   * narrates it ("finished the sliver fix, back to the core work") without
   * making it pass an id it would have to look up.
   */
  target(agentId: string, match?: string): WorkItem | null {
    const q = (match ?? "").trim().toLowerCase();
    const rows = this.db
      .query(`SELECT ${WORK_COLUMNS} FROM work WHERE agent_id = ? AND closed_ms = 0 ORDER BY updated_ms DESC`)
      .all(agentId) as Array<Record<string, string | number>>;
    const items = rows.map(rowToItem);
    if (q === "") return items[0] ?? null;
    return items.find((i) => i.subject.toLowerCase().includes(q)) ?? null;
  }

  openItems(agentId: string): WorkItem[] {
    const rows = this.db
      .query(`SELECT ${WORK_COLUMNS} FROM work WHERE agent_id = ? AND closed_ms = 0 ORDER BY updated_ms DESC`)
      .all(agentId) as Array<Record<string, string | number>>;
    return rows.map(rowToItem);
  }

  /**
   * Opens a PLACEHOLDER row for an agent that has not opened one itself.
   *
   * WHY THIS EXISTS: the board's original problem was that agents skip optional
   * work — the task board it replaced had zero rows. An agent that never runs
   * `doing` is invisible, so the operator reading the board to see who is doing
   * what gets a blank where that agent should be. A row saying "this session is
   * working, roughly on this" is worth more than nothing.
   *
   * IDEMPOTENT AND SELF-EFFACING. One auto row per session at a time, and it is
   * closed the moment the agent opens a real item — two rows for one piece of
   * work is worse than none, and the agent's own subject is always better than a
   * conversation title.
   *
   * Never opened when the agent already has an open item of its own: a
   * placeholder beside real work is noise, not information.
   */
  autoOpen(agentId: string, agentName: string, subject: string, nowMs: number): number | null {
    const trimmed = subject.trim();
    if (trimmed === "") return null;
    const run = this.db.transaction((): number | null => {
      const existing = this.db
        .query(`SELECT work_id, auto, subject FROM work WHERE agent_id = ? AND closed_ms = 0`)
        .all(agentId) as Array<Record<string, string | number>>;
      // An agent-authored item means this session is already describing itself.
      if (existing.some((r) => Number(r["auto"]) === 0)) return null;

      const mine = existing.find((r) => Number(r["auto"]) === 1);
      if (mine) {
        const id = Number(mine["work_id"]);
        // The title moves as the conversation does, so the placeholder follows
        // it. `updated_ms` moves too — the session IS active, and a placeholder
        // frozen at its open time would be reaped by the stale-item nudge for
        // work that is very much happening.
        if (String(mine["subject"]) !== trimmed) {
          this.db.query(`UPDATE work SET subject = ? WHERE work_id = ?`).run(trimmed, id);
        }
        this.db.query(`UPDATE work SET updated_ms = ? WHERE work_id = ?`).run(nowMs, id);
        return id;
      }
      this.db
        .query(
          `INSERT INTO work (agent_id, agent_name, subject, started_ms, updated_ms, auto)
           VALUES (?, ?, ?, ?, ?, 1)`,
        )
        .run(agentId, agentName, trimmed, nowMs, nowMs);
      const id = Number((this.db.query(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
      this.db
        .query(`INSERT INTO work_events (work_id, ts_ms, kind, body) VALUES (?, ?, 'started', ?)`)
        .run(id, nowMs, trimmed);
      return id;
    });
    return run.immediate();
  }

  /**
   * Retires this agent's placeholder, because it has said what it is doing.
   *
   * Closed rather than deleted: the events under it are a real record of when
   * that session started working, and `--history` should still find them.
   */
  closeAuto(agentId: string, nowMs: number): void {
    const rows = this.db
      .query(`SELECT work_id FROM work WHERE agent_id = ? AND closed_ms = 0 AND auto = 1`)
      .all(agentId) as Array<{ work_id: number }>;
    for (const r of rows) {
      this.close(Number(r.work_id), "done", "superseded by the agent's own item", nowMs);
    }
  }

  /**
   * Records a commit against this agent's current item.
   *
   * The one thing on the board nobody has to remember to do: a sha is proof the
   * work is real, and it is the difference between a checklist and a record.
   */
  recordLanded(agentId: string, sha: string, subject: string, nowMs: number): number | null {
    const item = this.target(agentId);
    if (!item) return null;
    this.record(item.workId, "landed", subject, nowMs, sha);
    return item.workId;
  }

  /**
   * This agent's open items that have not moved in a while, and that it has not
   * already been asked about.
   *
   * WHY THIS EXISTS: an item is opened, the work finishes, the agent moves on
   * and never closes it — so the board keeps advertising work nobody is doing.
   * Observed live 2026-08-01: an item sat 13 hours at "1/3 · updated 12h" while
   * its agent had shipped four unrelated commits since. The board's whole claim
   * is that it says what is happening NOW, and a dangling item is a lie it tells
   * about a specific agent.
   *
   * NOT AUTO-CLOSED. Only the agent knows whether the work finished, was
   * abandoned, or is genuinely parked — and closing it from a timer would swap a
   * stale "open" for an equally wrong "done". So this only supplies the nudge;
   * the decision stays where the knowledge is.
   *
   * ASKED ONCE PER ITEM, tracked in `asked_turn_ms`. An agent that judges an
   * item still live must not be asked again next turn, or the reminder becomes
   * noise it learns to skip — which is how a nudge stops working.
   */
  staleItems(agentId: string, nowMs: number, staleMs: number): WorkItem[] {
    const rows = this.db
      .query(
        // `auto = 0`: a placeholder was never something the agent chose to
        // track, so asking it to reconcile one is asking about the tool's own
        // bookkeeping. They are refreshed on every prompt anyway, so they never
        // go stale — but excluding them here says why rather than relying on it.
        `SELECT ${WORK_COLUMNS} FROM work
          WHERE agent_id = ? AND closed_ms = 0 AND auto = 0
            AND updated_ms < ? AND asked_turn_ms = 0
          ORDER BY updated_ms ASC`,
      )
      .all(agentId, nowMs - staleMs) as Array<Record<string, string | number>>;
    return rows.map(rowToItem);
  }

  /** Every item on the board, open first, most recently touched first. */
  items(opts: { agentId?: string; includeClosed?: boolean }): WorkItem[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.agentId !== undefined) {
      where.push("agent_id = ?");
      args.push(opts.agentId);
    }
    if (opts.includeClosed !== true) where.push("closed_ms = 0");
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .query(
        `SELECT ${WORK_COLUMNS} FROM work ${clause}
          ORDER BY closed_ms = 0 DESC, updated_ms DESC`,
      )
      .all(...args) as Array<Record<string, string | number>>;
    return rows.map(rowToItem);
  }

  steps(workId: number): WorkStep[] {
    const rows = this.db
      .query(`SELECT * FROM work_steps WHERE work_id = ? ORDER BY idx ASC`)
      .all(workId) as Array<Record<string, string | number>>;
    return rows.map(rowToStep);
  }

  /**
   * Points an item at the plan it is executing. Returns false for an unknown id.
   *
   * Separate from `open` because the link is usually realised LATE — an agent
   * opens an item, works for an hour, and only then notices there was a plan
   * for this all along. Requiring it up front would mean most items never carry
   * one.
   */
  link(workId: number, planDoc: string, nowMs: number): boolean {
    const path = normalisePlanPath(planDoc);
    const run = this.db.transaction((): boolean => {
      const res = this.db
        .query(`UPDATE work SET plan_doc = ?, updated_ms = ? WHERE work_id = ?`)
        .run(path, nowMs, workId);
      if (res.changes === 0) return false;
      this.db
        .query(`INSERT INTO work_events (work_id, ts_ms, kind, body, ref) VALUES (?, ?, 'linked', ?, ?)`)
        .run(workId, nowMs, path === "" ? "unlinked" : `executing ${path}`, path);
      return true;
    });
    return run();
  }

  /**
   * Every plan any item references, rolled up. Newest activity first.
   *
   * DERIVED ON READ, storing nothing. A plan's state is a fact about its work
   * items, and a cached copy is one more thing to fall out of date -- which is
   * the failure this whole feature exists to fix, so reproducing it here would
   * be perverse.
   *
   * Shas come from `landed` events, which the commit hook writes from git's own
   * output. That makes them the only column here that is PROOF rather than a
   * claim: an agent can tick a step it did not do, but it cannot invent a sha
   * git printed.
   */
  planRollups(): PlanRollup[] {
    const rows = this.db
      .query(`SELECT ${WORK_COLUMNS} FROM work WHERE plan_doc != '' ORDER BY updated_ms DESC`)
      .all() as Array<Record<string, string | number>>;

    const byPlan = new Map<string, WorkItem[]>();
    for (const item of rows.map(rowToItem)) {
      const list = byPlan.get(item.planDoc);
      if (list) list.push(item);
      else byPlan.set(item.planDoc, [item]);
    }

    const out: PlanRollup[] = [];
    for (const [planDoc, items] of byPlan) {
      let stepsDone = 0;
      let stepsTotal = 0;
      const shas: string[] = [];
      const agents: string[] = [];
      for (const item of items) {
        for (const s of this.steps(item.workId)) {
          stepsTotal++;
          if (s.doneMs > 0) stepsDone++;
        }
        for (const e of this.events(item.workId)) {
          if (e.kind === "landed" && e.ref !== "" && !shas.includes(e.ref)) shas.push(e.ref);
        }
        if (item.agentName !== "" && !agents.includes(item.agentName)) agents.push(item.agentName);
      }
      out.push({
        planDoc,
        items,
        agents,
        stepsDone,
        stepsTotal,
        shas,
        updatedMs: items.reduce((m, i) => Math.max(m, i.updatedMs), 0),
        openItems: items.filter((i) => i.closedMs === 0).length,
        closedItems: items.filter((i) => i.closedMs > 0).length,
      });
    }
    out.sort((a, b) => b.updatedMs - a.updatedMs);
    return out;
  }

  events(workId: number): WorkEvent[] {
    const rows = this.db
      .query(`SELECT * FROM work_events WHERE work_id = ? ORDER BY id ASC`)
      .all(workId) as Array<Record<string, string | number>>;
    return rows.map(rowToEvent);
  }

  /**
   * Appends an event and bumps the item's `updated_ms`.
   *
   * ONE TRANSACTION, because a board that sorts on `updated_ms` while an event
   * is already visible would order items by a timestamp that has not landed yet.
   */
  record(workId: number, kind: WorkEventKind, body: string, nowMs: number, ref = ""): void {
    const run = this.db.transaction(() => {
      this.db
        .query(`INSERT INTO work_events (work_id, ts_ms, kind, body, ref) VALUES (?, ?, ?, ?, ?)`)
        .run(workId, nowMs, kind, body, ref);
      this.db.query(`UPDATE work SET updated_ms = ? WHERE work_id = ?`).run(nowMs, workId);
    });
    run();
  }

  /** Ticks a step off. Returns false when there is no such step to tick. */
  tick(workId: number, idx: number, note: string, nowMs: number): boolean {
    const step = this.db
      .query(`SELECT * FROM work_steps WHERE work_id = ? AND idx = ?`)
      .get(workId, idx) as Record<string, string | number> | null;
    if (!step) return false;
    const run = this.db.transaction(() => {
      this.db
        .query(`UPDATE work_steps SET done_ms = ?, note = ? WHERE work_id = ? AND idx = ?`)
        .run(nowMs, note, workId, idx);
    });
    run();
    const text = String(step["text"]);
    this.record(workId, "did", note !== "" ? `${text}: ${note}` : text, nowMs, String(idx));
    return true;
  }

  /**
   * Appends a step the original plan missed.
   *
   * This exists because a plan written at the start is always wrong by the
   * middle, and an agent that cannot record a discovered phase abandons the
   * checklist instead of correcting it.
   */
  addStep(workId: number, text: string, nowMs: number): number {
    const run = this.db.transaction((): number => {
      const row = this.db
        .query(`SELECT COALESCE(MAX(idx), 0) AS m FROM work_steps WHERE work_id = ?`)
        .get(workId) as { m: number };
      const idx = Number(row.m) + 1;
      this.db
        .query(`INSERT INTO work_steps (work_id, idx, text) VALUES (?, ?, ?)`)
        .run(workId, idx, text);
      return idx;
    });
    const idx = run();
    this.record(workId, "add", text, nowMs, String(idx));
    return idx;
  }

  /** Closes one item, leaving every other open item alone. */
  close(workId: number, outcome: Exclude<WorkOutcome, "">, body: string, nowMs: number): void {
    const run = this.db.transaction(() => {
      this.db
        .query(`UPDATE work SET closed_ms = ?, outcome = ?, updated_ms = ? WHERE work_id = ?`)
        .run(nowMs, outcome, nowMs, workId);
      this.db
        .query(`INSERT INTO work_events (work_id, ts_ms, kind, body) VALUES (?, ?, 'closed', ?)`)
        .run(workId, nowMs, body !== "" ? body : outcome);
    });
    run();
  }

  /** Records that this item asked its agent to reconcile, so it cannot re-ask. */
  markAsked(workId: number, turnMs: number): void {
    this.db.query(`UPDATE work SET asked_turn_ms = ? WHERE work_id = ?`).run(turnMs, workId);
  }

  /**
   * Drops closed records past their keep window, and the steps and events that
   * belong to them.
   *
   * Events are what actually grow — one per update, and P3's commit detection
   * will add more — so they are bounded by dying with their item rather than by
   * a count of their own.
   */
  pruneWork(nowMs: number): void {
    // From the CONFIG, not the constant. `workKeepMs` was documented in the
    // README and validated in config.ts while this line ignored it — a setting
    // that silently did nothing. The config tests missed it because they only
    // compared DEFAULTS to each other and never asserted that a config FILE is
    // honoured, which is the "test stubbed above the bug" shape exactly.
    const cutoff = nowMs - loadConfig().workKeepMs;
    const dead = `(SELECT work_id FROM work WHERE closed_ms > 0 AND closed_ms <= ?)`;
    const run = this.db.transaction(() => {
      this.db.query(`DELETE FROM work_steps WHERE work_id IN ${dead}`).run(cutoff);
      this.db.query(`DELETE FROM work_events WHERE work_id IN ${dead}`).run(cutoff);
      this.db.query(`DELETE FROM work WHERE closed_ms > 0 AND closed_ms <= ?`).run(cutoff);
    });
    run();
  }
}

/** Progress over a checklist. `total` 0 means the agent chose not to write one. */
export interface StepProgress {
  readonly done: number;
  readonly total: number;
  /** The lowest-numbered outstanding step, or null when there is none. */
  readonly current: WorkStep | null;
  readonly outstanding: readonly WorkStep[];
}

export function progress(steps: readonly WorkStep[]): StepProgress {
  const outstanding = steps.filter((s) => s.doneMs === 0);
  return {
    done: steps.length - outstanding.length,
    total: steps.length,
    current: outstanding[0] ?? null,
    outstanding,
  };
}

/**
 * The current state of an item, folded from its events.
 *
 * Deliberately a fold and not stored columns: `board` and `board --history` read
 * the same rows, so the summary cannot drift from the timeline it summarises.
 */
export interface WorkFold {
  /** Every commit recorded against the item, in order. */
  readonly landed: readonly string[];
  /** Un-retracted consequences. A later empty `breaks` clears them. */
  readonly breaks: readonly string[];
  /** The current blocker, or "" — a later empty `needs` clears it. */
  readonly needs: string;
  /** The latest `step` body: what the agent said it was in the middle of. */
  readonly status: string;
}

export function foldEvents(events: readonly WorkEvent[]): WorkFold {
  const landed: string[] = [];
  let breaks: string[] = [];
  let needs = "";
  let status = "";
  for (const e of events) {
    switch (e.kind) {
      case "landed":
        if (e.ref !== "" && !landed.includes(e.ref)) landed.push(e.ref);
        break;
      case "breaks":
        // An empty body RETRACTS. A consequence that turned out not to happen
        // has to be withdrawable, or the board accumulates warnings that are no
        // longer true and peers learn to skip them.
        if (e.body.trim() === "") breaks = [];
        else breaks.push(e.body);
        break;
      case "needs":
        needs = e.body.trim();
        break;
      case "step":
        status = e.body;
        break;
      default:
        break;
    }
  }
  return { landed, breaks, needs, status };
}
