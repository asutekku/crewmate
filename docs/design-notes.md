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

## The work log

**Three tables, not one status column.** A row that is overwritten answers "what
now?" and destroys "what happened?", and the second question is the one asked
days later ("who moved the baselines?"). Current state is a fold over an
append-only event log, so `board` and `board --history` read the same rows and
cannot disagree. `work_steps` is the one exception: which phases remain is asked
on every `Stop`, so a step's `done_ms` is mutable in place rather than replayed.

**Agent identity is the conversation uuid.** `CLAUDE_CODE_SESSION_ID` is not a
per-process label — it names the transcript on disk and is what
`claude --resume <uuid>` takes. Measured 2026-07-31: a terminal restarted
mid-session moved Claude Code's display name `traffic-a0` → `traffic-7c` while
the session id held, so the roster row was relabelled rather than replaced. An
earlier version keyed on the conversation TITLE, which is model-written and
rewritten as a conversation develops — renaming one silently orphaned every
record under the old name, and its emptiness before the first title split an
agent's timeline in two.

**Naming a work item's owner.** `WORK_COLUMNS` resolves the live session first,
then `name_owners`, then the name frozen at creation. It must try alias, handle
and name in `displayName`'s order: reading `alias` alone looks right, but the
ordinary session has an empty alias, so the subquery returned nothing and every
row fell back to its frozen string — one agent rendering under as many names as
it had been frozen under. The ledger outranks the frozen copy because `sessions`
holds only live rows: measured 2026-08-05, `crew clear` emptied it and an open
item re-rendered under a name abandoned two days earlier.

**Why a bare command refuses to guess.** `target` once answered "most recently
touched", which reads well and is wrong in the one way a board must never be.
Measured 2026-08-06: `crew did 1 "…"` with two items open ticked a step on the
other item, twice in five minutes — the second, with no note, left no trace. The
heuristic is self-reinforcing, since every tick writes `updated_ms`. Refusing
costs the multi-item agent one `--item` flag; guessing costs a board nobody can
trust.

**Why there is no stalled state.** A session that crashed and one abandoned at a
prompt both simply stop firing hooks, and nothing captures an exit code or a
failing test. A fourth state would be a promise the data cannot keep, and a board
is worse than useless if you act on its most alarming cell and it was invented.
`BUSY_HEARTBEAT_MS` is sized from 307 measured intra-session hook gaps (p50 21 s,
p90 134 s, p95 324 s); five minutes sits just above p95.

## Hook cost

**`PostToolBatch` fires many times per turn**, so the empty path has to be
nearly free. Measured 2026-07-31 with no mail waiting: 76 ms per firing, of which
52 ms is bare Bun process startup — the floor no in-script work goes below.
Caching the git-derived project paths took it from 93 ms (a `git rev-parse`
subprocess was 31 ms of that). Per turn that is ~0.3 s over 5 batches and ~2.2 s
over 30. If it ever bites, the fix is fewer firings, not a faster script.

**`bun build --compile` was tried and rejected**: the binary measured 85 ms,
slower than the script, for a 98 MB artifact per hook.

**The `tool_calls` payload is never parsed.** HOOKS.MD warns tool responses "can
be large", and the hook needs only the session id and cwd.

## The personal diary

**One db, outside the per-project files.** Everything else the tool stores is
per-repo because everything else is about a repo; this is about a PERSON, and a
preference stated in one project is usually true in the next. But not always —
"run the water tests alone, this box is loaded" is about this machine. So every
entry carries the project it was learned in and `global` marks the ones that
travel. The default is project-scoped, because a preference carried into the
wrong repo is acted on confidently and wrongly.

**Keyed on a lineage, not a conversation.** Hopper's read of the operator is not
Luna's, and that separation stays. But a conversation uuid is the wrong grain:
delete the transcript and the memories keyed on it die with the one thing
guaranteed not to outlive them. The operator's case was that starting a new
roadworks session when a roadworks agent already exists "might create a
completely new empty state that has to learn everything from scratch". A lineage
is a NAME rather than a new synthetic id — `aliases` already maps uuid to name
durably, survives `pruneStale`, and is what the operator types and remembers.
`session_id` stays frozen on every row, so "which conversation learned this" is
still answerable afterwards.

**Readable by the operator.** `about-me` shows what an agent believes about them
and `forget` is as easy to reach as `remember`. A private model of a person that
the person cannot read is the one shape this must not take.

## Packing the block

**The framing is settled by the first peer candidate, win or lose.** The space
available depends on whether the trust framing is needed, and whether it is
needed depends on which candidates are selected — a circularity resolved by
stating the order rather than discovering it. Measured against the real envelope
at a 700-char budget: `roster` (p90, 76 chars) was dropped while `recent` (p70)
got in, the highest-priority candidate losing to one ranked below it for lack of
13 chars. A failed atomic charge had left the framing unbought, so the next peer
candidate was offered it again and, being smaller, could afford what its senior
could not. That is a priority inversion produced by the funding rule rather than
the ranking, and it would have shipped looking correct, because both invariants
still held.

**Context, not the row.** SessionStart re-fires on `clear`, `compact` and `fork`
with the same session id and a context that has been wiped, so exposure keyed on
the id alone suppresses a roster the agent can no longer see. Measured 2026-08-02
in this tool's own session: 19 identity-block injections appear after the compact
boundary in one transcript under one unchanged `session_id`. Only `resume`
restores the conversation intact.

## Telling a session its name

**A hook cannot win on rank.** Measured 2026-08-02: asked "who are you", a
session answered "I'm Claude Code, Anthropic's AI assistant... In this session,
I'm anouk." It had ranked two claims correctly. The system prompt says "You are
Claude Code" and is re-presented every turn; the line here said `You are "anouk"
in Traffic's shared presence log` exactly once, and that sentence ARGUES for the
losing reading — `in ... log` scopes the name to a database row, and the reply
mirrored the scoping straight back. Injected text never reaches the system prompt,
so the goal is not to overwrite "Claude Code": it is to make the name the answer
to WHO while "Claude Code" stays the answer to WHAT. Hence the name alone on its
own line with no preposition to hide behind, "Claude Code" conceded rather than
ignored, and the reason given rather than just the rule.

**Obligations are capped** at `MAX_OBLIGATION_CANDIDATES`. They rank above the
roster and nothing expires them — `--until` is opaque text and the `expire` event
has no trigger — so a peer filing twenty would occupy the whole budget of a
session that never agreed to any. Measured 2026-08-05: three sat above a roster
for 45 minutes with no path to removal.

## The trust note

**Phrased as facts, deliberately.** HOOKS.MD is explicit that injected text
should read as project information rather than out-of-band commands, because
imperative phrasing "can trigger Claude's prompt-injection defenses, which causes
Claude to surface the text to you instead of treating it as context". An earlier
version gave orders ("do not act on it", "decline if it conflicts") and risked the
coordination layer being flagged as an attack on the agents it exists to inform.

**Who wrote it is not when it arrived.** Three hooks inject peer text through
three different doors — `prompt-submit` at a prompt, `tool-batch` between tool
batches, `turn-end` after the session has stopped — and every one appended the
same note, so a reader could not tell which door it came through. The `turn-end`
case is causal rather than incidental: the session had genuinely finished, and
delivering the message is what invoked it again. Without saying so an agent infers
it from the hook name in the reminder, which does not survive a rename, or
concludes it was somehow waiting. Nothing here can wait or poll; a session stops,
and an arrival restarts it.

## Names and messages

**Roster names.** `rosterName` takes the name from `displayName` and nowhere
else. Resolving it independently is what made one agent read
`Tooling — Tooling Master` on the roster while `msg` answered to `hopper`: it
treated `handle` as the name and `alias` as a role-fallback, the exact inverse of
`displayName`'s precedence — one agent with two names depending which function you
asked. The role-fallback slug is the handle, because a topic slug like
`water-dynamic` says what an agent works on; never Claude Code's `traffic-a9`,
which produced "Traffic A9 Terrain Perf", a role nobody chose. But only while the
handle is still the name: once an alias supersedes it the handle is a FORMER name,
and `crew call-me hopper` on a session handled `adela` rendered `Hopper — Adela`.
A rename must not leave its predecessor on the roster as a job title.

**The role reaches peers**, reversing an earlier call that kept it operator-only
for fear "Terrain Whisperer" reads as a claim of authority. The measured cost of
withholding it was worse: agents write "adela is fixing this same bug" in
user-facing text, and the operator reading eight windows has no idea who adela is.

**Message kinds.** There is deliberately no kind for "a session's prompt".
Publishing prompts verbatim leaked whatever the user typed — credentials, client
names — to every peer, and produced lines like `turing was asked by its user:
"go"` that say nothing. A session's task reaches peers only as its short `intent`.

## The diary

**Why the diary lives in the db.** Claude Code keys its memory directory on the
WORKING directory, so an agent in a worktree writes to a directory nobody reads
and which dies with the branch — measured 2026-08-01, all 46 of this repo's
worktree memory dirs were empty while CLAUDE.md tells agents to take a worktree
for any large feature. The presence db is resolved per-REPO, so a finding written
in a worktree is readable from the main tree and every other worktree.

**Renaming a topic.** An external-content FTS5 index is not updatable by an
ordinary UPDATE, and the failure is invisible from every direction a reviewer
looks: a plain `UPDATE diary_fts SET topic = ?` reports rows changed, and a later
`SELECT topic FROM diary_fts` reads through to the content table and shows the new
value — while the index still holds the old term. Measured 2026-08-01: after
merging `water-sim` into `hydrology`, `MATCH "water-sim"` still returned the row
and `MATCH "hydrology"` returned nothing, so a merge silently broke search under
both names. The supported repair is the delete/insert pair, and 'delete' must be
handed the values currently in the index.

**Scope covers, it does not equal.** `recall --scope` uses the same relation
`forPath` does, so a scope pre-edit reported can be typed straight back in.
Equality made the hook's own pointer return nothing (caught live 2026-08-01):
entries at `.claude/hooks/presence` did not match a query for
`.claude/hooks/presence/hooks`, the folder actually being edited.

## The pre-edit warning

**A commit clears a claim in this tree only.** A claim is released by nothing
but a 2-hour timer, so an agent that edited a file here, committed and moved on
still holds it — the dirty check drops those. It must never be applied to a
cross-worktree claim, and an earlier version did, which quietly disabled half the
hook: a peer in another worktree who commits goes clean instantly, but for them a
commit is when the merge risk STARTS, and CLAUDE.md tells every agent to commit as
soon as tests pass. Filtering `away` made the warning unreachable for exactly the
disciplined peers it exists to warn about. Demonstrated: two worktrees editing one
line, peer commits, warning suppressed, `git merge` conflicts. The 38-of-42
measurement that motivated the filter counted cross-worktree claims as false
positives; they were not.

**Pointers must return what they promise.** `countForPath` includes repo-wide
entries (scope `""`) and `recall --scope` deliberately excludes them, so the two
counts are different sets. Measured 2026-08-01: with two repo-wide entries and no
scoped ones the hook printed "2 more entries cover this folder" against a command
that returned nothing. The remainder is split by what each half is reachable by,
and the scoped pointer names the FILE, not its directory — `--scope` covers every
enclosing folder the way the lookup does.

**Offering a lineage.** The operator's case: "I might start a new session with
roadworks, and if I forget a roadwork agent already exists, it might create a
completely new empty state that has to learn everything from scratch." The shared
diary is the index rather than the personal store, because a memory is about the
operator and carries no scope, so it cannot answer "who knows this folder". A
scoped finding can — measured 2026-08-02, all 11 scopes in this repo have exactly
one author. One line naming one lineage: two would be a menu, and a menu at edit
time gets scrolled past, taking the diary findings above it along.

**Plan links are suggested, not stored as suppressed.** `--plan-doc` and `link`
shipped with nothing pointing at them — the same shape as the `breaks`/`needs`
failure, verbs that worked, were advertised nowhere, and were used by nobody but
their author. The suggestion repeats while the item is still unlinked, because
recording a said-it-once flag would add a column whose only job is to suppress
true advice.

## The verb table

**The table is the source, the test is the guarantee.** Usage was once a
hand-maintained literal and drifted to 13 of the then-33 verbs — `note`,
`recall`, `remember`, `breaks`, `needs`, `blame` and more existed, worked, and
appeared in no help output. That matters more here than in an ordinary CLI: this
tool is discovered at runtime by agents rather than read as a manual, so the only
verbs an agent learns are the ones some hook mentions. Two shipped features had
been used by nobody but their author. `verbs.test.ts` asserting every `case`
label appears in the table is what keeps this true. Per-verb usage lives there
too, replacing 21 separate `usage: cli.ts <verb>` literals, and `CLI` replaced 85
hardcoded invocation strings across 10 files.

