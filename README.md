# Agent presence

Lets the Claude Code sessions working on one project see each other: who is
active, what each said it is doing, which files they have touched, and when one
finishes a turn. Sessions are otherwise completely blind to each other.

Works across **git worktrees** (every worktree of a repo shares one roster),
across **any project** (installed once, user-wide), and in plain directories
with **no git repo at all**. Windows, macOS and Linux.

This is **notification, not enforcement**. Nothing here can stop an agent from
editing a file another agent is in — it makes the overlap visible so the agent
can apply the commit rules in `CLAUDE.md` (stage explicit paths, never
`git add .`, never stash) deliberately rather than by luck.

## Install

```sh
bun .claude/hooks/presence/install.ts           # install / update
bun .claude/hooks/presence/install.ts --force   # re-register hooks
bun .claude/hooks/presence/install.ts --remove  # uninstall
```

Copies the scripts to `~/.claude/agent-presence/bin/` and registers 16 hooks in
`~/.claude/settings.json` (backing it up first, and merging rather than
replacing — your other settings are untouched). **Restart your sessions**
afterwards; hooks are read at session start.

The files in this repo are the source of truth. After editing them, re-run
`install.ts` to push the change to the installed copy.

### Why user-wide, not per-project

Hooks are read from the working tree. A git worktree checked out at an older
commit **never sees a project-level hook** — and worktrees are exactly where
parallel agents run. Installing once outside every checkout is what lets a
worktree agent join the same roster as the main tree.

## What each agent sees

**At session start** — the roster, and recent log lines:

```
You are "traffic-12" in Traffic's shared presence log.
2 other agent(s) active:
  traffic-16 — Fix the water shore fade regression (busy, last active just now)
      editing: src/city/derive.ts
  industry-chains-c7 [worktree industry-demand] on worktree-industry-demand
      — Industry chain tests (idle, last active 3m ago)
```

Names come from **Claude Code itself** (`claude agents --json`), so the roster
matches the session names on your terminals, and `idle`/`busy` is its own status
rather than a guess from a heartbeat. It costs ~950 ms, so it is sampled at
session start and on `cli.ts who` — never on a per-prompt path.

A peer in a **different worktree** is labelled with it; peers in the same tree
show nothing, keeping the common case quiet.

**On every prompt** — anything peers did since its last turn:

```
1 update(s) from other agents in Traffic:
  [3m ago] traffic-4b done: stopped after editing src/net/types/ids.ts, src/net/types/document.ts
```

A turn-end line names the files that turn touched, taken from the claims the
session recorded since its previous stop. The assistant's own words are never
republished — but which files it edited is the difference between a log worth
reading and a column of "reached a stopping point".

### Messaging

Agents and you can send to **one** agent or to everyone:

```sh
cli.ts msg traffic-16 "waterSim.ts is mine for the next hour"   # to one agent
cli.ts say "branch before committing"                           # to everyone
cli.ts msg traffic-16 "..." --from traffic-12                   # speak AS an agent
```

**The sender identifies itself; you do not pass a flag.** Claude Code sets
`CLAUDE_CODE_SESSION_ID` in every process it spawns, so a message from an agent
is attributed to that agent and one typed in a plain terminal is attributed to
you. `--from` remains for speaking as a session deliberately.

> This matters more than it looks. When `--from` was the only way to identify a
> sender, an agent answering a direct question forgot it, its reply was stored
> as **`human`**, and it reached the recipient reading `human to traffic-c9` —
> a peer's words in the operator's voice. `say` from an agent is likewise
> recorded as that agent's `say`, never as your `note`, because `note` outranks
> peer text wherever it is rendered.

A directed message is **shown only to its recipient** — the drain query filters
on recipient, so an unaddressed peer never receives the row at all. Names match
the real session name, the fallback handle, or a unique prefix.

> **Scoped delivery, not secrecy.** Every agent runs as you and can read the db
> file directly, and `cli.ts log` shows everything. This keeps contexts clean and
> stops four agents acting on one instruction. It is **not** a channel for
> anything you would not want all your sessions to see.

### When a message actually lands

| Recipient is          | Arrives                                              |
| --------------------- | ---------------------------------------------------- |
| mid-turn, using tools | **between tool batches** (`PostToolBatch`) — seconds |
| ending a turn         | at `Stop`, but **only if addressed to it**           |
| at a prompt           | on its next `UserPromptSubmit`                       |
| idle at a prompt      | not until the human prompts it                       |

`PostToolBatch` is what makes this usable: a busy agent — the one actually
editing files — picks up "waterSim.ts is mine" within seconds instead of at the
end of a 20-minute run.

**Stop delivery is deliberately narrow.** Injecting at `Stop` _continues the
turn_ (HOOKS.MD: "The conversation continues so Claude can act on it"), under the
same 8-continuation cap as blocking. So only messages addressed to that session
and human broadcasts are delivered there; routine `done`/`claim` chatter waits.
Otherwise every agent's turn-end announcement would extend every other agent's
turn, and two agents could bounce `done` lines off each other until the cap cut
them off. `stop_hook_active` suppresses delivery entirely.

**Nothing wakes an idle session** — that limit is real and unfixed here.

### Whose words are these

| Kind    | Renders as                              | Author                |
| ------- | --------------------------------------- | --------------------- |
| `say`   | `traffic-12 to traffic-16: ...`         | that agent            |
| `say`   | `traffic-12 to everyone: ...`           | that agent, broadcast |
| `note`  | `the user, to everyone: ...`            | you, via `cli.ts say` |
| `done`  | `traffic-12 done: finished a turn: ...` | the agent             |
| `claim` | `traffic-12 claim: also editing ...`    | the agent             |

Every injection carries a note that the log is **reference, not orders**: a
message addressed to someone else is not yours to act on, and a peer's request
is from another agent, not from your user.

### Prompts are never republished

A session's roster line is a **short, non-verbatim topic** derived from its first
prompt — never the prompt itself. Publishing prompts word-for-word sent whatever
you typed (credentials, client names, a pasted stack trace) to every peer, and
produced lines like `turing was asked by its user: "go"` that carried no
information.

`topicOf` in `prompt-submit.ts` takes the opening clause only, caps it at 60
chars, **drops the topic entirely** if the prompt trips a credential pattern
(rejecting rather than redacting — a redacted secret still reveals one was
pasted), and publishes nothing for a bare continuation like "go" or "yes".
Anything richer is the session's own to share, with an explicit `msg`.

**Before an Edit/Write** — only when a live peer already claimed that path. The
advice differs by where they are, because the risk is different:

```
OVERLAP on src/city/derive.ts:
- ada (claimed 2m ago) — editing it in THIS working tree. Their changes are
  uncommitted here: stage only the files you authored (never `git add .`), and
  do not revert or stash their work.
- hopper (claimed 5m ago) — editing it in a separate worktree. No on-disk
  collision, but these changes have to merge later.
```

**At the end of each turn** — publishes `finished a turn: <summary>` so peers can
answer "are they done?", and delivers any news that arrived mid-turn.

## Your view

Run from anywhere inside a project; it resolves the same roster the hooks use.

```sh
bun ~/.claude/agent-presence/bin/cli.ts who        # roster + claims
bun ~/.claude/agent-presence/bin/cli.ts log 20     # recent messages
bun ~/.claude/agent-presence/bin/cli.ts msg <name> "..." # send to ONE agent
bun ~/.claude/agent-presence/bin/cli.ts say "..."       # broadcast to every agent
bun ~/.claude/agent-presence/bin/cli.ts quit <name> # drop an agent from the roster
bun ~/.claude/agent-presence/bin/cli.ts where      # which project/db this dir maps to
bun ~/.claude/agent-presence/bin/cli.ts clear      # wipe roster (log self-prunes)
bun ~/.claude/agent-presence/bin/cli.ts board      # the work board — see below
```

### Ending an agent

`quit` **deregisters, it does not kill.** Terminating a `claude.exe` destroys
whatever that agent held in context, and nothing here can reliably tell a
session whose terminal was closed from one merely sitting idle — measured
2026-07-31: the window handle is `0` for _every_ session including live ones,
process ancestry is byte-identical between a closed tab and a working session,
and CPU time looked decisive over a 6-second sample then **inverted** over 25
seconds. With no dependable liveness signal, killing on a guess eventually kills
a working agent. Dropping the row is safe and reversible: any hook the session
fires re-registers it.

Before it drops a row, `quit` names what that row was protecting — a path two
agents both hold loses its collision warning when one of them leaves:

```
$ cli.ts quit ada
ada — just now
  process 8520 is still running; this only clears the roster row
  ⚠ holds src/shared.ts, also held by turing
  releasing 1 claim(s)
  ✓ deregistered
```

`who` also counts **background processes** — running Claude sessions in this
repo that no roster row accounts for. These are the ones whose terminal was
closed: the window is gone, the process is not, and nothing else reports them.
Two were found running for 48 hours in worktrees no longer in use.

```
3 background process(es) — no window, not on the roster:
    pid 37476   footprint-merge-ef footprint-merge  started 48h ago
    pid 46020   industry-chains-c7 industry-demand  started 48h ago
```

The pid is the point — it is the only handle you have on a process with no
window. What to do about one is your call; the tool never touches it.

**A closed terminal usually deregisters itself.** `SessionEnd` fires with
`prompt_input_exit` on a double ⌃C and the row goes; `clear` and `resume` are
deliberately spared, since neither means the agent left. Verified against every
documented reason. A row that lingers anyway is a session running hooks from
_before_ that logic shipped — the roster's `⟲` marks those.

`say` reaches everyone at once, so it beats retyping a correction eight times;
`msg` is the targeted version. `where` is the first thing to check if a roster
looks empty.

`who` is colourised for the terminal:

- **each agent gets its own colour**, assigned across the roster so no two ever
  share one, and stable for a given roster
- **activity age** reads green (<5 min), amber (<15 min), then dim
- **red marks a contested file** — a path two live agents both hold — and a
  summary lists them at the bottom. Red is used for nothing else, so it always
  means "look at this"
- **the branch and worktree only appear when they differ** between agents;
  four agents in one tree don't need `[worktree Traffic] on master` four times
- **the quoted headline is the conversation's name** — Claude Code's own
  `ai-title`, the same string its session picker shows, so a roster line and the
  window it refers to are recognisably the same thing
- **`doing:` is what that session is working on now**, written by Haiku from its
  recent output. The title is set from the conversation's opening subject and
  does not move; this line does

```
traffic-ca  "Explore cheap agent communication solutions"   · just now
    doing Wiring transcript titles into the roster
    editing .claude/hooks/presence/core/transcript.ts, …
```

**Both are for you, not for the agents.** A title names a window on your screen,
which is exactly what makes it useful to you and useless to a peer — so neither
field is injected into any agent's context. That text is on every agent's hot
path on every turn, and it stays lean.

Colour is a second channel, never the only one: every distinction is also in the
words. `NO_COLOR`, `FORCE_COLOR` and piping are honoured, so a redirected log is
plain text.

**Hook output is never colourised** — it goes into an agent's context window,
where escape codes cost tokens and buy nothing.

## Who touched what

```sh
cli.ts files terrain-perf          # every file that agent has touched  [--hours 24]
cli.ts blame src/gen/terrain.ts    # who has been in this file, newest first
```

```
$ cli.ts files terrain-perf
terrain-perf — 6 file(s) in 24h  (session ended — this is history)
  ▸ terrain gen perf: dedup shore field, fix erode wrap  1/3
    now  fix the horizontal wrap in erode
     8m ago  src/gen/terrain.ts ×3
    12m ago  test/unit/gen/terrain.test.ts
    15m ago  docs/systems/terrain-water.md

$ cli.ts blame src/gen/terrain.ts
src/gen/terrain.ts
     9m ago  terrain-perf   Edit [Traffic]
    19m ago  water-dynamic  Edit [water-sim-timberborn]
    23m ago  terrain-perf   Edit [Traffic]
```

**Git cannot answer this.** 95 commits landed in this repo in one day, every one
authored by the same person — `git blame` names the human and never which of ten
agents wrote the line. The `edits` table is the only place the two are
distinguishable, and the interleaving above is the thing you actually want to
see.

**It is a different table from `claims`, deliberately.** Claims are live state
and are deleted with their session — right for "who is in this file _now_",
useless for "who was in it", which is asked precisely once a session has gone.
Measured: an agent ended its session mid-conversation here and its six claims
vanished, leaving no record it had ever been in the file. So `edits` is
append-only, survives `unregister` and the stale sweep, and freezes the agent's
name at write time.

Two limits worth knowing. It is **file-level, not line-level**: `pre-edit` runs
_before_ the edit and sees a path, not a diff — getting lines would mean a
`git diff` per edit, measured at 40 ms on the hottest hook there is. And it
records **intent, not outcome**: the row is written before the edit, so a failed
or reverted edit still leaves one.

Reading it off disk instead was measured and rejected: `git status` across this
repo's 36 worktrees costs **2321 ms** against **7.5 ms** for the same answer from
the store, and it reports all 5239 uncommitted files rather than the 39 an agent
deliberately touched.

## Configuration

Optional, at `~/.claude/agent-presence/config.json`. Every value has a default
that applies when the file is missing, unreadable, or malformed — it is read on
hook paths, so a typo must degrade rather than take a session's edit with it,
and defaults apply **per field** so one bad line cannot revert the rest.

| Key                 | Default | What it bounds                                        |
| ------------------- | ------- | ----------------------------------------------------- |
| `staleMs`           | 90 min  | a session with no heartbeat is treated as gone        |
| `claimTtlMs`        | 2 h     | how long a claim means "I am working on this"         |
| `claimReannounceMs` | 30 min  | how long an overlap announcement stays "already said" |
| `nameReuseMs`       | 60 h    | how long a given name is held after last use          |
| `workKeepMs`        | 7 days  | how long a **closed** work record is kept             |
| `editKeepMs`        | 30 days | how long edit history is kept                         |

`editKeepMs` is the longest because it is the only one answering a question about
the past. There is no "off": an append-only table on a repo with 36 worktrees is
how this gets slow, and the honest knob is _how long_, not _whether_.

## The work board

A durable record per unit of work — several open at once, each with a checklist
the agent wrote. Agents already write status reports; before this they had
nowhere to put them, so they went out as broadcasts (measured 2026-07-31: `say`
bodies ran a median of 681 chars, 18 of the last 25 described a breaking change)
and scrolled away. An agent joining an hour later could not ask what a peer was
doing without reading backwards through the log.

```sh
cli.ts doing "<subject>" --plan "a; b; c"    # open an item, with a checklist
cli.ts did   <n> ["<what changed>"]          # tick step n off
cli.ts step  <n> "<status>"                  # working on n, not finished
cli.ts add   "<step>"                        # a phase the plan missed
cli.ts breaks "<what>" [--item <match>]      # …and message the peers it affects
cli.ts needs  "<what>" [--item <match>]      # a blocker, for whoever reads the board
cli.ts done  ["<match>"] [--abandoned]       # close ONE item
cli.ts board [<agent>] [--history] [--all]   # read the board
cli.ts mine                                  # my open items
```

**Two things fill themselves in.** A commit attaches to your current item — the
`PostToolUse` hook reads git's own `[branch sha]` line, so a failed commit
records nothing and a `git commit -q` (which prints nothing) is missed rather
than guessed at. And an agent that never runs `doing` still gets a placeholder
row carrying its conversation title, retired the moment it opens a real item.
The board's founding problem was that agents skip optional work; a rough row
beats a blank where the operator expects to see who is doing what.

**`breaks` reaches people, `needs` does not.** A break is news somebody else has
to act on, so it is messaged to agents whose recent edits touch a file yours do
— addressed, never broadcast, and read from the append-only edit history so it
still reaches whoever was in that file this morning. `needs` is a note to the
reader of the board about what this work is waiting on; nobody is obliged by it,
and messaging eight agents about one agent's blocker is how a channel becomes
noise.

**If an item stops moving for an hour**, your next prompt asks whether it is
finished, abandoned or still live — once per item, and never closed for you,
because only you know which of the three it is.

```
$ cli.ts board

  ada                                                              2 open
    ▸ retiring the old net core  1/4              2h · updated 4m
      ✓ 1  delete buildGraph
      ▪ 2  migrate the 12 call sites   ← current
      ▪ 3  re-record baselines
    ▸ junction sliver fix  0/2                    40m · updated 12m
      ▪ 1  a cut shared by 2+ alignments is never absorbed   ← current
```

**Several items open at once**, because agents genuinely multitask — a junction
fix lands in the middle of a core retirement, and collapsing those into one line
loses both. A bare command means **the most recently touched item**; a subject
substring picks another (`cli.ts done sliver`).

### The checklist is optional, and that is load-bearing

`--plan` can be omitted. An item with no steps is a legitimate end state, not a
half-filled form — the agent judges whether the work has phases worth tracking,
and quick checks do not need one. Whether a checklist _exists_ then becomes a
real signal: it is what will gate the planned idle check, so an agent doing a
five-minute fix can never be nagged about a plan it never wrote.

`add` exists because a plan written at the start is always wrong by the middle,
and an agent that cannot record a discovered phase abandons the checklist
instead of correcting it.

### It is a timeline, not a status

Every state change appends to `work_events`; nothing is overwritten. Current
state is a **fold** over those events, so `board` and `board --history` read the
same rows and cannot disagree:

```
$ cli.ts board ada --history

  retiring the old net core started 2h ago
      2h  started   delete buildGraph → migrate callers → re-record
    1h40  did      1 delete buildGraph: the core flag went with it
    1h05  landed   2f2ac31
    1h04  breaks   seed 42 goes 143→213 strokes; re-record before this lands
      38m  did      2 12 call sites migrated, 2 needed a different fix
```

`⚠ breaks` is the line the feature is for. Today that fact exists only inside a
2500-char broadcast that has already scrolled past, and it is asked about days
later ("who moved the baselines?").

### Records outlive their session

Work is keyed on the **session id**, and that is not the tautology it looks like.
`CLAUDE_CODE_SESSION_ID` is **not a per-process label** — it is the
_conversation_ uuid: the transcript's own filename, and the id
`claude --resume <uuid>` takes.

Measured 2026-07-31 on this tool's own conversation. The terminal was restarted
mid-session; Claude Code's display name moved `traffic-a0` → `traffic-7c`, and
the session id stayed `c5ce05bc-…` throughout. **The roster row was never
replaced, only relabelled.**

An earlier version keyed on the conversation _title_, on the assumption that a
restart issued a fresh session id. It does not, and the title was strictly worse
on two counts: it is model-written and gets **rewritten as a conversation
develops**, so renaming one silently orphaned every record filed under the old
name; and it is empty until the first title lands, splitting early records onto
a second key.

So an **open** record survives the roster's 90-minute stale sweep; a **closed**
one is kept 7 days (`board --all`) and then pruned with its steps and events.

## Naming an agent

Every agent gets a **given name** at registration — `luna`, `vega`, `rowan` —
drawn from a pool of 280 and held for 60 hours after it was last seen. That is
what peers type (`msg luna`), and it is stated to the agent at session start,
because a name nobody is told is just a database column.

Beside it sits a **role**: what the agent is _for_.

```
Luna — Tooling Master       Vega — Keeper of Wet Things       Rowan — Terrain Whisperer
```

```sh
cli.ts call-you "Tooling Master"   # what I am — changes as the work does
cli.ts call-me  tooling            # a different name, if the assigned one won't do
cli.ts call-you "…" --agent luna   # the operator setting either, for any agent
```

**Two fields, because they want opposite things.** A name is _typed_: short,
unique, no spaces to quote. A role is _read_: evocative, several words, free to
change. Collapsing them forces `msg "Luna — Tooling Master"`, which is miserable to
type and breaks the quoting rules names are validated against.

Keeping the name fixed while the role moves is the point — `Luna — Tooling Master`
becoming `Luna — Tooling Intern` reads as a demotion rather than as a stranger
appearing on the roster. Roles need not be unique: two agents can share a job
title the way two people can, and only the name has to identify.

**Why the given name outranks Claude Code's `traffic-XX`.** That label _moves_ —
this tool's own conversation was relabelled `traffic-a0` → `traffic-7c` →
`traffic-56` in one afternoon, which made every frozen log line and every peer
reference a moving target. A given name is assigned once. `traffic-XX` is still
the last fallback, for a session with no given name at all.

The chosen name and role are shown everywhere a name is — roster, board, overlap
warnings, and the sender frozen into every message. The three-word form is
**read-only**: `msg` takes the bare name.

**It survives a restart.** The name is remembered against the conversation uuid,
both when it is chosen and again when `SessionEnd` fires, so it comes back
whether the terminal was closed politely or killed. A name that only survived a
_clean_ exit would be the wrong way round.

Three rules, each protecting something specific:

- **Two live agents cannot share a name** — `msg <name>` would have two
  recipients. A name freed by a session that has gone is reusable, exactly as
  handles are recycled.
- **`human`, `everyone`, `system` and friends are reserved.** The operator's
  handle outranks peer text wherever it is rendered, so an agent answering to it
  could post in your voice.
- **Letters, digits, spaces, `-` and `_` only.** Quotes and backticks would break
  the `msg` line a peer copies to reply; control characters could rewrite a
  roster row. Whitespace is collapsed rather than refused, so a name pasted with
  a trailing newline is cleaned instead of rejected.

## Commands

`cli.ts help` prints this list. It is generated from the verb table in
`core/verbs.ts`, and `test/verbs.test.ts` fails if a verb is dispatched without
appearing there — the usage string had drifted to 13 of 33 verbs before that
test existed, which for a tool agents discover at runtime means the other 20
were invisible.

### Who is here

| Command                                                | Does                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `who [--raw]`                                          | the roster: who is live, on what, where                                        |
| `log [n] [--raw]`                                      | recent messages from every agent                                               |
| `say <text>`                                           | tell every agent something                                                     |
| `msg <name> "<text>" [--from <name>]`                  | tell one agent something                                                       |
| `where`                                                | this session's repo, worktree, branch and drift from base                      |
| `stats`                                                | what the store holds, how large a sample that is, and which features have rows |
| `injection [--agent <name>]`                           | what session start puts in this session's context, and what it left out        |
| `inbox [--agent <name>]`                               | the full text of anything omitted from that context for length                 |
| `ask <name> "<question>"`                              | ask a peer something and record that a reply is owed                           |
| `answer <id> "<answer>"`                               | answer a question asked of you                                                 |
| `asks`                                                 | questions waiting on you, and what you are waiting for                         |
| `request <name> "<text>"`                              | record a proposed obligation for a peer                                        |
| `promise <name> "<text>" [--refrain --until <text>]`   | bind yourself to perform or refrain                                            |
| `handoff <name> "<subject>"`                           | propose moving responsibility to a peer                                        |
| `grant <name> "<scope>"`                               | grant clearance while preserving opaque scope text                             |
| `correct <name> <self\|peer\|implementation> "<text>"` | record an explicit typed correction                                            |
| `hazard <name> "<subject>" "<warning>"`                | record a warning independently of obligations                                  |
| `act <name> --json <file>`                             | atomically create a compound structured message                                |
| `obligation <id> [event] [flags]`                      | inspect or append a versioned obligation event                                 |
| `clearance <id> [revoke\|expire] [flags]`              | inspect, revoke or expire a clearance                                          |
| `files <agent> [--hours 24]`                           | every file an agent has touched, and why                                       |
| `blame <path>`                                         | who has been in this file, newest first                                        |
| `quit <name>`                                          | drop a dead session off the roster                                             |
| `clear`                                                | wipe the roster and message log                                                |
| `help`                                                 | this list                                                                      |

### What you are doing

| Command                                                    | Does                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `doing "<subject>" [--plan "a; b; c"] [--plan-doc <path>]` | open a work item; --plan is optional                     |
| `did <n> ["<what changed>"] [--item <match>]`              | tick a step off, with what actually changed              |
| `step <n> "<status>" [--item <match>]`                     | note progress on a step without closing it               |
| `add "<step>" [--item <match>]`                            | a phase the plan missed                                  |
| `done [<subject match>] [--abandoned]`                     | close ONE item; --abandoned is the honest exit           |
| `board [<agent>] [--history] [--all]`                      | what everyone is doing                                   |
| `link <plan path> [--item <match>]`                        | say which plan document this item executes               |
| `plans`                                                    | every plan with work against it, and what shipped        |
| `mine`                                                     | my open items                                            |
| `breaks "<what>" [--item <match>]`                         | record a breaking change; tells agents in the same files |
| `needs "<what>" [--item <match>]`                          | record what you are blocked on, and tell them            |

### Findings that outlive the session

| Command                                                                    | Does                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------- |
| `note "<title>" --topic <t> [--scope <dir>] [--kind error] [--fixes <id>]` | file a finding, or a bug; `note <id>` reads one    |
| `recall <words> [--scope <dir>] [--limit n]`                               | search findings                                    |
| `bugs [--scope <dir>] [--limit n]`                                         | errors nobody has fixed yet                        |
| `topics`                                                                   | every topic, with how much is under it             |
| `topic <name> [--limit n]  \|  merge <from> <into>`                        | read one topic, or fold two together               |
| `tags`                                                                     | every tag in use                                   |
| `note-deprecate <id> "<why it stopped being true>"`                        | mark a finding no longer true, keeping the history |
| `note-supersede <old-id> <new-id>`                                         | point an old finding at the one that replaced it   |
| `diary check`                                                              | findings that look stale, thin or duplicated       |

### What you remember about the user

| Command                                                          | Does                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| `remember "<title>" [--body "<detail>"] [--tags a,b] [--global]` | keep something about the user across sessions              |
| `about-me [--all]`                                               | what you have kept                                         |
| `forget <id>`                                                    | drop a memory outright -- a wrong one must not outlive you |
| `inherit [<name>]`                                               | take up a departed agent's knowledge; bare lists them      |

### Names and roles

| Command                             | Does                                        |
| ----------------------------------- | ------------------------------------------- |
| `call-me <name> [--agent <who>]`    | take a different name; peers type it at msg |
| `call-you "<role>" [--agent <who>]` | say what you ARE: Keeper of Wet Things      |

## Files

Four folders by role: `hooks/` is the event surface, `core/` is shared domain
code and persistence, `cli/` owns the command application, and `test/` never
ships. Only `cli.ts` and `install.ts` sit at the top because they are the two
things you run by hand; `cli.ts` is deliberately only an executable boundary.

**`bin/` mirrors this layout**, so the relative imports that ship resolve exactly
as they do here — `install.ts` walks the tree rather than flattening it, and
replaces `bin/` wholesale so a module that moves cannot leave a stale twin.

### `hooks/` — one file per event, each fails open

| File                | Event                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| `session-start.ts`  | **SessionStart** — register; inject the roster.                           |
| `prompt-submit.ts`  | **UserPromptSubmit** — heartbeat; deliver unread; record the stated task. |
| `pre-edit.ts`       | **PreToolUse**(Edit) — claim the path; warn on peer overlap.              |
| `pre-bash.ts`       | **PreToolUse**(Bash) — deny a loop polling a background task's output.    |
| `tool-batch.ts`     | **PostToolBatch** — mid-turn delivery.                                    |
| `turn-end.ts`       | **Stop** — publish the turn's files; deliver directed mail.               |
| `turn-failed.ts`    | **StopFailure** — a dead turn stops reading as "still working".           |
| `notify.ts`         | **Notification** — records "waiting for permission".                      |
| `subagent-start.ts` | **SubagentStart** — tells a subagent what peers hold.                     |
| `subagent-stop.ts`  | **SubagentStop** — closes the minion out, so the count is live.           |
| `commit-landed.ts`  | **PostToolUse(Bash)** — reads git's own output; records the sha.          |
| `compacted.ts`      | **PostCompact** — refreshes intent from the compaction summary.           |
| `cwd-changed.ts`    | **CwdChanged** — keeps worktree/branch true after a `cd`.                 |
| `task-changed.ts`   | **TaskCreated/Completed** — mirrors per-session tasks to a shared board.  |
| `session-end.ts`    | **SessionEnd** — deregister on clean exit.                                |

### `core/` — shared by every hook and the CLI

| File                  | Role                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `store.ts`            | SQLite schema + all state access. The only file that knows SQL.                                                                           |
| `repo.ts`             | Project identity, worktree, db path (cached — a `git rev-parse` costs 31 ms).                                                             |
| `shared.ts`           | Payload reading, report formatting, `emit`.                                                                                               |
| `topic.ts`            | Lossy, credential-rejecting text → one-line roster label.                                                                                 |
| `colour.ts`           | ANSI for the CLI only. Never reaches an agent's context.                                                                                  |
| `agents.ts`           | Reads `claude agents --json` for real names + idle/busy.                                                                                  |
| `transcript.ts`       | Bounded tail read of a session's own JSONL — conversation title, recent prose.                                                            |
| `summary.ts`          | Prompts Haiku for a "what is it doing now" line; spawns, never waits.                                                                     |
| `summarize-worker.ts` | The detached process that call runs in, so no hook ever blocks on it.                                                                     |
| `layout.ts`           | Roster layout arithmetic — widths, file summarising, background processes.                                                                |
| `work.ts`             | The work board's tables, agent key, and the event fold. Its own lifetime rule.                                                            |
| `board.ts`            | Rendering the board — takes a paint callback, so it is testable without a terminal.                                                       |
| `diary.ts`            | Findings that outlive a session: topics, tags, scopes, FTS5 search.                                                                       |
| `questions.ts`        | Questions between agents — state, delivery, and expiry against a dead target.                                                             |
| `obligations.ts`      | Explicit acts, append-only folds, authorization, dependencies, and P0 candidates.                                                         |
| `features.ts`         | Canonical feature ids, labels, candidate mappings, act mappings, and CLI surfaces.                                                        |
| `hook.ts`             | Shared hook input and output helpers.                                                                                                     |
| `personal.ts`         | Per-agent memories, in one db outside any project. `forget` deletes.                                                                      |
| `verbs.ts`            | Every CLI verb in one table; `usage()` and per-verb argument errors render from it.                                                       |
| `names.ts`            | The given-name pool, and the two casers (prose role vs typeable name).                                                                    |
| `dirty.ts`            | Uncommitted files, for the roster's "what is in flight" line.                                                                             |
| `config.ts`           | Tunables — staleness windows, how much of the board to show.                                                                              |
| `stats.ts`            | Aggregates rows plus separate feature availability/exposure/use observations, session opportunities, and surfaces.                        |
| `injection.ts`        | What reaches a session's context: identity as an un-evictable envelope, everything else ranked against a budget.                          |
| `sessionBlock.ts`     | The session-start candidates themselves — roster, recent activity, diary, memories — built once for both the hook and `cli.ts injection`. |

`feature_events` is the raw P3 evidence ledger. Availability means a session
loaded a build containing a feature, exposure means a named surface actually
showed it, and use means an operation occurred. These are never inferred from
one another. Every aggregate includes observation, distinct-session, and
session-opportunity counts; repeated session starts therefore increase the raw
observation count without inflating the adoption denominator. Availability is
read from the installed manifest generated by `features.ts`; use opportunities
come from exposed sessions, including those that did not use the feature.
Injection observations retain the originating delivery id, while measurement
history has its own lifetime independent of live suppression state.

### `cli/` — one command family per module

| File                   | Role                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `main.ts`              | Builds the command registry, dispatches one command, and records CLI-use telemetry. |
| `types.ts`             | Explicit command context and handler contracts.                                     |
| `registry.ts`          | Duplicate-safe composition of independently owned command families.                 |
| `args.ts`              | Typed parsing for flags, selectors, enums, IDs, and limits.                         |
| `command.ts`           | Centralized usage and command-failure presentation.                                 |
| `result.ts`            | Explicit success/failure values and safe caught-error normalization.                |
| `terminal.ts`          | Sanitized terminal text, visible-width policy, and structured reports.              |
| `paths.ts`             | Trusted-root path resolution and canonical tracked-path conversion.                 |
| `roster.ts`            | Short orchestration pipeline for the live roster command.                           |
| `roster-model.ts`      | Store synchronization, snapshot indexing, contention analysis, and layout.          |
| `roster-renderers.ts`  | Independent session, minion, claim, background-process, and warning renderers.      |
| `messaging.ts`         | Log, directed messages, and broadcasts.                                             |
| `work.ts`              | Work-item mutations, board/history rendering, and break/need signaling.             |
| `diary.ts`             | Findings, bugs, search, topics, tags, and retirement.                               |
| `personal.ts`          | Operator memories and lineage inheritance.                                          |
| `questions.ts`         | Answering and inspecting questions.                                                 |
| `obligations.ts`       | Structured acts and obligation/clearance lifecycle commands.                        |
| `obligation-events.ts` | Pure version validation and obligation/clearance event construction.                |
| `structured.ts`        | Pure parser for single-act structured-message shortcuts.                            |
| `structured-json.ts`   | Complete unknown-to-domain decoder for structured JSON batches.                     |
| `admin.ts`             | Naming, roles, project location, roster clearing, and deregistration.               |
| `diagnostics.ts`       | Edit history and store statistics.                                                  |
| `diagnostics-renderers.ts` | Pure sanitized section renderers for diagnostic reports.                      |
| `injection.ts`         | Session-start envelope and omission inspection.                                     |

### Top level

| File                      | Role                                                      |
| ------------------------- | --------------------------------------------------------- |
| `cli.ts`                  | Eleven-line executable boundary that calls `cli/main.ts`. |
| `install.ts`              | Copy to `~/.claude/agent-presence/bin/`, register hooks.  |
| `test/store.test.ts`      | Delivery + identity, against a real throwaway db.         |
| `test/topic.test.ts`      | What may become a roster label, and what may not.         |
| `test/roster.test.ts`     | Roster layout, asserted with colour codes stripped.       |
| `test/layout.test.ts`     | Width arithmetic and path classification.                 |
| `test/transcript.test.ts` | Tail reads of real transcript shapes.                     |
| `test/work.test.ts`       | The timeline property, and several items open at once.    |
| `test/board.test.ts`      | Board rendering — widths measured on UNPAINTED text.      |

## Tests

```sh
bun test ./.claude/hooks/presence/test/*.test.ts   # the leading ./ is required
bunx tsc --noEmit -p .claude/hooks/presence/tsconfig.json   # the other gate
PRESENCE_TEST_DB=/tmp/x.db bun pre-edit.ts < payload.json   # run a hook safely
```

**Typecheck as well as test.** The repo root's tsconfig covers `src/` and does
not include `.claude/`, so this tool had no type gate at all until it got its
own — which is how a missing import once shipped, failed open, and left a hook
exiting 0 having done nothing. The scoped config caught a real error the first
time it ran.

**`PRESENCE_TEST_DB` redirects every hook to a throwaway db, and anything that
runs a hook must set it.** Testing a hook means _running_ it, and running it
writes to whatever db it resolves — so a test payload lands in the live roster
as a real session with real claims and real log lines. That happened on
2026-07-31: probe sessions left 26 junk messages and a false contested-file
warning naming a session on a file it never edited, which the user had to read
past and which made a fake collision look real.

**The path must be explicit.** `bun test` skips dot-directories, so these files
are invisible to the repo-wide sweep and a bare `bun test .claude/...` matches
nothing — it reports "0 files searched" rather than failing, which reads exactly
like a pass. Run them by hand after touching anything in `core/`.

Every rejection case in it is a string that actually reached the roster and
described nothing. The acceptance cases are there because the first version of
each filter was too greedy and blanked the field it was meant to protect: an
intent that says nothing and an intent that says the wrong thing are both
failures, and a filter is only finished when it is tested from both sides.

## Fail open, but not silently

Every hook ends in `catch { … }` so a locked db or a bad payload can never break
a session. That guarantee has a trap: **a programmer error looks identical to
"nothing to report"** — the hook exits 0, prints nothing, and does not do its
job. A missing import shipped exactly this way on 2026-07-31, and the symptom
was a correction that simply never happened.

So the catch reports to stderr before returning. The exit code is still 0 and
nothing is blocked, but the failure is findable. Two consequences worth knowing:

- **Typecheck before `install.ts --force`, every time.** `tsc` catches this
  class as `TS2304: Cannot find name 'X'`; the install step does not typecheck,
  and it is what makes the bug live.
- **A hook exiting 0 is not evidence it worked.** Neither is replaying its logic
  in-process — that exercises different imports and can pass while the hook
  fails. Run the deployed script against a real payload and read stderr.

Only the twelve hook entry points report. `agents.ts`, `store.ts` and
`install.ts` catch _expected_ failures on constantly-running paths (a missing
settings file, a locked db) where reporting would be noise, not signal.

## Design notes

**One db per project, keyed on the git common dir.** Every worktree of a repo
reports the same `--git-common-dir`, and two repos never collide — so that path
is the identity key, hashed into `~/.claude/agent-presence/<name>-<hash>.db`.
Keying on cwd instead would split one repo into a roster per worktree, the exact
thing this exists to join up.

**No git repo is still a project.** A plain directory keys on its own path.
Without that fallback the hooks would silently do nothing for anyone who has not
run `git init`, which looks like a broken install rather than an unsupported
setup. The two key kinds cannot collide: a git key always ends in `/.git`.

**Case folding follows the platform.** Windows and macOS resolve paths
case-insensitively, Linux does not. Folding unconditionally would merge two
genuinely distinct Linux repos (`~/work/App` and `~/work/app`) into one roster;
not folding at all would split `I:/Projects` from `i:/projects` on Windows.

**SQLite, not markdown.** Several agents doing read-modify-write on one `.md` is
a lost-update race: two read the same text, the second write erases the first's
line — exactly the failure this prevents. WAL mode lets every reader proceed
while one writer commits, so a hook never waits on a peer. Verified with 40
concurrent writes from 4 worktrees: no `SQLITE_BUSY`, no lost rows.

**One integer is the delivery model.** `messages.id` is monotonic and each
session stores the last id it was shown; "unread" is `id > last_read_id`. Read
and cursor-advance happen in one transaction, so two hooks racing on the same
session cannot both deliver the same message. A new session's cursor starts at
the current max, so it gets a deliberate `recent()` summary rather than a replay
of everything.

**Handles are unique by construction.** Picking one is a read then a write, so it
runs in a `BEGIN IMMEDIATE` transaction with a `UNIQUE` index behind it. WAL
gives durability, not mutual exclusion: four sessions starting together can each
read the roster before any inserts, and all four then pick the same "first free"
name. That is not theoretical — four simultaneous starts in one tree produced
**two agents called `hopper`** before the fix. Verified after: 10 rounds × 8
simultaneous registrations, zero duplicates.

**Handles are reused.** A name is freed when its session is pruned, so a 4-agent
setup stays on `ada/turing/hopper/lovelace` instead of drifting down the list on
every restart.

**Every hook fails open.** A locked db or malformed payload ends the hook
silently. Coordination is a convenience and must never break a session — the
same stance `typecheck.ts` takes.

**Nothing blocks.** `pre-edit` warns rather than denying: a path match cannot
answer "is this someone else's work?", and a wedged agent is worse than a visible
conflict. `turn-end` never uses `Stop`'s blocking form, which would trap a
session in a loop nobody asked for.

## Cost

Hooks are synchronous — every one blocks its agent. Measured 2026-07-31:

| Path                                            | Cost       | Frequency                              |
| ----------------------------------------------- | ---------- | -------------------------------------- |
| bare Bun startup                                | **52 ms**  | the floor for every hook               |
| `PostToolBatch`, nothing to deliver             | **76 ms**  | after each tool batch                  |
| `SessionStart` (samples `claude agents --json`) | ~1 s       | once per session                       |
| reading the transcript title                    | **0.4 ms** | per prompt                             |
| everything else                                 | ~72 ms     | rare (per turn, per `cd`, per failure) |

`PostToolBatch` is the only one on a hot path: ~0.3 s per turn over 5 batches,
~2.2 s over 30. Acceptable beside this repo's 7 s-per-edit typecheck hook, but
not free — if it bites, the fix is fewer firings, not a faster script.

Two things were tried and rejected on measurement: `bun build --compile` (85 ms,
**slower** than the script, for a 98 MB binary per hook), and calling
`claude agents --json` anywhere per-prompt (950 ms). Caching the git-derived
project paths took `PostToolBatch` from 93 ms to 76 ms.

Reading the conversation title is 0.4 ms because it never parses the transcript:
it scans a fixed 256 KB tail with a regex, so the cost is flat in file size —
measured across 25 real transcripts, the largest 25 MB.

**The summariser's own `claude -p` is a real session**, so it fires SessionStart
and UserPromptSubmit like any other and registered itself as a peer — five
refreshes put five agents on the roster whose stated task was the summariser's
prompt, _"You label background jobs."_ They held handles and could have raised
overlap warnings against genuine work. Every hook now exits silently when
`PRESENCE_INTERNAL=1`, checked in `readPayload` so the guard sits at one seam
rather than in twelve entry points.

Those five persisted only because a timeout killed the call: `proc.kill()`
terminates the child before its own `SessionEnd` can run, stranding the row
permanently. Nothing this tool spawns should ever be killed while it holds a
roster row.

**The `doing:` summary is the one thing here that spends tokens**, at ~8 s of
Haiku per call, so it never runs on a hook path. `who` spawns a detached worker
and prints immediately; the result lands for the next `who`. It is throttled to
one refresh per session per 15 minutes, so a roster you check repeatedly costs
nothing extra, and an idle session is summarised at most four times an hour.
Delete `core/summary.ts`'s call site and the rest of the tool is unaffected —
the title half is free and independent.

## Known limits

- **Nothing wakes an idle session.** A session sitting at a prompt runs no hooks.
  `PostToolBatch` closes the gap for a _busy_ agent — the one actually editing —
  but an idle peer reads its mail whenever you next prompt it.
- **Claims are per-path, not per-region.** Two agents in different functions of
  one large file still read as an overlap.
- **Only files inside the tree are claimed.** A scratchpad note or a file under
  `~/.claude` cannot collide with a peer, and claiming them buried the real
  in-repo claims under 100-character temp paths.
- **A stated task is the most recent prompt that names a topic.** It used to be
  the FIRST such prompt, so the column described what a session was asked once
  rather than what it is doing. Across four live sessions that rule produced one
  agent frozen on its opening question while working on something else, one
  frozen on an _answer it had given_, and two blank — nothing current. A stale
  label is worse than a moving one, because a peer reads the roster to decide
  whether to interrupt.

  Prompts that are pure filler — "Lovely, start working on it." — set nothing,
  because a _resumed_ session's opening prompt is usually an acknowledgement of
  a conversation the roster never saw. With three live sessions on 2026-07-31 all
  three stated tasks were exactly that shape, so the roster's headline column
  described nothing.

  Pasted terminal output is rejected for the same reason: leaving the slot open
  meant the next prompt could fill it, and a pasted `cli.ts log` promptly became
  a session's "stated task". A session with no stated task shows **nothing** in
  that column — the `editing` line beneath already names its files, and a summary
  there would be a strict subset of the detail directly below it.

- **A session's worktree is corrected from the cwd of each edit**, not trusted
  from session start. `SessionStart`'s cwd is where the session was _launched_
  and `CwdChanged` only fires on an actual `cd`, so an agent working in a
  worktree it did not cd into was recorded in the main tree indefinitely.
  Observed 2026-07-31: a session editing files that exist **only** in
  `.claude/worktrees/…` was listed on master, which inverts `pre-edit.ts`'s
  same-tree/cross-worktree classification and made it report a cross-worktree
  overlap as an on-disk collision. Wrong advice is worse than none.
- **A session runs the hooks it loaded at start.** `install.ts` stamps a build
  hash into `bin/VERSION`, recorded per session, and the roster marks any
  session on an older build `⟲ old hooks` — it needs a restart, not debugging.
- **Sessions that die uncleanly linger** until they miss the 90-minute staleness
  window (`STALE_MS` in `store.ts`); `cli.ts who` prunes them as a side effect.
  A session reaped while still alive is no longer lost — any hook firing
  re-registers it, because a firing hook proves the session is running.
- **`bun` must be on PATH.** The registered command is `bun`, not an absolute
  path, so one settings file works on all three platforms.
- **Scripts are copied, not linked.** The hooks RUN from
  `~/.claude/agent-presence/bin/`; editing the copy in this repo changes nothing
  until `bun install.ts --force` copies it over. Testing a fix against
  `~/.claude/agent-presence/bin/cli.ts` before reinstalling exercises the OLD
  code, and it passes or fails for the wrong reason.

## Planned

Plans live in **[plans/](plans/)** — see [plans/README.md](plans/README.md) for
the index and the reading order.

| Plan                                               | Covers                                                | Status                       |
| -------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| [DIARY_PLAN.md](plans/DIARY_PLAN.md)               | shared findings, topics, tags, scopes, FTS            | shipped                      |
| [WORK_RECORDS_PLAN.md](plans/WORK_RECORDS_PLAN.md) | the work board, landed commits, breaks/needs          | shipped                      |
| [COORDINATION_PLAN.md](plans/COORDINATION_PLAN.md) | generated `--help`, questions, bug state + `--fixes`  | P0 done, P1–P2 pending       |
| [LINEAGE_PLAN.md](plans/LINEAGE_PLAN.md)           | memory that outlives a uuid, disciple naming, handoff | pending                      |
| [AFFINITY_PLAN.md](plans/AFFINITY_PLAN.md)         | which agents work well together                       | deferred — measured, no data |

A plan's checkboxes are re-measured **against the code**, never against what the
plan last said about itself. `WORK_RECORDS_PLAN.md` once carried four
`[x] IMPLEMENTED` markers for phases nobody had written.
