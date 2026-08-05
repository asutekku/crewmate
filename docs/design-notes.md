# Design notes

[← README](../README.md)

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

