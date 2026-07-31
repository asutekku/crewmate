# Work records — a shared board of what each agent is doing

*Created: 2026-07-31*

**P0 shipped 2026-07-31. P1–P5 are still plan.** What P0 covers is marked in the
phase table at the bottom; everything else here describes work not yet built.
The shipped behaviour is documented in `README.md` under *The work board* — this
file stays as the reasoning behind it, not as its documentation.

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

A durable record per unit of work — several open at once, each with a checklist
the agent wrote — kept honest by a `Stop` hook that asks the agent to reconcile
against it before going idle. It replaces nothing and steals its content from
what agents already write unprompted.

```
$ cli.ts board

  old-core-retirement-80                                  2 open · 1 closed
    ▸ retiring the old net core                        2h · updated 4m
      ✓ 1  delete buildGraph and the core flag
      ✓ 2  migrate the 12 withNetworkCore call sites
      ▪ 3  re-record baselines            ← current
      landed   3e36ff9  2f2ac31
      ⚠ breaks road baselines move (seed 42: 143→213 strokes); re-record
               citizenBaseline.json before this reaches master
    ▸ junction sliver fix                             40m · updated 12m
      ✓ 1  a cut shared by 2+ alignments is never absorbed
      ▪ 2  verify across the six generated seeds
    ✓ road harness for terrain-controlled tests        closed 1h ago
    files      src/net/ (16 files)

  water-sim-timberborn-e2                                 1 open · 2 closed
    ▸ cheap fluid simulation                           3h · updated 1m
      ✓ 1  per-texel pack (194.5ms → 39.5ms, byte-identical)
      ▪ 2  shore fade banding on shallow ponds   ← current
      ▪ 3  chunk uploads
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

### Three tables, because it has to be a timeline

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

`work_steps` — the checklist, one row per phase. The only mutable field is
`done_ms`, so ticking a step is not an event-fold question.

| Field | Notes |
|---|---|
| `work_id`, `idx` | ordering within the item |
| `text` | the phase, in the agent's own words |
| `done_ms` | 0 while outstanding |
| `note` | what actually happened, set when ticked; optional |

`work_events` — append-only. **Nothing here is ever updated in place.**

| Field | Notes |
|---|---|
| `id`, `work_id`, `ts_ms` | ordering |
| `kind` | `started` `step` `did` `landed` `breaks` `needs` `note` `closed` |
| `body` | the text |
| `ref` | a sha for `landed`, a step index for `step`/`did`, else empty |

Current state is a *fold* over the events, not a stored column: `status` is the
latest `step`, `landed` is every `landed` ref, `breaks` is every un-retracted
`breaks`. This is what makes `board --history` and `board` the same data.

Steps are deliberately **not** derived from the event fold. "Which phases remain"
is asked on every `Stop` (see *The idle check*), and it must be one indexed
query rather than a replay of an agent's whole history.

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
| conversation title | **5 of 5** | unique — but see the correction below |

Worktree+branch was the intuitive answer and it is **wrong**: most agents work in
the main tree, so it merges four unrelated agents into one timeline — the exact
failure ruling 2 exists to prevent.

> **CORRECTED 2026-07-31 — the premise of this whole section was false.**
>
> The paragraph above rests on "a restarted terminal is a new session id". **It
> is not.** `CLAUDE_CODE_SESSION_ID` is the *conversation* uuid: it names the
> transcript on disk and it is what `claude --resume <uuid>` takes. Measured on
> this tool's own conversation — restarted mid-session, display name moved
> `traffic-a0` → `traffic-7c`, session id stayed `c5ce05bc-…` throughout, and
> the roster row was never replaced.
>
> So the title solved a problem that did not exist, and cost two real ones: it is
> **model-written and rewritten as a conversation develops**, so renaming a
> conversation orphaned every record under the old name; and it is empty until
> the first title lands, splitting early records onto a fallback key.
>
> **The session id is the key.** `agentKey` still *takes* a title and ignores it,
> so every call site reads as "identity, given what we know about this session"
> rather than being quietly rewritten to pass one argument fewer.
>
> The lesson generalises past this feature: the title measurement was real and
> the conclusion drawn from it was wrong, because the *comparison* was never
> tested. Five titles being distinct says nothing about whether the thing they
> were replacing needed replacing.

Store the resolved key on the `work` row at creation, so the record still names
its owner after that session is gone.

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
cli.ts doing "<subject>" --plan "a; b; c"       # OPEN an item with a CHECKLIST
cli.ts did   <n> ["<what changed>"]             # tick step n off
cli.ts step  <n> "<status>"                     # working on step n, not finished
cli.ts add   "<step>"                           # a phase the plan missed
cli.ts landed <sha> [--breaks "<consequence>"]  # usually automatic; this is the override
cli.ts breaks "<consequence>"                   # the field that matters most
cli.ts needs  "<what is blocking>"              # or "" to clear
cli.ts done  ["<subject match>"] [--abandoned]  # close one item
cli.ts board [<agent>] [--history] [--all]      # read; --all includes closed
cli.ts mine                                     # MY open items and unticked steps
```

With several items open, every command needs to know *which*. Rule: **the most
recently touched item, unless a subject substring is given** — `cli.ts done
sliver` closes the junction item. Cheap to implement, and matches how an agent
narrates ("finished the sliver fix, back to the core work").

Identity of the caller comes from `CLAUDE_CODE_SESSION_ID`, as `msg` already
does — no `--from` to forget. It is then resolved to the agent key above.

### The checklist is per phase, and the agent owns it

*(User ruling, 2026-07-31: one entry per phase — "that's how agents like to
work".)*

`--plan` therefore stores **steps as rows**, not a display string:

`work_steps` — `work_id`, `idx`, `text`, `done_ms`, `note`.

This is what open question 2 was asking, and the answer is now forced: the idle
check (below) has to name *which* step is outstanding, and `2/3` has to be
derived rather than typed. A `→`-joined string cannot do either.

Steps are the agent's own decomposition, not a schema we impose. `add` exists
because a plan written at the start is always wrong by the middle, and an agent
that cannot record a discovered phase will abandon the checklist instead.

#### The agent decides whether it needs one

*(User ruling, 2026-07-31: ask the agent — "I assume they are smart enough to
assess the requirement of the task. We can say 'quick checks do not need a
checklist'".)*

`--plan` is optional. `doing "<subject>"` alone opens an item with no steps, and
that is a legitimate end state, not a half-filled form. The agent judges whether
the work has phases worth tracking.

The prompt is one line, at session start beside the roster, phrased as
permission rather than instruction:

> Work worth tracking across turns can be recorded with
> `cli.ts doing "<subject>" --plan "a; b; c"`, and peers can read it with
> `cli.ts board`. **Quick checks and one-off questions do not need a checklist.**

Saying *when not to* is the load-bearing half. A prompt that only says "record
your work" gets one of two failures: agents dutifully open an item for "what does
this function do", burying the real ones, or they read it as boilerplate and
ignore it entirely. Naming the exemption makes it a judgement call, which is what
an agent is good at.

**This is also the switch for everything strict.** Whether a checklist exists is
now a real signal — an agent that opened one has declared the work worth
tracking. That is what makes the graduated strictness in *Optional now, stricter
later* possible without ever nagging an agent doing a five-minute fix.

### The idle check — closing the loop

*(User ruling, 2026-07-31: when an agent stops to idle, the hook asks whether it
has updated and validated against its tasks.)*

This is what makes the checklist more than decoration. A record an agent writes
once and never revisits is worse than none — it looks current and is not.

**The event is `Stop`, not `TeammateIdle`.** `TeammateIdle` fires only for
agent-team teammates spawned by a lead; independently launched sessions — which
is all of these — never emit it. `Stop` is where a turn ends, which is the
moment the user described.

**The mechanism is `additionalContext`, not `decision: "block"`.** Both continue
the turn under the same protections, but `block` renders as a hook *error* and
reads as a refusal to let the agent stop. HOOKS.MD names this exact use case for
`additionalContext`: *"Use additionalContext when the hook is working as
designed and giving Claude guidance, such as 'run the test suite before
finishing'."* The register matters — the tool advises, it does not enforce.

What the agent sees at `Stop`, only when there is something to reconcile:

```
Your open work record has 2 steps not ticked off:
  2. migrate the 12 withNetworkCore call sites
  3. re-record citizenBaseline.json
You edited 16 files this turn. If a step is done, `cli.ts did 2`; if the plan
changed, `cli.ts add "<step>"`. If neither, nothing to do.
```

**Silent unless it has a question.** It fires only when **all three** hold: the
agent has an open item, that item **has a checklist**, and at least one step is
unticked. Anything else stops with no injection at all.

The checklist condition is the one that must not be relaxed. An open item with
no steps is a deliberate end state — the agent judged the work not worth phasing
— so asking about it would punish exactly the honest use of `doing` for a quick
fix. "Has edits this turn" is deliberately NOT sufficient on its own for the
same reason: an agent editing files without a checklist has told us nothing is
outstanding. It is used only to decide whether the reminder is worth showing for
an item that already has unticked steps.

Three guards, because a `Stop` hook that continues the turn is the one place
this tool could genuinely misbehave:

1. **`stop_hook_active` short-circuits it.** `turn-end.ts` already checks this.
   Without it a hook that continues a turn can be re-entered by its own
   continuation.
2. **Once per work item per turn.** Recorded on the item, so a turn that
   continues for another reason cannot re-ask.
3. **It never blocks.** No `decision: "block"`, so the 8-continuation cap is a
   backstop and not the mechanism. An agent that ignores it three times stops
   anyway — being asked is not being required.

**Cost.** This rides `turn-end.ts`, which already runs on every `Stop`, so it is
one extra query on a hook that is already open. No new registration.

#### Optional now, stricter later — but only where a checklist exists

*(User ruling, 2026-07-31: optional first, with an easy migration to mandatory
**if such a checklist exists** — which links back to letting the agent decide
whether it needs one.)*

The two rulings compose into a rule with a natural gate: **strictness applies
only to work an agent itself declared worth tracking.** An agent doing a quick
check opened no item, so no level below ever touches it. That is what makes
raising the level safe.

The check is therefore built as one function returning a *level*, not as a
scattered set of conditions:

| Level | Behaviour when steps are outstanding | Applies to |
|---|---|---|
| `off` | nothing | — |
| **`remind`** ← ship here | `additionalContext`; agent may ignore it and stop | items with a checklist |
| `insist` | `additionalContext` on the first N stops, then let it go | items with a checklist |
| `require` | `decision: "block"` until every step is ticked or the item is closed | items with a checklist |

Only the level constant changes. Nothing else in the hook needs rewriting,
because the guards it already needs at `remind` — `stop_hook_active`, once per
item per turn, a bounded number of asks — are exactly the guards `require`
needs. Building `remind` without them and adding them later would be a rewrite;
building them now makes the migration a one-line change.

**Why not ship `require`.** Blocking a stop is the strongest thing a hook can
do, and the failure mode is bad in a way that reminding is not: an agent that
cannot tick a step because the step was wrong is stuck against the
8-continuation cap, and the only escape (`done --abandoned`) is the one command
it may not think to reach for. Ship `remind`, watch whether agents actually tick
steps, and raise it only if they do not.

**Two things must exist before `require` is safe**, and both are cheap now:
`add` (so a discovered phase can be recorded rather than blocking on a stale
plan) and `done --abandoned` (so a pivot has an exit). Both are already in the
command list for P0 — they are not there by accident.

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
| **P0 — SHIPPED** | `work` + `work_steps` + `work_events`; agent key from title with session fallback; `doing --plan`/`did`/`step`/`add`/`done`/`board`/`mine` | ✅ Two items open at once for one agent, both listed with their checklists; closing one leaves the other |
| **P1** | Hook auto-fill: subject from title, files from claims, lifecycle from existing hooks | An agent that never calls the CLI still has a usable row |
| **P2** | **The idle check** in `turn-end.ts` — unticked steps + edits since last update, via `additionalContext`, behind a `remind`/`insist`/`require` level constant | It fires when a step is outstanding, stays SILENT for an item with no checklist, never fires twice for one item in one turn, and flipping the constant to `require` needs no other edit |
| **P3** | `PostToolUse` commit detection → `landed` events | Real shas appear with no agent action |
| **P4** | `breaks`/`needs`; `board --history`; `breaks` delivered to intersecting peers as non-interrupting context | A `breaks` reaches exactly the overlapping agents and ends nobody's turn |
| **P5** | 7-day prune for closed records; SessionStart shows open items; `who` gains a one-line `▸ status` | Roster stays inside 80 columns; a closed record survives a restart and expires on time |

**P2 moved up**, ahead of commit detection. The idle check is what makes the
checklist self-maintaining, and it is also the riskiest thing here — it is the
only part that can interrupt an agent's turn. Better to learn early whether it
reads as helpful or as nagging, on a small feature, than to build three more
phases on top of a loop that turns out to be annoying.

P0–P2 are the bet: a checklist agents write and a hook that keeps it honest. If
agents ignore `doing` but the auto-filled rows still tell *you* what is
happening, that is already a win and P4 is optional.

**P0 must prove the timeline property**, not just that a row can be written —
the append-only event table is the whole design, and a P0 that stores current
state in columns will not grow into `--history` later.

### What P0 established (2026-07-31)

Both gates hold, and the timeline property is tested rather than asserted:
`test/work.test.ts` walks an item through seven events and checks that ids and
timestamps ascend, that `foldEvents` reconstructs `landed`/`breaks`/`needs`/
`status` from them alone, and that a **restarted session picks up the checklist
its predecessor opened** — the property the title-keyed identity exists for,
verified end-to-end as well (a session registered as `e2e-session-2` ticked step
2 of an item `e2e-session-1` had opened). 46 tests across `work` and `board`;
165 in the tool overall, all green.

Three things the plan did not anticipate:

- **`add` had to work on an item with no plan.** The command list treated it as a
  correction to an existing checklist, but it is also the only path from "no
  checklist" to "a checklist" — which is exactly the transition P2's strictness
  gate reads. Tested from both directions.
- **`step` earned its place after all**, and is in P0 rather than P4. Without it
  an item with no checklist has nothing to say between `doing` and `done`, and
  that is the item the auto-fill phases will produce most of.
- **The board's widths must be measured on unpainted text.** Padding computed
  from a painted string counts ANSI escapes as columns, so the age column drifted
  by ~8 characters per colour — and only in a terminal, never in a piped test.
  `board.ts` therefore takes a paint callback and computes every width before
  painting; `test/board.test.ts` asserts the painted and plain lines are identical
  once escapes are stripped, and that no line exceeds the terminal at 40/60/80.

One thing deliberately built early: `work.asked_turn_ms` and `markAsked` are in
the schema and tested, though nothing reads them until P2. They are the "once per
item per turn" guard, and the plan's claim that flipping to `require` is a
one-constant change is only true if that guard exists from the start.

## Risks

**Agents may not use it** — the task board's 0 rows. Mitigated by hooks filling
the skeleton, so the feature degrades to "a better `who`" rather than to nothing.
**Measure before building P4**: if `work` rows are all hook-authored after a
week, the agent-facing verbs are not earning their place.

**The idle check is the one thing here that can annoy.** Everything else in this
tool is passive; this asks an agent a question at the moment it is trying to
finish. Get the silence condition wrong and it fires on every turn, agents learn
to skim past hook feedback, and it degrades the overlap warnings that already
work.

The opt-in gate cuts most of this: an agent that opened no checklist is never
asked anything, so the blast radius is exactly the work an agent declared worth
tracking. What remains is an agent that opens a checklist, pivots, and gets
asked about a plan it abandoned — `done --abandoned` is the answer, and whether
agents reach for it is the main thing P2 is watching for. If it still reads as
nagging, cut it; the checklist is useful without it, and P2 is deliberately
early so that call is cheap.

**Nobody may opt in at all.** The task board's 0 rows is the precedent, and
`--plan` being optional makes ignoring it the path of least resistance. This is
the accepted trade for not nagging — and the hook-authored rows (P1) still carry
subject, files, commits and lifecycle, so the board stays useful even if no agent
ever writes a step. If after a week no checklists exist, the answer is to look at
whether the session-start line reads as permission or as boilerplate, not to
force the feature on.

**`breaks` is only as good as what agents write.** It cannot be derived. The
evidence says they already write it (18 of 25 broadcasts) — this gives it a
field instead of a paragraph.

**Another table to keep true.** `work` overlaps `claims` (files) and `sessions`
(status/title). Rule: **`work` stores no field another table owns** — it
references them. `files` is a query against `claims`, not a copy.

**Row growth, now that events append.** `work` grows one row per work item, but
`work_events` grows per *update* — and with P3 auto-recording every commit, a
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
4. **Agents write their own checklist, one entry per phase**, and a `Stop` hook
   asks them to reconcile against it — "that's how agents like to work". This is
   why `work_steps` is a table rather than a display string: the idle check has
   to name which phase is outstanding, and `2/3` has to be derived.
5. **`board` gains a one-line `▸ status` in `who`.** Confirmed; scheduled for P5
   so the field is known to be populated before it takes roster space.
6. **The agent decides whether it needs a checklist**, told plainly that quick
   checks do not need one. `--plan` is optional and an item with no steps is a
   legitimate end state.
7. **The idle check ships optional (`remind`) with a one-constant path to
   mandatory (`require`)**, and strictness applies ONLY to items that have a
   checklist — so raising the level can never affect an agent doing a quick fix.

## Open questions

1. **Should a ticked step record what actually happened?** `work_steps.note` is
   in the schema and `did <n> "<what changed>"` accepts it, but nothing requires
   it. It is the difference between "step 2 done" and "step 2 done: 12 call sites
   migrated, 2 needed a different fix" — which is what makes the timeline worth
   reading later. Optional for now; if agents leave it empty, the history is
   thinner but nothing breaks.
2. **What is the right N for `insist`?** Only matters if `remind` proves too
   weak, and the honest answer is that it should be picked from watching how many
   stops agents take before ticking a step. Not decidable in advance.
