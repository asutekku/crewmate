# Crewmates

Lets the Claude Code sessions working on one project see each other: who is
active, what each said it is doing, which files they have touched, and when one
finishes a turn. Sessions are otherwise completely blind to each other.

## What this is for

**Several sessions open on one project at the same time.** You have four
terminals on the same repo, they edit the same files, and none of them knows the
others exist. That is the problem this solves, and the shape it is tuned for —
peers who are all working *now*, learning about each other between turns.

It is not a task queue and not a way to reach an agent who has stopped. A hook
only fires because *its own* session did something, so nothing here can wake an
idle session; a message to a peer who has gone quiet waits until a human types
into that window. `msg` says so when it happens rather than implying an audience
that is not there.

This is **notification, not enforcement**. Nothing here can stop an agent from
editing a file another agent is in — it makes the overlap visible so the agent
can apply the commit rules in `CLAUDE.md` (stage explicit paths, never
`git add .`, never stash) deliberately rather than by luck.

Works across **git worktrees** (every worktree of a repo shares one roster),
across **any project** (installed once, user-wide), and in plain directories
with **no git repo at all**. Windows, macOS and Linux.

## Documentation

| Doc                                    | Covers                                                     |
| -------------------------------------- | ---------------------------------------------------------- |
| [Views](docs/views.md)                 | `who`, `log`, `files`, `blame`, and the work board          |
| [Naming an agent](docs/naming.md)      | how a session gets, keeps and changes its name              |
| [Operating](docs/operating.md)         | configuration, measured cost, known limits, planned work    |
| [Internals](docs/internals.md)         | every file and its role, tests, how failures surface        |
| [Design notes](docs/design-notes.md)   | why the awkward parts are the way they are                  |

## Install

```sh
bun .claude/hooks/presence/install.ts           # install / update
bun .claude/hooks/presence/install.ts --force   # re-register hooks
bun .claude/hooks/presence/install.ts --remove  # uninstall
```

Copies the scripts to `~/.claude/agent-presence/bin/`, installs a `crew` command
into `~/.local/bin/`, and registers its hooks in `~/.claude/settings.json`
(backing it up first, and merging rather than replacing — your other settings are
untouched). **Restart your sessions** afterwards; hooks are read at session start.

```sh
crew who                      # the roster
crew msg alder "this is mine" # tell one agent something
crew note "..." --scope src/  # leave a finding for whoever edits next
```

On Windows both `crew` (Git Bash) and `crew.cmd` (PowerShell, cmd) are written,
because agents work in either. If `~/.local/bin` is not on your PATH the
installer says so rather than leaving you a command that is not there.

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
session start and on `crew who` — never on a per-prompt path.

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
crew msg traffic-16 "waterSim.ts is mine for the next hour"   # to one agent
crew say "branch before committing"                           # to everyone
crew msg traffic-16 "..." --from traffic-12                   # speak AS an agent
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
> file directly, and `crew log` shows everything. This keeps contexts clean and
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
| `note`  | `the user, to everyone: ...`            | you, via `crew say` |
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

## Commands

`crew help` prints this list. It is generated from the verb table in
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

