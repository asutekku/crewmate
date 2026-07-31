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

Copies the scripts to `~/.claude/agent-presence/bin/` and registers 13 hooks in
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

| Recipient is | Arrives |
|---|---|
| mid-turn, using tools | **between tool batches** (`PostToolBatch`) — seconds |
| ending a turn | at `Stop`, but **only if addressed to it** |
| at a prompt | on its next `UserPromptSubmit` |
| idle at a prompt | not until the human prompts it |

`PostToolBatch` is what makes this usable: a busy agent — the one actually
editing files — picks up "waterSim.ts is mine" within seconds instead of at the
end of a 20-minute run.

**Stop delivery is deliberately narrow.** Injecting at `Stop` *continues the
turn* (HOOKS.MD: "The conversation continues so Claude can act on it"), under the
same 8-continuation cap as blocking. So only messages addressed to that session
and human broadcasts are delivered there; routine `done`/`claim` chatter waits.
Otherwise every agent's turn-end announcement would extend every other agent's
turn, and two agents could bounce `done` lines off each other until the cap cut
them off. `stop_hook_active` suppresses delivery entirely.

**Nothing wakes an idle session** — that limit is real and unfixed here.

### Whose words are these

| Kind | Renders as | Author |
|---|---|---|
| `say` | `traffic-12 to traffic-16: ...` | that agent |
| `say` | `traffic-12 to everyone: ...` | that agent, broadcast |
| `note` | `the user, to everyone: ...` | you, via `cli.ts say` |
| `done` | `traffic-12 done: finished a turn: ...` | the agent |
| `claim` | `traffic-12 claim: also editing ...` | the agent |

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
bun ~/.claude/agent-presence/bin/cli.ts where      # which project/db this dir maps to
bun ~/.claude/agent-presence/bin/cli.ts clear      # wipe roster (log self-prunes)
```

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

Colour is a second channel, never the only one: every distinction is also in the
words. `NO_COLOR`, `FORCE_COLOR` and piping are honoured, so a redirected log is
plain text.

**Hook output is never colourised** — it goes into an agent's context window,
where escape codes cost tokens and buy nothing.

## Files

| File | Role |
|---|---|
| `repo.ts` | Project identity + db path (cached — a `git rev-parse` costs 31 ms). |
| `agents.ts` | Reads `claude agents --json` for real names + idle/busy. |
| `topic.ts` | Lossy, credential-rejecting text → one-line roster label. |
| `colour.ts` | ANSI for the CLI only. Never reaches an agent's context. |
| `tool-batch.ts` | **PostToolBatch** — mid-turn delivery. |
| `turn-failed.ts` | **StopFailure** — a dead turn stops reading as "still working". |
| `notify.ts` | **Notification** — records "waiting for permission". |
| `subagent-start.ts` | **SubagentStart** — tells a subagent what peers hold. |
| `compacted.ts` | **PostCompact** — refreshes intent from the compaction summary. |
| `cwd-changed.ts` | **CwdChanged** — keeps worktree/branch true after a `cd`. |
| `task-changed.ts` | **TaskCreated/Completed** — mirrors per-session tasks to a shared board. |
| `store.ts` | SQLite schema + all state access. The only file that knows SQL. |
| `shared.ts` | Payload reading, report formatting, `emit`. |
| `session-start.ts` | Register; inject roster. |
| `prompt-submit.ts` | Heartbeat; deliver unread; record stated task. |
| `pre-edit.ts` | Claim path; warn on peer overlap. |
| `turn-end.ts` | Publish turn completion; deliver mid-turn news. |
| `session-end.ts` | Deregister on clean exit. |
| `cli.ts` | Human inspection + broadcast. |
| `install.ts` | Copy to `~/.claude/agent-presence/bin/`, register hooks. |
| `topic.test.ts` | What may become a roster label, and what may not. |
| `roster.test.ts` | Roster layout, asserted with colour codes stripped. |

## Tests

```sh
bun test ./.claude/hooks/presence/*.test.ts        # the leading ./ is required
PRESENCE_TEST_DB=/tmp/x.db bun pre-edit.ts < payload.json   # run a hook safely
```

**`PRESENCE_TEST_DB` redirects every hook to a throwaway db, and anything that
runs a hook must set it.** Testing a hook means *running* it, and running it
writes to whatever db it resolves — so a test payload lands in the live roster
as a real session with real claims and real log lines. That happened on
2026-07-31: probe sessions left 26 junk messages and a false contested-file
warning naming a session on a file it never edited, which the user had to read
past and which made a fake collision look real.

**The path must be explicit.** `bun test` skips dot-directories, so this file is
invisible to the repo-wide sweep and a bare `bun test .claude/...` matches
nothing — it reports "0 files searched" rather than failing, which reads exactly
like a pass. It is run by hand after touching `topic.ts`.

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
`install.ts` catch *expected* failures on constantly-running paths (a missing
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

| Path | Cost | Frequency |
|---|---|---|
| bare Bun startup | **52 ms** | the floor for every hook |
| `PostToolBatch`, nothing to deliver | **76 ms** | after each tool batch |
| `SessionStart` (samples `claude agents --json`) | ~1 s | once per session |
| everything else | ~72 ms | rare (per turn, per `cd`, per failure) |

`PostToolBatch` is the only one on a hot path: ~0.3 s per turn over 5 batches,
~2.2 s over 30. Acceptable beside this repo's 7 s-per-edit typecheck hook, but
not free — if it bites, the fix is fewer firings, not a faster script.

Two things were tried and rejected on measurement: `bun build --compile` (85 ms,
**slower** than the script, for a 98 MB binary per hook), and calling
`claude agents --json` anywhere per-prompt (950 ms). Caching the git-derived
project paths took `PostToolBatch` from 93 ms to 76 ms.

## Known limits

- **Nothing wakes an idle session.** A session sitting at a prompt runs no hooks.
  `PostToolBatch` closes the gap for a *busy* agent — the one actually editing —
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
  frozen on an *answer it had given*, and two blank — nothing current. A stale
  label is worse than a moving one, because a peer reads the roster to decide
  whether to interrupt.

  Prompts that are pure filler — "Lovely, start working on it." — set nothing,
  because a *resumed* session's opening prompt is usually an acknowledgement of
  a conversation the roster never saw. With three live sessions on 2026-07-31 all
  three stated tasks were exactly that shape, so the roster's headline column
  described nothing.

  Pasted terminal output is rejected for the same reason: leaving the slot open
  meant the next prompt could fill it, and a pasted `cli.ts log` promptly became
  a session's "stated task". A session with no stated task shows **nothing** in
  that column — the `editing` line beneath already names its files, and a summary
  there would be a strict subset of the detail directly below it.
- **A session's worktree is corrected from the cwd of each edit**, not trusted
  from session start. `SessionStart`'s cwd is where the session was *launched*
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
