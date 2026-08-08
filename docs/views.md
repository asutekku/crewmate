# Views — what each command shows you

[← README](../README.md)

## Your view

Run from anywhere inside a project; it resolves the same roster the hooks use.

```sh
crew who        # roster + claims
crew log 20     # recent messages
crew msg <name> "..." # send to ONE agent
crew say "..."       # broadcast to every agent
crew quit <name> # drop an agent from the roster
crew where      # which project/db this dir maps to
crew clear      # wipe roster (log self-prunes)
crew board      # the work board — see below
```

### Ending an agent

`quit` **deregisters, it does not kill.** Terminating a `claude.exe` destroys whatever that agent held in context, and nothing here can reliably tell a session whose terminal was closed from one merely sitting idle — measured 2026-07-31: the window handle is `0` for _every_ session including live ones, process ancestry is byte-identical between a closed tab and a working session, and CPU time looked decisive over a 6-second sample then **inverted** over 25 seconds. With no dependable liveness signal, killing on a guess eventually kills a working agent. Dropping the row is safe and reversible: any hook the session fires re-registers it.

Before it drops a row, `quit` names what that row was protecting — a path two agents both hold loses its collision warning when one of them leaves:

```
$ crew quit ada
ada — just now
  process 8520 is still running; this only clears the roster row
  ⚠ holds src/shared.ts, also held by turing
  releasing 1 claim(s)
  ✓ deregistered
```

`who` also counts **background processes** — running Claude sessions in this repo that no roster row accounts for. These are the ones whose terminal was closed: the window is gone, the process is not, and nothing else reports them. Two were found running for 48 hours in worktrees no longer in use.

```
3 background process(es) — no window, not on the roster:
    pid 37476   luna    footprint-merge  started 48h ago
    pid 46020   rowan   industry-demand  started 48h ago
```

The pid is the point — it is the only handle you have on a process with no window. What to do about one is your call; the tool never touches it.

**A closed terminal usually deregisters itself.** `SessionEnd` fires with `prompt_input_exit` on a double ⌃C and the row goes; `clear` and `resume` are deliberately spared, since neither means the agent left. Verified against every documented reason. A row that lingers anyway is a session running hooks from _before_ that logic shipped — the roster's `⟲` marks those.

`say` reaches everyone at once, so it beats retyping a correction eight times; `msg` is the targeted version. `where` is the first thing to check if a roster looks empty.

`who` is colourised for the terminal:

- **each agent gets its own colour**, assigned across the roster so no two ever share one, and stable for a given roster
- **activity age** reads green (<5 min), amber (<15 min), then dim
- **red marks a contested file** — a path two live agents both hold — and a summary lists them at the bottom. Red is used for nothing else, so it always means "look at this"
- **the branch and worktree only appear when they differ** between agents; four agents in one tree don't need `[worktree Traffic] on master` four times
- **the quoted headline is the conversation's name** — Claude Code's own `ai-title`, the same string its session picker shows, so a roster line and the window it refers to are recognisably the same thing
- **`doing:` is what that session is working on now**, written by Haiku from its recent output. The title is set from the conversation's opening subject and does not move; this line does

```
vega        "Explore cheap agent communication solutions"   · just now
    doing Wiring transcript titles into the roster
    editing .claude/hooks/presence/core/transcript.ts, …
```

**Neither field enters any agent's injection.** A title names a window on your screen, which is exactly what makes it useful to you and useless to a peer — so no session-start block or hook ever spends budget on either. That text would be on every agent's hot path on every turn, and it stays lean.

*Injection*, precisely — not "an agent can never see this". An agent that runs `crew who` reads the same output you do, `--raw` included; `--raw` drops colour for piping, it is not an agent-only format. The guarantee is about what is **pushed** into a context window, not about what a session can **pull** on request. (Stated this way after the looser wording — "never enter any agent's context" — was read alongside advice steering agents to `--raw`, which prints both fields. One of the two had to give, and the budget claim is the one worth keeping.)

**The `doing:` line is model-written, not agent-stated.** Haiku summarises the session's recent output; the agent never asserted it. Worth knowing before acting on one — it describes what a session appears to be doing, which is not the same as what it would tell you if you asked.

Colour is a second channel, never the only one: every distinction is also in the words. `NO_COLOR`, `FORCE_COLOR` and piping are honoured, so a redirected log is plain text.

**Hook output is never colourised** — it goes into an agent's context window, where escape codes cost tokens and buy nothing.

## Who touched what

```sh
crew files rowan                 # every file that agent has touched  [--hours 24]
crew blame src/gen/terrain.ts    # who has been in this file, newest first
```

```
$ crew files rowan
rowan — 6 file(s) in 24h  (session ended — this is history)
  ▸ terrain gen perf: dedup shore field, fix erode wrap  1/3
    now  fix the horizontal wrap in erode
     8m ago  src/gen/terrain.ts ×3
    12m ago  test/unit/gen/terrain.test.ts
    15m ago  docs/systems/terrain-water.md

$ crew blame src/gen/terrain.ts
src/gen/terrain.ts
     9m ago  rowan  Edit [Traffic]
    19m ago  luna   Edit [water-sim-timberborn]
    23m ago  rowan  Edit [Traffic]
```

**Git cannot answer this.** 95 commits landed in this repo in one day, every one authored by the same person — `git blame` names the human and never which of ten agents wrote the line. The `edits` table is the only place the two are distinguishable, and the interleaving above is the thing you actually want to see.

**It is a different table from `claims`, deliberately.** Claims are live state and are deleted with their session — right for "who is in this file _now_", useless for "who was in it", which is asked precisely once a session has gone. Measured: an agent ended its session mid-conversation here and its six claims vanished, leaving no record it had ever been in the file. So `edits` is append-only, survives `unregister` and the stale sweep, and freezes the agent's name at write time.

Two limits worth knowing. It is **file-level, not line-level**: `pre-edit` runs _before_ the edit and sees a path, not a diff — getting lines would mean a `git diff` per edit, measured at 40 ms on the hottest hook there is. And it records **intent, not outcome**: the row is written before the edit, so a failed or reverted edit still leaves one.

Reading it off disk instead was measured and rejected: `git status` across this repo's 36 worktrees costs **2321 ms** against **7.5 ms** for the same answer from the store, and it reports all 5239 uncommitted files rather than the 39 an agent deliberately touched.

## The work board

A durable record per unit of work — several open at once, each with a checklist the agent wrote. Agents already write status reports; before this they had nowhere to put them, so they went out as broadcasts (measured 2026-07-31: `say` bodies ran a median of 681 chars, 18 of the last 25 described a breaking change) and scrolled away. An agent joining an hour later could not ask what a peer was doing without reading backwards through the log.

```sh
crew doing "<subject>" --plan "a; b; c"    # open an item, with a checklist
crew did   <n> ["<what changed>"]          # tick step n off
crew step  <n> "<status>"                  # working on n, not finished
crew add   "<step>"                        # a phase the plan missed
crew breaks "<what>" [--item <match>]      # …and message the peers it affects
crew needs  "<what>" [--item <match>]      # a blocker, for whoever reads the board
crew done  ["<match>"] [--abandoned]       # close ONE item
crew board [<agent>] [--history] [--all]   # read the board
crew mine                                  # my open items
crew link  <plan path>                     # point an OPEN item at a plan
crew plans                                 # every plan with work against it
```

### Attaching work to a plan — `--plan-doc` versus `link`

The two do the same thing at different moments, and only one of them is available at any given time:

| You are | Use | Because |
| ------- | --- | ------- |
| opening the item | `crew doing "<subject>" --plan-doc <path>` | the plan is already known |
| already open | `crew link <path>` | the item exists; `doing` would open a second one |

`--plan-doc` is not a synonym for `--plan`. `--plan "a; b; c"` is the **checklist** — steps you wrote. `--plan-doc <path>` is the **document** this work executes. An item can have both, one, or neither.

**Why the link matters at all.** A plan's own file history says nothing about whether its work happened: an agent writes the plan, implements it, and never touches the file again. Measured — one agent had four of six steps done and a sha landed while its plan file had zero commits. The link is what lets a `landed` sha on an item stand as evidence about the plan, which is the whole of what `crew plans` reports.

`hooks/pre-edit.ts` offers the exact `crew link <path>` line when it notices an agent editing a plan document that no open item names.

**Two things fill themselves in.** A commit attaches to your current item — the `PostToolUse` hook reads git's own `[branch sha]` line, so a failed commit records nothing and a `git commit -q` (which prints nothing) is missed rather than guessed at. And an agent that never runs `doing` still gets a placeholder row carrying its conversation title, retired the moment it opens a real item. The board's founding problem was that agents skip optional work; a rough row beats a blank where the operator expects to see who is doing what.

**`breaks` reaches people, `needs` does not.** A break is news somebody else has to act on, so it is messaged to agents whose recent edits touch a file yours do — addressed, never broadcast, and read from the append-only edit history so it still reaches whoever was in that file this morning. `needs` is a note to the reader of the board about what this work is waiting on; nobody is obliged by it, and messaging eight agents about one agent's blocker is how a channel becomes noise.

**If an item stops moving for an hour**, your next prompt asks whether it is finished, abandoned or still live — once per item, and never closed for you, because only you know which of the three it is.

```
$ crew board

  ada                                                              2 open
    ▸ retiring the old net core  1/4              2h · updated 4m
      ✓ 1  delete buildGraph
      ▪ 2  migrate the 12 call sites   ← current
      ▪ 3  re-record baselines
    ▸ junction sliver fix  0/2                    40m · updated 12m
      ▪ 1  a cut shared by 2+ alignments is never absorbed   ← current
```

**Several items open at once**, because agents genuinely multitask — a junction fix lands in the middle of a core retirement, and collapsing those into one line loses both. A bare command means **the most recently touched item**; a subject substring picks another (`crew done sliver`).

### What each agent is doing

Rows are grouped by state, so "who needs me" is answered by position rather than by comparing timestamps:

| Glyph | State | Means |
| ----- | ----- | ----- |
| `⏸` | needs you | a permission prompt is open |
| `●` | running | heartbeat newer than the last turn end |
| `◐` | at a prompt | the turn ended and nothing followed |
| `○` | gone | no live session row |

**Derived, never sampled.** Claude Code's own `idle`/`busy` costs ~950 ms, so it is refreshed only when `who` runs — measured 2026-08-05, a session read `status = busy` while its heartbeat and last turn end were both 127 s old. The heartbeat updates on *every* hook, so comparing it to the turn boundary is both free and fresher.

**There is no "stalled".** A crashed session and an abandoned one both simply stop firing hooks, and nothing records an exit code or a failing test. A fourth state would be invented, and an invented alarm is worse than none.

A running agent whose *item* is old is a real combination, not a contradiction: the state describes the session, the age describes the checklist. An agent can work for days without touching its plan.

### Unfinished work whose agent has gone

An open item whose session is no longer live gets the conversation that owns it:

```
  akira (15ef97)                                                   1 open
    ▸ R4 step 4: keep-clear moves into net/  0/4    3d · updated 3d
      ▪ 1  port buildKeepClear into net/lanes/keepClear.ts   ← current
      resume   claude --resume 1c77a134-1a87-4c1b-8917-c575fdf9473f
```

The session id **is** the resume handle, so the board can hand you the exact command. It appears only when all three hold: the item is open, the session is not live, and Claude Code still has the transcript on disk. A live agent can be messaged instead, and an offer that would fail is worse than no offer.

A name in parentheses means **two conversations have held that name** — names return to the pool when a conversation ends, so this is ordinary, and without the suffix the two blocks read as one agent listed twice.

### The checklist is optional, and that is load-bearing

`--plan` can be omitted. An item with no steps is a legitimate end state, not a half-filled form — the agent judges whether the work has phases worth tracking, and quick checks do not need one. Whether a checklist _exists_ then becomes a real signal: it is what will gate the planned idle check, so an agent doing a five-minute fix can never be nagged about a plan it never wrote.

`add` exists because a plan written at the start is always wrong by the middle, and an agent that cannot record a discovered phase abandons the checklist instead of correcting it.

### It is a timeline, not a status

Every state change appends to `work_events`; nothing is overwritten. Current state is a **fold** over those events, so `board` and `board --history` read the same rows and cannot disagree:

```
$ crew board ada --history

  retiring the old net core started 2h ago
      2h  started   delete buildGraph → migrate callers → re-record
    1h40  did      1 delete buildGraph: the core flag went with it
    1h05  landed   2f2ac31
    1h04  breaks   seed 42 goes 143→213 strokes; re-record before this lands
      38m  did      2 12 call sites migrated, 2 needed a different fix
```

`⚠ breaks` is the line the feature is for. Today that fact exists only inside a 2500-char broadcast that has already scrolled past, and it is asked about days later ("who moved the baselines?").

### Records outlive their session

Work is keyed on the **session id**, and that is not the tautology it looks like. `CLAUDE_CODE_SESSION_ID` is **not a per-process label** — it is the _conversation_ uuid: the transcript's own filename, and the id `claude --resume <uuid>` takes.

Measured 2026-07-31 on this tool's own conversation. The terminal was restarted mid-session; Claude Code's display name moved `traffic-a0` → `traffic-7c`, and the session id stayed `c5ce05bc-…` throughout. **The roster row was never replaced, only relabelled.**

An earlier version keyed on the conversation _title_, on the assumption that a restart issued a fresh session id. It does not, and the title was strictly worse on two counts: it is model-written and gets **rewritten as a conversation develops**, so renaming one silently orphaned every record filed under the old name; and it is empty until the first title lands, splitting early records onto a second key.

So an **open** record survives the roster's 90-minute stale sweep; a **closed** one is kept 7 days (`board --all`) and then pruned with its steps and events.

