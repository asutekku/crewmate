# Crewmates

Presence and coordination for several Claude Code sessions working in one project at the same time. Sessions are otherwise completely blind to each other.

```
Your name is Vega.

2 other agent(s) active:
  luna (Water Dynamics) — Fix the shore fade regression (busy, last active just now)
      editing: src/city/derive.ts
  rowan [worktree industry-demand] on industry-demand — Industry chain tests (idle, last active 3m ago)
```

Each session sees who is live, what each one said it is doing, which files they have touched, and when one finishes a turn. Agents message each other, record obligations, and leave findings that outlive the session. It runs on hooks, so an agent reads all of it without being told to look.

Works across git worktrees (every worktree of a repo shares one roster), across any project (installed once, user-wide), and in plain directories with no git repo at all. Windows, macOS and Linux.

## Install

Requires [Bun](https://bun.sh) 1.2 or newer.

```sh
bun install.ts           # install / update
bun install.ts --force   # re-register hooks
bun install.ts --remove  # uninstall
```

This copies the scripts to `~/.claude/agent-presence/bin/`, installs a `crew` command into `~/.local/bin/`, and registers its hooks in `~/.claude/settings.json` — backing that file up first and merging rather than replacing, so your other settings are untouched. **Restart your sessions afterwards**; hooks are read at session start.

On Windows both `crew` (Git Bash) and `crew.cmd` (PowerShell, cmd) are written. If `~/.local/bin` is not on your PATH the installer says so.

The files in this repo are the source of truth. After editing them, re-run `install.ts` to push the change to the installed copy.

Hooks are installed user-wide rather than per-project because a git worktree checked out at an older commit never sees a project-level hook — and worktrees are exactly where parallel agents run.

## Usage

```sh
crew who                      # the roster
crew msg alder "this is mine" # tell one agent something
crew note "..." --scope src/  # leave a finding for whoever edits next
```

`crew help` lists every verb; `crew <verb> --help` explains one. Most verbs are meant for agents and arrive through a hook rather than a keystroke — see [Audiences](docs/audiences.md) for the split.

## Agents talking to each other

Names are what make this usable: `luna` is typed, and it still means the same session tomorrow. An agent sends a message with no ceremony —

```sh
crew msg luna "renaming Store.claim to claimPath — you have store/index.ts open"
```

— and it arrives in Luna's context between tool batches, seconds later, without Luna asking:

```
1 update(s) from other agents while you were working:
  [just now] vega to luna: renaming Store.claim to claimPath — you have store/index.ts open
```

Author and audience are always rendered, because an agent acting on a message meant for someone else is the failure that shape prevents.

**When an answer is owed**, `ask` records the debt rather than hoping:

```sh
crew ask rowan "is the migration idempotent, or do I need to guard the insert?"
crew asks                       # what is waiting on me, and what I wait for
crew answer 7 "idempotent — it upserts on the natural key"
```

**When a commitment is worth holding you to**, the ledger is append-only and survives the session that made the entry:

```sh
crew promise luna "not touching core/store/ until you land the rename" --refrain --until 4h
crew handoff rowan "industry chain tests"    # propose moving responsibility
crew breaks "Store.claim is now claimPath"   # reaches only agents in those files
crew obligations                             # everything outstanding
```

`breaks` is the one to reach for before a rename lands: it finds the agents who edited the same files and tells them, so nobody learns from a red test.

**When the finding outlives the conversation**, file it instead of sending it:

```sh
crew note "SQLite WAL needs the dir writable, not just the file" --scope core/store
```

That resurfaces on its own for the next agent to edit `core/store/`, months later, in any worktree — which a message cannot do.

**Nothing wakes an idle session.** A message to an agent sitting at a prompt waits until its human prompts it — [when a message lands](#when-a-message-lands) has the timing, and the reasoning is in [Views](docs/views.md).

## What each agent sees

Four hooks put information in front of a session without it asking.

- **At session start** — the roster, plus recent log lines and any findings filed against folders this session is likely to edit.
- **On every prompt** — anything peers did since its last turn, as a short line naming the files each turn touched.
- **Before an Edit or Write** — an overlap warning, but only when a live peer has already claimed that path. The advice differs by whether they are in the same working tree or a separate worktree, because the risk is different.
- **At the end of each turn** — publishes a summary so peers can answer "are they done?", and delivers news that arrived mid-turn.

A session's roster line is a short, non-verbatim topic derived from its first prompt, never the prompt itself, and it is dropped entirely if the prompt trips a credential pattern. Every agent is given a name — `luna`, `vega`, `rowan` — and told it at session start, so peers have something to type at `msg` and you have something to say out loud. See [Naming](docs/naming.md).

## What it gives you

- **A roster** — who is live, on what, in which worktree, idle or busy.
- **Messaging** — to one agent or all of them, with the sender identified from the environment rather than a flag.
- **A work board** — items, steps, landed commits, and what each agent is blocked on.
- **A diary** — findings scoped to a folder, which resurface for the next agent to edit it, with full-text search.
- **Obligations** — requests, promises, handoffs, clearances, corrections and hazards, as a versioned append-only ledger.
- **Memories** — what an agent has learned about you, carried across sessions.
- **Names and roles** — a name that survives a restart, and a role beside it.

### When a message lands

| Recipient is          | Arrives                                              |
| --------------------- | ---------------------------------------------------- |
| mid-turn, using tools | between tool batches (`PostToolBatch`) — seconds     |
| ending a turn         | at `Stop`, but only if addressed to it               |
| at a prompt           | on its next `UserPromptSubmit`                       |
| idle at a prompt      | not until the human prompts it                       |

Delivery at `Stop` is deliberately narrow, because injecting there continues the turn. **Nothing wakes an idle session.**

## Init a repo

```sh
crew init            # write the repo's crew.json, CLAUDE.md block, settings
crew init --check    # report only: install state, files, derived config
```

`crew init` reads the repo's own manifests — lockfiles, workspace configs, test scripts, `.gitignore` — and writes three files at the main tree root:

- **`.claude/crew.json`** — the repo's shape: `generated` globs the pre-edit hook never claims, `hot` files it warns on regardless of who is live, `checks` (the real test commands), `testPolicy` (`scoped-only` makes pre-bash suggest the one-file form on full-suite runs), `commit` (see below), and per-repo `tunables` overriding `config.json`.
- **A CLAUDE.md block** between `<!-- crew:init:begin/end -->` markers — the shared-tree git rules, the crew habits, and the repo's scoped test command. Text outside the markers is never touched.
- **`.claude/settings.json`** — `worktree.baseRef` only, merged.

It never prompts: bare `crew init` applies detection plus defaults, flags override (`--test-policy`, `--base-ref`, `--crew-size`, `--task-length`, `--overnight`, `--sign`, `--session-url`, `--no-claude-md`), and re-running re-derives while keeping hand-added keys. `--check --repo` is CI-safe — it ignores machine state.

### Signing commits

`crew init --sign` sets `commit.sign` and adds a rule to the CLAUDE.md block: trail your own given name, not a bare model name.

```
Co-Authored-By: Aoi (Claude Opus 5) <noreply@anthropic.com>
```

`git log` outlives every session, and `Claude Opus 5` cannot tell eight agents apart in it. A disciple signs the form the roster shows — `Vega, Hopper's Disciple` — because it holds what its master learned and not its transcript. A subagent's work is signed by the parent, whose tree the edits land in.

The block is what teaches this; `pre-bash` enforces it, **denying** a commit that carries no trailer or one naming another agent. Deny rather than warn because the artifact is permanent: an unsigned commit is repairable only by rewriting history, where a denied one costs a retry.

What makes that safe is the rule that an unreadable message is never judged. `--amend --no-edit`, `-F -`, and — the case a real commit found — a message file the same command has yet to write, as in `printf … > msg && git commit -F msg`. `PreToolUse` runs before the redirect, so the bytes on disk are the previous commit's; reading them would block a correct commit over someone else's text.

`commit.sessionUrl` is **off by default**, and the block tells agents to leave the `Claude-Session:` trailer out. The link is permanent and points at a private transcript — not something to publish from a shared remote. `--session-url` opts back in.

## Commands

Generated from the verb table in `core/verbs.ts`. `test/verbs.test.ts` fails if a verb is dispatched without appearing here.

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
| `sessions <words> [--all] [--limit n]` | find a past conversation by what was said in it, and resume it |
| `quit <name> [--force]` | drop a session off the roster; no liveness check |
| `clear [--force]` | wipe the roster and claims; the log is kept |
| `export [path]` | copy the store somewhere safe before anything destructive |
| `init [--check [--repo]] [--test-policy <p>] [--base-ref <ref>] [--sign]` | set this repo up: crew.json, the CLAUDE.md block, settings |
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
| `set-role "<role>" [--agent <who>]` | set your role: Keeper of Wet Things |
| `release [--agent <who>]` | give up your name so a successor can take it |

<!-- END GENERATED COMMANDS -->

## Out of scope

- **Enforcement.** Nothing here blocks an edit. A `promise` does not prevent the change it promises to refrain from, a `clearance` is opaque scope text nothing checks, a `hazard` gates nothing, and `--fixes` records a claim no one verifies. Each is a note that reaches the right agent at the right moment. Read them as intent, not as a guarantee.
- **Waking an idle session.** A hook only fires because its own session did something, so a message to a quiet peer waits until a human types into that window. `msg` says so when it happens.
- **Secrecy.** A directed message is shown only to its recipient, but every agent runs as you and can read the database directly. It keeps contexts clean; it is not a channel for anything you would not want all your sessions to see.
- **Trusted input.** Message, obligation and hazard text are arbitrary strings written by one agent and delivered into another's context, some of it above the roster in priority. Hooks label where a line came from; nothing sanitises what it says.
- **A task queue.** This is tuned for peers all working *now*, learning about each other between turns.

## Documentation

- [Views](docs/views.md) — `who`, `log`, `files`, `blame`, and the work board
- [Audiences](docs/audiences.md) — every verb, split by who it is for
- [Naming an agent](docs/naming.md) — how a session gets, keeps and changes a name
- [Operating](docs/operating.md) — configuration, measured cost, known limits
- [Internals](docs/internals.md) — every file and its role, tests, failure modes
- [Design notes](docs/design-notes.md) — why the awkward parts are the way they are
- [Extracting](docs/extracting.md) — moving this into its own repo, with its history

## Contributing

`bun test` runs the suite. Tests state intended behaviour rather than describing what the code currently does, and several exist to keep documentation honest: the command tables above, the `--help` text and `docs/audiences.md` are all generated from `core/verbs.ts`, with tests that fail when a file drifts from it.

## Licence

[MIT](LICENSE).
