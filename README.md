# Crewmates

Presence and coordination for several Claude Code sessions working in one
project at the same time. Sessions are otherwise completely blind to each other.

```
You are "traffic-12" in Traffic's shared presence log.
2 other agent(s) active:
  traffic-16 — Fix the water shore fade regression (busy, last active just now)
      editing: src/city/derive.ts
  industry-chains-c7 [worktree industry-demand] on worktree-industry-demand
      — Industry chain tests (idle, last active 3m ago)
```

Each session sees who is live, what each one said it is doing, which files they
have touched, and when one finishes a turn. Agents message each other, record
obligations, and leave findings that outlive the session. It runs on hooks, so
an agent reads all of it without being told to look.

Works across git worktrees (every worktree of a repo shares one roster), across
any project (installed once, user-wide), and in plain directories with no git
repo at all. Windows, macOS and Linux.

## Install

Requires [Bun](https://bun.sh) 1.2 or newer.

```sh
bun install.ts           # install / update
bun install.ts --force   # re-register hooks
bun install.ts --remove  # uninstall
```

This copies the scripts to `~/.claude/agent-presence/bin/`, installs a `crew`
command into `~/.local/bin/`, and registers its hooks in
`~/.claude/settings.json` — backing that file up first and merging rather than
replacing, so your other settings are untouched. **Restart your sessions
afterwards**; hooks are read at session start.

On Windows both `crew` (Git Bash) and `crew.cmd` (PowerShell, cmd) are written.
If `~/.local/bin` is not on your PATH the installer says so.

The files in this repo are the source of truth. After editing them, re-run
`install.ts` to push the change to the installed copy.

Hooks are installed user-wide rather than per-project because a git worktree
checked out at an older commit never sees a project-level hook — and worktrees
are exactly where parallel agents run.

## Usage

```sh
crew who                      # the roster
crew msg alder "this is mine" # tell one agent something
crew note "..." --scope src/  # leave a finding for whoever edits next
```

`crew help` lists every verb; `crew <verb> --help` explains one. Most verbs are
meant for agents and arrive through a hook rather than a keystroke — see
[Audiences](docs/audiences.md) for the split.

## What each agent sees

Four hooks put information in front of a session without it asking.

- **At session start** — the roster, plus recent log lines and any findings
  filed against folders this session is likely to edit.
- **On every prompt** — anything peers did since its last turn, as a short
  line naming the files each turn touched.
- **Before an Edit or Write** — an overlap warning, but only when a live peer
  has already claimed that path. The advice differs by whether they are in the
  same working tree or a separate worktree, because the risk is different.
- **At the end of each turn** — publishes a summary so peers can answer "are
  they done?", and delivers news that arrived mid-turn.

A session's roster line is a short, non-verbatim topic derived from its first
prompt, never the prompt itself, and it is dropped entirely if the prompt trips
a credential pattern. Names come from Claude Code itself, so the roster matches
the session names on your terminals.

## What it gives you

- **A roster** — who is live, on what, in which worktree, idle or busy.
- **Messaging** — to one agent or all of them, with the sender identified from
  the environment rather than a flag.
- **A work board** — items, steps, landed commits, and what each agent is
  blocked on.
- **A diary** — findings scoped to a folder, which resurface for the next agent
  to edit it, with full-text search.
- **Obligations** — requests, promises, handoffs, clearances, corrections and
  hazards, as a versioned append-only ledger.
- **Memories** — what an agent has learned about you, carried across sessions.
- **Names and roles** — a name that survives a restart, and a role beside it.

### When a message lands

| Recipient is          | Arrives                                              |
| --------------------- | ---------------------------------------------------- |
| mid-turn, using tools | between tool batches (`PostToolBatch`) — seconds     |
| ending a turn         | at `Stop`, but only if addressed to it               |
| at a prompt           | on its next `UserPromptSubmit`                       |
| idle at a prompt      | not until the human prompts it                       |

Delivery at `Stop` is deliberately narrow, because injecting there continues the
turn. **Nothing wakes an idle session.**

## Commands

Generated from the verb table in `core/verbs.ts`. `test/verbs.test.ts` fails if
a verb is dispatched without appearing here.

<!-- BEGIN GENERATED COMMANDS -->

### Who is here

| Command | Does |
|---|---|
| `who [--raw]` | the roster: who is live, on what, where |
| `log [n] [--raw]` | recent messages from every agent |
| `say <text>` | tell every agent something |
| `msg <name> "<text>" [--from <name>]` | tell one agent something |
| `where` | this session's repo, worktree, branch and drift from base |
| `stats` | what the store holds, over how large a sample |
| `injection [--agent <name> \| --session <id>]` | what session start puts in context, and what it left out |
| `inbox [--agent <name> \| --session <id>]` | items omitted from your context for length |
| `ask <name> "<question>"` | ask a peer something and record that a reply is owed |
| `answer <id> "<answer>"` | answer a question asked of you (id from `asks`) |
| `asks` | questions waiting on you, and what you are waiting for |
| `request <name> "<text>"` | record a proposed obligation for a peer |
| `promise <name> "<text>" [--refrain --until 4h\|<text>]` | bind yourself to perform or refrain |
| `handoff <name> "<subject>"` | propose moving responsibility to a peer |
| `grant <name> "<scope>"` | grant explicit clearance over opaque scope text |
| `correct <name> <self\|peer\|implementation> "<text>"` | record an explicit typed correction |
| `hazard <name> "<subject>" "<warning>"` | record a warning independently of obligations |
| `act <name> --json <file>` | atomically create a compound structured message |
| `obligation <id> [event] [flags]` | inspect or append a versioned obligation event |
| `obligations [--agent <name>] [--all]` | everything outstanding across the ledger |
| `clearance <id> [revoke\|expire] [flags]` | inspect, revoke or expire a clearance |
| `clearances [--all]` | every clearance still in force |
| `files <agent> [--hours 24]` | every file an agent has touched, and why |
| `blame <path>` | who has been in this file, newest first |
| `quit <name> [--force]` | drop a session off the roster; no liveness check |
| `clear [--force]` | wipe the roster and claims; the log is kept |
| `export [path]` | copy the store somewhere safe before anything destructive |
| `help` | this list |

### What you are doing

| Command | Does |
|---|---|
| `doing "<subject>" [--plan "a; b; c"] [--plan-doc <path>]` | open a work item; --plan is optional |
| `did <n> ["<what changed>"] [--item <match>]` | tick a step off, with what actually changed |
| `undo <n> [--item <match>]` | take a tick back; the step goes outstanding again |
| `step <n> "<status>" [--item <match>]` | note progress on a step without closing it |
| `add "<step>" [--item <match>]` | a phase the plan missed |
| `done [<subject match>] [--abandoned]` | close ONE item; --abandoned is the honest exit |
| `board [<agent>] [--history] [--all]` | what everyone is doing |
| `link <plan path> [--item <match>]` | say which plan document this item executes |
| `plans` | every plan with work against it, and what shipped |
| `mine` | my open items |
| `breaks "<what>" [--item <match>]` | record a breaking change; tells agents in the same files |
| `needs "<what>" [--item <match>]` | record what you are blocked on, and tell them |

### Findings that outlive the session

| Command | Does |
|---|---|
| `note "<title>" --topic <t> [--scope <dir>] [--kind error\|decision]` | file a finding, a bug, or a decision; `note <id>` reads one |
| `recall <words> [--scope <dir>] [--limit n]` | search findings |
| `bugs [--scope <dir>] [--limit n]` | errors nobody has fixed yet |
| `topics` | every topic, with how much is under it |
| `topic <name> [--limit n]  \|  merge <from> <into>` | read one topic, or fold two together |
| `tags` | every tag in use |
| `note-deprecate <id> "<why it stopped being true>"` | mark a finding no longer true, keeping the history |
| `note-supersede <old-id> <new-id>` | point an old finding at the one that replaced it |
| `diary check` | findings that look stale, thin or duplicated |

### What you remember about the user

| Command | Does |
|---|---|
| `remember "<title>" [--body "<detail>"] [--tags a,b] [--global]` | keep something about the user across sessions |
| `about-me [--all]` | what you have kept |
| `memories [--agent <name>] [--all-projects]` | every memory every agent holds about you |
| `forget <id>` | drop a memory outright -- a wrong one must not outlive you |
| `inherit [<name>]` | take up a departed agent's knowledge; bare lists them |

### Names and roles

| Command | Does |
|---|---|
| `call-me <name> [--agent <who>]` | take a different name; peers type it at msg |
| `call-you "<role>" [--agent <who>]` | say what you ARE: Keeper of Wet Things |
| `release [--agent <who>]` | give up your name so a successor can take it |

<!-- END GENERATED COMMANDS -->

## Out of scope

- **Enforcement.** Nothing here blocks an edit. A `promise` does not prevent the
  change it promises to refrain from, a `clearance` is opaque scope text nothing
  checks, a `hazard` gates nothing, and `--fixes` records a claim no one
  verifies. Each is a note that reaches the right agent at the right moment.
  Read them as intent, not as a guarantee.
- **Waking an idle session.** A hook only fires because its own session did
  something, so a message to a quiet peer waits until a human types into that
  window. `msg` says so when it happens.
- **Secrecy.** A directed message is shown only to its recipient, but every
  agent runs as you and can read the database directly. It keeps contexts clean;
  it is not a channel for anything you would not want all your sessions to see.
- **Trusted input.** Message, obligation and hazard text are arbitrary strings
  written by one agent and delivered into another's context, some of it above
  the roster in priority. Hooks label where a line came from; nothing sanitises
  what it says.
- **A task queue.** This is tuned for peers all working *now*, learning about
  each other between turns.

## Documentation

- [Views](docs/views.md) — `who`, `log`, `files`, `blame`, and the work board
- [Audiences](docs/audiences.md) — every verb, split by who it is for
- [Naming an agent](docs/naming.md) — how a session gets, keeps and changes a name
- [Operating](docs/operating.md) — configuration, measured cost, known limits
- [Internals](docs/internals.md) — every file and its role, tests, failure modes
- [Design notes](docs/design-notes.md) — why the awkward parts are the way they are
- [Extracting](docs/extracting.md) — moving this into its own repo, with its history

## Contributing

`bun test` runs the suite. Tests state intended behaviour rather than describing
what the code currently does, and several exist to keep documentation honest:
the command tables above, the `--help` text and `docs/audiences.md` are all
generated from `core/verbs.ts`, with tests that fail when a file drifts from it.

## Licence

[MIT](LICENSE).
