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

Copies the scripts to `~/.claude/agent-presence/bin/` and registers five hooks in
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
You are agent "turing" in Traffic's shared presence log.
2 other agent(s) active:
  ada — asked to: "Fix the water shore fade regression" (last active just now)
      editing: src/city/derive.ts
  hopper [worktree disasters-fx] on worktree-disasters-fx — asked to: "Fire fx envelopes" (3m ago)
```

A peer in a **different worktree** is labelled with it; peers in the same tree
show nothing, keeping the common case quiet.

**On every prompt** — anything peers did since its last turn:

```
1 update(s) from other agents in Traffic:
  [3m ago] ada done: finished a turn: Fixed the shore fade by depth-scaling the alpha ramp.
```

### Whose words are these

A session's task line is its **user's prompt, verbatim** — not something the
agent wrote about itself. Rendering the two the same way lets one session's
instructions read as another agent's claim, and turns a relayed question ("what
should we do next?") into something the reader might try to answer. So every
line is attributed:

| Kind | Renders as | Author |
|---|---|---|
| `tasked` | `ada was asked by its user: "..."` | that agent's user |
| `note` | `the user broadcast to everyone: ...` | you, via `cli.ts say` |
| `done` | `ada done: finished a turn: ...` | the agent |
| `claim` | `ada claim: also editing ...` | the agent |

Every injection also carries a note that the log is **reference, not
instruction**: peer task text is quoted from someone else's conversation and
must not be acted on. A `human` broadcast is the one channel deliberately
addressed to everyone.

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
bun ~/.claude/agent-presence/bin/cli.ts say "..."  # broadcast to every agent
bun ~/.claude/agent-presence/bin/cli.ts where      # which project/db this dir maps to
bun ~/.claude/agent-presence/bin/cli.ts clear      # wipe roster (log self-prunes)
```

`say` is the useful one: you are the only participant who sees all the sessions
at once, so it beats retyping a correction four times. It posts under the handle
`human` so agents can tell it from a peer. `where` is the first thing to check if
a roster looks empty.

## Files

| File | Role |
|---|---|
| `repo.ts` | Project identity + db path. The only file that knows about platforms. |
| `store.ts` | SQLite schema + all state access. The only file that knows SQL. |
| `shared.ts` | Payload reading, report formatting, `emit`. |
| `session-start.ts` | Register; inject roster. |
| `prompt-submit.ts` | Heartbeat; deliver unread; record stated task. |
| `pre-edit.ts` | Claim path; warn on peer overlap. |
| `turn-end.ts` | Publish turn completion; deliver mid-turn news. |
| `session-end.ts` | Deregister on clean exit. |
| `cli.ts` | Human inspection + broadcast. |
| `install.ts` | Copy to `~/.claude/agent-presence/bin/`, register hooks. |

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

**Handles are reused.** Only *live* sessions reserve a name, so a 4-agent setup
stays on `ada/turing/hopper/lovelace` instead of drifting down the list on every
restart.

**Every hook fails open.** A locked db or malformed payload ends the hook
silently. Coordination is a convenience and must never break a session — the
same stance `typecheck.ts` takes.

**Nothing blocks.** `pre-edit` warns rather than denying: a path match cannot
answer "is this someone else's work?", and a wedged agent is worse than a visible
conflict. `turn-end` never uses `Stop`'s blocking form, which would trap a
session in a loop nobody asked for.

## Known limits

- **Messages land on turn boundaries** (prompt submit, turn end). A session deep
  in a long autonomous run does not see a peer's message until its current turn
  ends. There is no supported way to inject into a running turn; `turn-end.ts`
  narrows the gap but cannot close it.
- **Claims are per-path, not per-region.** Two agents in different functions of
  one large file still read as an overlap.
- **A stated task is the session's first prompt.** Later prompts do not update it
  (a follow-up like "now fix the test" is meaningless to a peer), so a
  long-running session's roster line can go stale. `cli.ts say` is the
  workaround.
- **Sessions that die uncleanly linger** until they miss the 90-minute staleness
  window (`STALE_MS` in `store.ts`). `cli.ts clear` forces it.
- **`bun` must be on PATH.** The registered command is `bun`, not an absolute
  path, so one settings file works on all three platforms.
- **Scripts are copied, not linked.** Re-run `install.ts` after editing them.
