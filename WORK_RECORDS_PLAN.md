# Work records — a shared board of what each agent is doing

*Created: 2026-07-31*

**PLAN ONLY. Nothing here is implemented.**

## The problem, measured

Agents already write status reports. They just have nowhere to put them, so they
go out as broadcasts:

| Signal | Measured 2026-07-31 |
|---|---|
| `say` bodies, last 40 | median **681** chars, max **2575** |
| over 1000 chars | **15 of 40** |
| mention a commit / "landed" | 18 of 25 |
| warn others about a consequence | 17 of 25 |
| describe a breaking change | 18 of 25 |
| carry test results | 14 of 25 |

A representative one, sent while this plan was being written:

> *"R3 landed (3e36ff9, worktree old-core-retirement, still off master).
> buildGraph AND the network-core flag are DELETED … Behaviour change worth
> knowing: two parallel roads closer than SNAP (10m) NO LONGER collapse …"*

That is a **work record** — subject, branch, what landed, what it breaks, what
to re-record — delivered as a wall of prose that arrives once and then scrolls
away. An agent joining an hour later cannot ask "what is old-core-80 doing and
what has it broken?" It can only read backwards through the log.

### Why the existing task board does not already solve this

`tasks` exists, `TaskCreated`/`TaskCompleted` are wired, and `who` renders a
`[2/4 tasks]` column. **The table has 0 rows.** Independently launched sessions
do not create Claude Code tasks — the feature is for agent teams with a lead.

The lesson is the load-bearing one for this design: *a channel agents do not
already use will not be used because we built a nicer one.* The 42 `say`
messages are the demand; the 0 tasks are the warning.

## What this adds

One durable record per agent per unit of work, replacing nothing and stealing
its content from what agents already write unprompted.

```
$ cli.ts board

  old-core-retirement-80                                  2 open · 1 closed
    ▸ retiring the old net core                        2h · updated 4m
      plan     delete buildGraph → migrate callers → re-record baselines
      now      3/3 · unwrapping withNetworkCore call sites
      landed   3e36ff9  2f2ac31
      ⚠ breaks road baselines move (seed 42: 143→213 strokes); re-record
               citizenBaseline.json before this reaches master
    ▸ junction sliver fix                             40m · updated 12m
      now      a cut shared by 2+ alignments is never absorbed
      landed   9814150
    ✓ road harness for terrain-controlled tests        closed 1h ago
    files      src/net/ (16 files)

  water-sim-timberborn-e2                                 1 open · 2 closed
    ▸ cheap fluid simulation                           3h · updated 1m
      plan     shore fade → chunk uploads → per-texel pack
      now      2/3 · fixing shore fade banding on shallow ponds
      landed   db6d450  c17a24c
      ⚠ breaks water texture channel layout; G is now unread on wet cells
    files      src/render/ground/ (7 files)  +1 scratch
```

Several open items per agent, because agents genuinely multitask —
`old-core-retirement-80` shipped a junction fix in the middle of a core
retirement, and collapsing those into one line loses both.

And because every state change is an event, the same data reads as history:

```
$ cli.ts board old-core-retirement-80 --history

  retiring the old net core                    started 2h ago
    2h    started   delete buildGraph → migrate callers → re-record
    1h40  step 1/3  buildGraph and the core flag deleted
    1h05  landed    2f2ac31
    1h04  breaks    generation moves: seed 42 143→213 strokes
    38m   step 2/3  12 call sites migrated
    12m   landed    3e36ff9
     4m   step 3/3  unwrapping withNetworkCore call sites
```

The `⚠ breaks` line is the point. Today that fact exists only inside a 2575-char
broadcast that scrolled past.

## Design

### Two tables, because it has to be a timeline

**User ruling, 2026-07-31: several open records per agent, keyed to the agent,
and the whole thing works as a timeline — "one record is useless".**

That rules out a single mutable row per agent. A row that is overwritten answers
"what now?" and destroys "what happened?", and the second question is the one
asked days later ("who broke the baselines?"). So:

`work` — one row per work item. Slow-moving, and **several may be open at once**.

| Field | Written by | Notes |
|---|---|---|
| `work_id` | store | stable, referenced by events |
| `agent_id` | **hook** | see *Identity* below — NOT the session id |
| `subject` | agent, or falls back to the conversation title | one line |
| `plan` | agent | ordered steps, `→`-joined; optional |
| `startedMs` / `closedMs` | hook + agent | `closedMs = 0` means open |
| `outcome` | **hook** at SessionEnd, agent may override | `done` / `abandoned` |

`work_events` — append-only. **Nothing here is ever updated in place.**

| Field | Notes |
|---|---|
| `id`, `work_id`, `ts_ms` | ordering |
| `kind` | `started` `step` `landed` `breaks` `needs` `note` `closed` |
| `body` | the text |
| `ref` | a sha for `landed`, a step number for `step`, else empty |

Current state is a *fold* over the events, not a stored column: `status` is the
latest `step`, `landed` is every `landed` ref, `breaks` is every un-retracted
`breaks`. This is what makes `board --history` and `board` the same data.

### Identity: agent, not session

Keying on `session_id` would break the timeline exactly when it matters — a
restarted terminal is a new session, so today's `traffic-a0` and yesterday's
`traffic-aa` are unrelated rows even when they are the same person doing the
same work. The user's phrase was "recorded to agent ids".

The problem: nothing durable identifies "the agent" across restarts. Handles are
recycled, `traffic-XX` names are per-process, and the session id changes.

Three candidates, tested against the live roster of 5 agents rather than
reasoned about:

| Key | Distinct | Verdict |
|---|---|---|
| worktree + branch | **2 of 5** | 4 agents collapse onto `Traffic#master` |
| worktree only | **2 of 5** | same collapse |
| **conversation title** | **5 of 5** | unique for every agent |

Worktree+branch was the intuitive answer and it is **wrong**: most agents work in
the main tree, so it merges four unrelated agents into one timeline — the exact
failure ruling 2 exists to prevent.

**The conversation title is the key.** It is also stable: across the six largest
transcripts, five never changed their title at all, and it survives a restart of
the same conversation because it is read from the transcript rather than
assigned per process.

Known gaps, both acceptable:

- **`/clear` starts a new title**, so it starts a new timeline. That is arguably
  correct — a cleared conversation *is* new work.
- **An untitled session** (3 of 25 transcripts, all predating the feature) falls
  back to `session_id`, i.e. today's behaviour, degrading to one timeline per
  run rather than to nothing.

Store the resolved key on the `work` row at creation so a later title change
cannot orphan existing records.

### Hooks fill the skeleton; agents enrich

Chosen because the 0-row task board proves agents skip optional work. **An agent
that never calls the CLI still produces a usable row** — subject from the
conversation title, files from claims, commits from `PostToolUse`, lifecycle
from `SessionStart`/`Stop`/`SessionEnd`.

Everything above is already available:

- `subject` — the `title` column added on 2026-07-31 (transcript `ai-title`)
- `files` — the `claims` table, already populated per edit
- `updatedMs` — any hook firing is a heartbeat
- `landed` — **new**: `PostToolUse` matching `Bash`, scanning for `git commit`.
  This is the one new hook registration and the only new detection logic.

### The agent-facing commands

Deliberately few, and each maps to a sentence agents already write:

```sh
cli.ts doing "<subject>" [--plan "a → b → c"]   # OPEN a new item (does not close others)
cli.ts step  <n> "<status>"                     # progress on the most recent item
cli.ts landed <sha> [--breaks "<consequence>"]  # usually automatic; this is the override
cli.ts breaks "<consequence>"                   # the field that matters most
cli.ts needs  "<what is blocking>"              # or "" to clear
cli.ts done  ["<subject match>"] [--abandoned]  # close one item
cli.ts board [<agent>] [--history] [--all]      # read; --all includes closed
```

With several items open, every command needs to know *which*. Rule: **the most
recently touched item, unless a subject substring is given** — `cli.ts done
sliver` closes the junction item. Cheap to implement, and matches how an agent
narrates ("finished the sliver fix, back to the core work").

Identity of the caller comes from `CLAUDE_CODE_SESSION_ID`, as `msg` already
does — no `--from` to forget. It is then resolved to the agent key above.

### Delivery: pull, not push

`board` is a command, not an injection. The roster injection stays as it is.

**Rationale.** Injected context is on every agent's hot path every turn, and the
per-agent record is 4–6 lines — seven agents would add ~35 lines per turn to
tell each agent six things it does not need. Two exceptions push:

1. **`breaks` is delivered once** to peers whose claims intersect the changed
   area, using the existing directed-claim mechanism. A consequence nobody reads
   is the whole failure mode.
2. **SessionStart shows open records**, once, where the roster already appears.

**`breaks` informs; it does not interrupt.** *(User ruling, 2026-07-31: "they
should steer the agent and agent should be able to make their own decisions".)*
Concretely, it is delivered as ordinary context at the recipient's next
turn boundary — it does **not** end a turn the way a directed message does, and
it never blocks a tool call. The recipient decides what it means for their work;
an agent mid-benchmark may reasonably finish the run before re-recording.

This is the same stance the rest of the tool takes — `pre-edit` warns and never
blocks — and it is why `breaks` text should read as a consequence ("road
baselines move; seed 42 goes 143→213") rather than an instruction ("re-record
your baselines"). A stated fact steers; an order invites either compliance
without understanding, or being ignored as noise.

### What it does NOT do

- **No enforcement.** Nothing blocks, nothing is required, no agent is nagged
  into reporting. Consistent with the tool's advisory stance.
- **No workflow.** No assignment, no dependencies, no "waiting on X". `needs` is
  free text a human reads.
- **No replacement for `say`.** Discussion stays a conversation; the record is
  the durable summary beside it.

## Phases

| Phase | Contents | Gate |
|---|---|---|
| **P0** | `work` + `work_events` tables; agent key from title with session fallback; `doing`/`done`/`board` | Two items open at once for one agent, both listed; closing one leaves the other |
| **P1** | Hook auto-fill: subject from title, files from claims, lifecycle from existing hooks | An agent that never calls the CLI still has a usable row |
| **P2** | `PostToolUse` commit detection → `landed` events | Real shas appear with no agent action |
| **P3** | `step`/`breaks`/`needs`; `board --history`; `breaks` delivered to intersecting peers as non-interrupting context | A `breaks` reaches exactly the overlapping agents and ends nobody's turn |
| **P4** | 7-day prune for closed records; SessionStart shows open items; `who` gains a one-line `▸ status` | Roster stays inside 80 columns; a closed record survives a restart and expires on time |

P0–P1 are the bet: if agents ignore `doing` but the auto-filled rows are still
useful to *you*, that is already a win and P3 is optional.

**P0 must prove the timeline property**, not just that a row can be written —
the append-only event table is the whole design, and a P0 that stores current
state in columns will not grow into `--history` later.

## Risks

**Agents may not use it** — the task board's 0 rows. Mitigated by hooks filling
the skeleton, so the feature degrades to "a better `who`" rather than to nothing.
**Measure before building P3**: if `work` rows are all hook-authored after a
week, the agent-facing verbs are not earning their place.

**`breaks` is only as good as what agents write.** It cannot be derived. The
evidence says they already write it (18 of 25 broadcasts) — this gives it a
field instead of a paragraph.

**Another table to keep true.** `work` overlaps `claims` (files) and `sessions`
(status/title). Rule: **`work` stores no field another table owns** — it
references them. `files` is a query against `claims`, not a copy.

**Row growth, now that events append.** `work` grows one row per work item, but
`work_events` grows per *update* — and with P2 auto-recording every commit, a
busy agent could add dozens a day. Bounded three ways: events belong to a work
item and die with it; closed items prune at 7 days (ruling 1) on their own
sweep, since `STALE_MS` is about liveness and these are deliberately history;
and `board` folds rather than prints, so a hundred events still render as five
lines.

**Two open items are easy; ten are a mess.** Ruling 2 wants multitasking
represented, but nothing stops an agent opening items it never closes, and the
"most recently touched" targeting rule quietly gets worse as the list grows.
Cheap guard: `board` shows open items beyond the first three as a count, and
SessionEnd closes anything still open with `outcome = abandoned` — which is
honest, and makes a forgotten item look like what it is.

## Decided (user, 2026-07-31)

1. **Records outlive their session.** Closed records are kept **7 days** and
   shown by `board --all`. "Who broke the baselines?" is asked days later, and
   the record is worthless if it evaporates when a terminal closes. This is the
   first thing in the tool that is deliberately *history* rather than live
   state, so it is exempt from the `STALE_MS` sweep and needs its own prune.
2. **Several open items per agent, keyed to the agent, and it works as a
   timeline** — "one record is useless". This is why `work_events` is
   append-only and current state is a fold rather than a stored column.
3. **`breaks` steers, it does not interrupt.** Agents make their own decisions;
   the record informs them. No turn is ended and no tool call is blocked.

## Open questions

1. **Should `plan` steps be structured rather than a `→` string?** A real list
   makes `2/3` derivable and lets `step` reference a step by name. It also makes
   `doing` fussier to call. Suggest string for P0, revisit if `step` is used.
3. **Does `board` belong in `who`?** A one-line `▸ status` per agent would put
   the moving fact where you already look, at ~7 extra lines. Suggest yes, after
   P3 proves the field is populated.
