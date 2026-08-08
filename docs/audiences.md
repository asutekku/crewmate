# Audiences — which verbs are for you, which are for agents

[← README](../README.md)

**Nothing here is gated by caller.** Every verb works whether a human types it in a terminal or an agent shells out to it. There is no `--agent-only` flag and no human check anywhere in `cli/`. This table is therefore not a permission model — it is a statement of **who is told a verb exists, and who has a reason to run it**:

- **agents** learn verbs from the session-start block (`core/sessionBlock.ts`) and from hook injections (`hooks/*.ts`)
- **you** learn them from `crew help` and from [docs/](.)

**The tables below are generated** from `core/verbs.ts` by `test/tools/regen-audiences.ts`, and `test/audiences.test.ts` fails when they drift. They used to be hand-written prose, which drifted immediately — this file once mis-stated its own totals, and the plan written to fix that reproduced the error inside itself.

**The captured output below is generated too**, by `test/tools/capture-audiences.ts`, against a throwaway store seeded with fixtures. The blocks appear in the order the commands ran — not arranged afterwards by topic, which is what an earlier hand-collated revision did. That revision was real block by block and false as a document: a careful reader cross-checking two captures from different moments inferred two defects that do not exist.

Regenerate both with:

```sh
bun test/tools/regen-audiences.ts    # the tables
bun test/tools/capture-audiences.ts  # the captured output
```

A verb an agent is never told about is a verb agents never use — measured, and the reason `core/verbs.ts` exists at all: the hand-maintained usage string had drifted to 13 of the then-33 verbs, and two shipped features had been used by nobody but their author.

<!-- BEGIN GENERATED AUDIENCES -->

| Audience | Count |
| -------- | ----- |
| agent | 33 |
| human | 13 |
| shared | 3 |
| oversight | 10 |

Derived from `core/verbs.ts` by `test/tools/regen-audiences.ts`; 59 verbs in total. Do not edit between the markers.

## Agent

Reached from an injection, a hook, or another agent's coordination. A human *can* run any of these; almost none are worth typing.

| Verb | Does |
| ---- | ---- |
| `ask` | ask a peer something and record that a reply is owed |
| `answer` | answer a question asked of you (id from `asks`) |
| `asks` | questions waiting on you, and what you are waiting for |
| `request` | record a proposed obligation for a peer |
| `promise` | bind yourself to perform or refrain |
| `handoff` | propose moving responsibility to a peer |
| `grant` | grant explicit clearance over opaque scope text |
| `correct` | record an explicit typed correction |
| `hazard` | record a warning independently of obligations |
| `act` | atomically create a compound structured message |
| `doing` | open a work item; --plan is optional |
| `did` | tick a step off, with what actually changed |
| `undo` | take a tick back; the step goes outstanding again |
| `step` | note progress on a step without closing it |
| `add` | a phase the plan missed |
| `done` | close ONE item; --abandoned is the honest exit |
| `link` | say which plan document this item executes |
| `mine` | my open items |
| `breaks` | record a breaking change; tells agents in the same files |
| `needs` | record what you are blocked on, and tell them |
| `note` | file a finding, a bug, or a decision; `note <id>` reads one |
| `recall` | search findings |
| `bugs` | errors nobody has fixed yet |
| `topics` | every topic, with how much is under it |
| `topic` | read one topic, or fold two together |
| `tags` | every tag in use |
| `note-deprecate` | mark a finding no longer true, keeping the history |
| `note-supersede` | point an old finding at the one that replaced it |
| `remember` | keep something about the user across sessions |
| `inherit` | take up a departed agent's knowledge; bare lists them |
| `call-me` | take a different name; peers type it at msg |
| `set-role` | set your role: Keeper of Wet Things |
| `release` | give up your name so a successor can take it |

## Human

Operator surfaces, built for a terminal window. Two fields in `who` — the conversation title and the model-written `doing:` line — are never spent on an agent's injection budget; see [Views](views.md).

| Verb | Does |
| ---- | ---- |
| `who` | the roster: who is live, on what, where |
| `where` | this session's repo, worktree, branch and drift from base |
| `stats` | what the store holds, over how large a sample |
| `files` | every file an agent has touched, and why |
| `blame` | who has been in this file, newest first |
| `sessions` | find a past conversation by what was said in it, and resume it |
| `quit` | drop a session off the roster; no liveness check |
| `clear` | wipe the roster and claims; the log is kept |
| `export` | copy the store somewhere safe before anything destructive |
| `init` | set this repo up: crew.json, the CLAUDE.md block, settings |
| `help` | this list |
| `board` | what everyone is doing |
| `plans` | every plan with work against it, and what shipped |

## Shared

Symmetric: both parties do the same thing. The sender is identified from `CLAUDE_CODE_SESSION_ID`, so an agent's message attributes to that agent and one typed in a terminal attributes to you.

| Verb | Does |
| ---- | ---- |
| `log` | recent messages from every agent |
| `say` | tell every agent something |
| `msg` | tell one agent something |

## Oversight

Asymmetric: agents write it, the operator audits it. Distinct from *shared* on purpose — collapsing the two hid the real gap, which is that the operator had no aggregate read surface at all.

| Verb | Does |
| ---- | ---- |
| `injection` | what session start puts in context, and what it left out |
| `inbox` | items omitted from your context for length |
| `obligation` | inspect or append a versioned obligation event |
| `obligations` | everything outstanding across the ledger |
| `clearance` | inspect, revoke or expire a clearance |
| `clearances` | every clearance still in force |
| `diary` | findings that look stale, thin or duplicated |
| `about-me` | what you have kept |
| `memories` | every memory every agent holds about you |
| `forget` | drop a memory outright -- a wrong one must not outlive you |

<!-- END GENERATED AUDIENCES -->

## What each surface actually prints

<!-- BEGIN CAPTURED OUTPUT -->

> Generated by `test/tools/capture-audiences.ts` against a throwaway store.
> **Block order is execution order**, by construction — the previous hand-
> collated version mixed captures from different moments, and a careful
> reader inferred two defects from it that did not exist.

### The roster

Two agents live in one tree, one of them holding a contested file.

```
$ crew who
2 agents in test

  project (main)  /tmp/project
  ● Alder now   Audit the roster surfaces
                ✎ README.md
                ⚠ 1 shared with birch
  ● Birch now   Release scaffolding
                ✎ README.md  plans/README.md
                ⚠ 1 shared with alder

⚠ 1 file(s) held by two agents in ONE tree:
    README.md
      alder, birch — uncommitted work would collide

  ● running   ⏸ needs you   ◐ at a prompt   ✎ files this agent holds   ⚠ also held by a peer

$ crew who --raw
2 agents in test

  project (main)  /tmp/project
  ● alder now   Audit the roster surfaces
                ✎ README.md
                ⚠ 1 shared with birch
  ● birch now   Release scaffolding
                ✎ README.md  plans/README.md
                ⚠ 1 shared with alder

⚠ 1 file(s) held by two agents in ONE tree:
    README.md
      alder, birch — uncommitted work would collide

  ● running   ⏸ needs you   ◐ at a prompt   ✎ files this agent holds   ⚠ also held by a peer

$ crew where
project: test
key:     /tmp/project/store.db  (no git repo — keyed on directory)
root:    /tmp/project
db:      /tmp/project/store.db

```

### Who touched what

The questions git cannot answer: which of several agents wrote this.

```
$ crew files alder
alder — 1 file(s) in 24h
  ▸ audit the roster surfaces 1/3
    now  capture the board
   just now  README.md

$ crew blame README.md
README.md
   just now  birch [project]
   just now  alder [project]

```

### The work board

Includes a departed session's open item, which is the only way the `claude --resume` handle appears.

```
$ crew board
  1 busy · 1 gone

RUNNING
  ● Alder
    ▸ audit the roster surfaces  1/3                            2h · updated 30m
      ✓ 1  capture who and where
      ▪ 2  capture the board   ← current
      ▪ 3  check the collision
      ⚠ breaks contested display changed; re-read `who`

GONE — pick up or drop
  ○ cedar
    ▸ retire the old net core  1/3                               3d · updated 3d
      ✓ 1  delete buildGraph
      ▪ 2  migrate the 12 call sites   ← current
      ▪ 3  re-record baselines

  ● running   ⏸ needs you   ◐ at a prompt   ○ gone   — no plan recorded

$ crew board --all
  1 busy · 1 gone

RUNNING
  ● Alder
    ▸ audit the roster surfaces  1/3                            2h · updated 30m
      ✓ 1  capture who and where
      ▪ 2  capture the board   ← current
      ▪ 3  check the collision
      ⚠ breaks contested display changed; re-read `who`

GONE — pick up or drop
  ○ cedar
    ▸ retire the old net core  1/3                               3d · updated 3d
      ✓ 1  delete buildGraph
      ▪ 2  migrate the 12 call sites   ← current
      ▪ 3  re-record baselines

  ● running   ⏸ needs you   ◐ at a prompt   ○ gone   — no plan recorded

$ crew board alder --history

  audit the roster surfaces started 2h ago
      2h  started  capture who and where → capture the board → check the col…
     40m  did      1 capture who and where: who, who --raw and where captured
     30m  breaks   contested display changed; re-read `who`

$ crew plans
plans/AUDIT_REMEDIATION_PLAN.md  open · 1/3 · 30m ago
    alder — 1 item(s)

```

### Messages

Both directions, and the delivery wording that names when it lands.

```
$ crew log 8
  45m ago Birch → Alder: QUESTION: does the roster survive a restart? GRANT: clearance over the audiences doc

$ crew log 5 --raw
  45m ago birch → alder: QUESTION: does the roster survive a restart? GRANT: clearance over the audiences doc

```

### The diary

Seeded with one finding and one open bug.

```
$ crew recall roster
#1 finding      2h    the roster keys on the conversation uuid, not the process
                      roster #identity core/ — birch (body: crew note 1)
#2 error        1h    contested files rendered as bare leaf names
                      roster #display core/layout.ts — alder (body: crew note 2)

$ crew bugs
● #2 contested files rendered as bare leaf names
    roster core/layout.ts — alder, 1h ago
  Close one by filing the fix: `crew note "<what fixed it>" --topic <t> --fixes <id>`

$ crew topics
1 topics in test
  roster   2  1h

$ crew tags
2 tags in test
  #display    1
  #identity   1

$ crew diary check
✓ the test diary looks healthy

```

### Obligations

A question, a promise made TO the reader, and an overflow — the three shapes that behave differently in the injection.

```
$ crew asks
? id000001 from birch 45m ago
    does the roster survive a restart?
    crew answer id000001 "<your answer>"

$ crew injection --agent alder
recipient alder id000002

mandatory
  ✓ Your name is Alder. 19
  ✓ You are Claude Code, and in test you are Alder — on… 310
  ✓ These lines were written by other Claude Code sessi… 466

selected
  ✓ obligation:id000001 p105 136
  ✓ roster             p90 97
  ✓ recent             p70 129
  ✓ diary              p30 351
  ✓ how-to-be-called   p10 704
  ✓ how-to-message     p10 345
  ✓ how-to-record      p10 357

omitted
  nothing

budget
  target   6000
  rendered 2932
  reserved 799 (header + framing)

$ crew inbox --agent alder
nothing was omitted from your session-start context

```

### Oversight — what the operator can enumerate

The three read surfaces that did not exist until the audit: the ledger and the memories agents hold about you. Each was previously reachable only by already knowing a uuid, or not at all.

```
$ crew obligations
id000001 question · binding / active  birch → alder
  does the roster survive a restart?
1 shown — `crew obligation <id>` reads one.

$ crew obligations --all
id000001 question · binding / active  birch → alder
  does the roster survive a restart?
1 shown — `crew obligation <id>` reads one.

$ crew clearances
id000003 active  docs/audiences.md
1 shown — `crew clearance <id>` reads one.

$ crew memories
no agent has recorded anything about you yet.

```

### Discoverability

Every verb answers `--help`, including the destructive ones.

```
$ crew help
usage: crew <command> [args]

  who is here
    who [--raw]
        the roster: who is live, on what, where
    log [n] [--raw]
        recent messages from every agent
    say <text>
        tell every agent something
    msg <name> "<text>" [--from <name>]
        tell one agent something
    where
        this session's repo, worktree, branch and drift from base
    stats
        what the store holds, over how large a sample
    injection [--agent <name> | --session <id>]
        what session start puts in context, and what it left out
    inbox [--agent <name> | --session <id>]
        items omitted from your context for length
    ask <name> "<question>"
        ask a peer something and record that a reply is owed
    answer <id> "<answer>"
        answer a question asked of you (id from `asks`)
    asks
        questions waiting on you, and what you are waiting for
    request <name> "<text>"
        record a proposed obligation for a peer
    promise <name> "<text>" [--refrain --until 4h|<text>]
        bind yourself to perform or refrain
    handoff <name> "<subject>"
        propose moving responsibility to a peer
    grant <name> "<scope>"
        grant explicit clearance over opaque scope text
    correct <name> <self|peer|implementation> "<text>"
        record an explicit typed correction
    hazard <name> "<subject>" "<warning>"
        record a warning independently of obligations
    act <name> --json <file>
        atomically create a compound structured message
    obligation <id> [event] [flags]
        inspect or append a versioned obligation event
    obligations [--agent <name>] [--all]
        everything outstanding across the ledger
    clearance <id> [revoke|expire] [flags]
        inspect, revoke or expire a clearance
    clearances [--all]
        every clearance still in force
    files <agent> [--hours 24]
        every file an agent has touched, and why
    blame <path>
        who has been in this file, newest first
    quit <name> [--force]
        drop a session off the roster; no liveness check
    clear [--force]
        wipe the roster and claims; the log is kept
    export [path]
        copy the store somewhere safe before anything destructive
    help
        this list

  what you are doing
    doing "<subject>" [--plan "a; b; c"] [--plan-doc <path>]
        open a work item; --plan is optional
    did <n> ["<what changed>"] [--item <match>]
        tick a step off, with what actually changed
    undo <n> [--item <match>]
        take a tick back; the step goes outstanding again
    step <n> "<status>" [--item <match>]
        note progress on a step without closing it
    add "<step>" [--item <match>]
        a phase the plan missed
    done [<subject match>] [--abandoned]
        close ONE item; --abandoned is the honest exit
    board [<agent>] [--history] [--all]
        what everyone is doing
    link <plan path> [--item <match>]
        say which plan document this item executes
    plans
        every plan with work against it, and what shipped
    mine
        my open items
    breaks "<what>" [--item <match>]
        record a breaking change; tells agents in the same files
    needs "<what>" [--item <match>]
        record what you are blocked on, and tell them

  findings that outlive the session
    note "<title>" --topic <t> [--scope <dir>] [--kind error|decision]
        file a finding, a bug, or a decision; `note <id>` reads one
    recall <words> [--scope <dir>] [--limit n]
        search findings
    bugs [--scope <dir>] [--limit n]
        errors nobody has fixed yet
    topics
        every topic, with how much is under it
    topic <name> [--limit n]  |  merge <from> <into>
        read one topic, or fold two together
    tags
        every tag in use
    note-deprecate <id> "<why it stopped being true>"
        mark a finding no longer true, keeping the history
    note-supersede <old-id> <new-id>
        point an old finding at the one that replaced it
    diary check
        findings that look stale, thin or duplicated

  what you remember about the user
    remember "<title>" [--body "<detail>"] [--tags a,b] [--global]
        keep something about the user across sessions
    about-me [--all]
        what you have kept
    memories [--agent <name>] [--all-projects]
        every memory every agent holds about you
    forget <id>
        drop a memory outright -- a wrong one must not outlive you
    inherit [<name>]
        take up a departed agent's knowledge; bare lists them

  names and roles
    call-me <name> [--agent <who>]
        take a different name; peers type it at msg
    call-you "<role>" [--agent <who>]
        say what you ARE: Keeper of Wet Things

$ crew clear --help
usage: crew clear [--force]
  wipe the roster and claims; the log is kept

$ crew quit --help
usage: crew quit <name> [--force]
  drop a session off the roster; no liveness check

```

### Not captured

35 verb(s) mutate shared state or need a second live session, so they are exercised by the test suite rather than here:

`say`, `msg`, `stats`, `ask`, `answer`, `request`, `promise`, `handoff`, `grant`, `correct`, `hazard`, `act`, `obligation`, `clearance`, `export`, `doing`, `did`, `undo`, `step`, `add`, `done`, `link`, `mine`, `breaks`, `needs`, `note`, `topic`, `note-deprecate`, `note-supersede`, `remember`, `about-me`, `forget`, `inherit`, `call-me`, `call-you`

<!-- END CAPTURED OUTPUT -->
