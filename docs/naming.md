# Naming an agent

[← README](../README.md)

## Naming an agent

Every agent gets a **given name** at registration — `luna`, `vega`, `rowan` —
drawn from a pool of 280. That is what peers type (`msg luna`), and it is stated
to the agent at session start, because a name nobody is told is just a database
column.

**A name belongs to the conversation, for as long as the conversation exists.**
Resume a discussion after a month and the same agent answers: the name is keyed
on the conversation uuid in `name_owners`, and the only thing that returns it to
the pool is deleting the conversation itself. Nothing expires on a timer — an
agent that went quiet for a week is still who it was, and a new session can
never be handed a name a surviving conversation owns.

That is a deliberate reversal. The name used to be held for 60 hours after last
use, which answered a *pool* question ("may a stranger take this yet?") with the
same number as an *identity* one ("is this still hopper?"). Identity lost:
session `c5ce05bc` was reaped after 90 idle minutes and came back 68 hours later
as `akari`, mid-conversation. Worse, it had never really been the reservation
deciding — a name survived only while its agent's `edits` rows stayed inside the
window, so a conversation kept its identity by *editing files recently* and a
quieter one lost it sooner.

Beside it sits a **role**: what the agent is _for_.

```
Luna — Tooling Master       Vega — Keeper of Wet Things       Rowan — Terrain Whisperer
```

```sh
crew set-role "Tooling Master"   # what I am — changes as the work does
crew call-me  tooling            # a different name, if the assigned one won't do
crew set-role "…" --agent luna   # the operator setting either, for any agent
```

`call-you` and `role` still work — the verb was renamed on 2026-08-06 and the
old spellings are kept as aliases. `call-me`/`call-you` read as a matched pair
and were not one: an agent asked to give itself a role ran `call-you` and the
operator still had to ask what the verb did.

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


## The name in a commit

A name that reaches the roster, the board and every message still stopped at
the one artifact that outlives the session. `git log` recorded `Claude Opus 5`,
which names the model and not the agent — eight sessions in one tree collapse
to one line, and a lineage is invisible.

`crew init --sign` writes `commit.sign` into crew.json, and the CLAUDE.md block
then tells agents to trail their own name:

```
Co-Authored-By: Aoi (Claude Opus 5) <noreply@anthropic.com>
```

**Name first, the same rule `fullName` follows** — the unique part leads. A
disciple signs its read form, `Vega, Hopper's Disciple`, because that is
exactly the case generic attribution loses: two conversations on one lineage,
indistinguishable in `git log`. `checkCommitSignature` compares the GIVEN NAME
only, so the prose suffix is never parsed as a different agent.

**A minion's work is signed by the parent.** Its edits land in the parent's
tree and its tool calls already carry the parent's `session_id`; signing
`Aoi's Minion #2` would name something no peer can reach, and `minionName` is
read-only for the same reason.

The trailer is a CLAIM, not evidence — the distinction `commit-landed.ts`
draws about a sha. An agent can forget it or copy a peer's. `pre-bash` compares
it against the session running the command and DENIES a mismatch, so the claim
is checked before it becomes permanent.

**It only judges a message it actually read.** `--amend --no-edit` reuses text
this hook never sees, and `printf … > msg && git commit -F msg` — the form the
shared-tree rules teach — runs its redirect AFTER `PreToolUse`, leaving the
previous commit's message on disk. Measured 2026-08-08: a correctly signed
commit was refused over the unsigned test before it. Both cases now yield no
message and no verdict, because blocking a correct commit is the failure that
teaches agents to route around the hook.

`commit.sessionUrl` is off by default. `Claude-Session:` is a permanent link to
a private transcript, and a public remote is the wrong place for it.

## Handing a name to a successor

An agent gives its name up while still alive:

```sh
crew release            # outgoing session
crew call-me hopper     # successor session
```

Two commands in two sessions. The releasing agent takes a fresh name from the
pool and stays on the roster, so `msg` still reaches it.

**Why a verb exists for this.** `quit` does not free a name, and cannot: it
deregisters a session that may simply be idle, and taking names from agents that
are coming back is the bug the ledger was built to prevent. A live session also
cannot free its own name by any combination of other commands — the reads it
does to *verify* the release re-register it, because `quit` writes the departing
name into `aliases` and the next `register` reads it straight back.

Measured 2026-08-05/06: a `HANDOVER.md` opened with `crew call-me hopper`, and
that instruction was unrunnable by the agent it was written for. The successor
saw `✗ another live agent already answers to hopper`.

`release` drops the ledger row and the alias row in one transaction, so the name
is genuinely free the instant the command returns.
