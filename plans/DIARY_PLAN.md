# Diary — shared findings and personal character

*Created: 2026-08-01*

Two related features for the presence tool: a **shared diary** agents write
findings into and search by topic, tag and folder, and a **personal diary**
where an agent keeps what it has learned about the operator.

Nothing here is built yet. The measurements are, and they are what this is
built on. Operator rulings from 2026-08-01 are marked **RULED**.

---

## What already exists, measured 2026-08-01

A fourth memory system in a repo that already has three is not a feature, it is
a place for things to get lost. So: what is here, and what is actually missing.

**`~/.claude/projects/<project>/memory/` — 137 notes, 832 KB.** One fact per
file, frontmatter, index at `MEMORY.md` loaded every session. 87 `project`,
40 `feedback`, 8 `reference`, **0 `user`**. Median 36 lines, p90 66, max 203.

**The wikilink graph is real.** 132 of 137 notes link out; 350 links across 99
targets. Only **4 dangle**, all near-misses of notes that exist. So agents
already organise by linking, and already make the one mistake nothing checks.

**`MEMORY.md` has zero orphans** — every note is indexed, without enforcement.

**`work.ts`** is the board: present-tense, pruned at 7 days, *supposed* to
expire. Not memory, and should not become it.

### The hole: 46 worktrees, 46 empty memory directories

Claude Code keys memory on the **working directory**. An agent in
`.claude/worktrees/network-rewrite/` writes to
`~/.claude/projects/I--Projects-Traffic--claude-worktrees-network-rewrite/memory/`
— never read, discarded with the branch. Measured: all 46 are empty.

CLAUDE.md commit guide 3 tells agents to take a worktree for any large feature.
**So the agents doing the biggest work have amnesia by construction**, and the
ones fixing typos in the shared tree keep everything.

**RULED: store it in SQLite, because of worktrees.** The presence db is already
resolved per-REPO (`resolveProject` walks to the git toplevel and hashes that),
so all 46 worktrees already share one. The infrastructure exists and is
load-bearing; memory is the thing not using it.

### The second hole: no agent is anybody in particular

**Zero of 137 notes are agent-specific**, and the `user` type has no files at
all. Nowhere to put "Hopper checks the installed build before believing an edit
landed" that is not either global advice or lost at session end.

---

## Part 1 — The shared diary

### The entry

**RULED** — an entry carries date, author, **title**, body, topic, tags, kind,
folder scope, and freshness.

| Field | Why it is there |
|---|---|
| `ts_ms` | When it was learned. A finding about code has a shelf life. |
| `agent`, `session_id` | Frozen name + stable id, exactly as `edits` does it. The name for reading, the id for "is that agent still here". |
| `title` | **Required, one sentence, states a CLAIM.** What a search result shows. |
| `body` | Optional, longer, read on demand. The evidence and the why. |
| `topic` | ONE. The subject area: `roads`, `water`, `render`. |
| `tags` | MANY. Cross-cutting: `perf`, `flaky`, `windows`, `bun`. |
| `kind` | `finding` \| `warning` \| `error` \| `optimization`. |
| `scope` | Folder the entry is about — what `pre-edit` matches on. |
| `superseded_by` | Set when a later entry replaces this one. |
| `deprecated_ms` | Set when it stopped being true, with a reason. |

**Topic vs tags is the useful split.** A topic answers *what is this about*
(one, exclusive — the drawer an entry lives in). Tags answer *what is this like*
(many, cross-cutting, the thing you search when the topic is not what you
remember). `perf` is not a topic — it is true of roads, water and render at
once, and forcing it to be one is what makes a taxonomy fight its content.

### Title and body — RULED, and it replaces the single capped field

An earlier draft had one `body` with a ~500-char cap. That was wrong: it made
one field be both scannable AND complete, so the cap either truncated the
reasoning or let long entries wreck a list of ten results. Two fields let each
take the constraint that fits it.

- **Title is required and is what search returns.** One line, always shown.
- **Body is optional and read on demand** — `recall` lists titles, `note <id>`
  opens one. An agent spends context on a body only after the title earned it.

**A title states a CLAIM, not a subject.** This is measurable, not taste: the
137 existing memory notes each carry a one-line `description`, and the good ones
are all assertions —

> `generateCity produces ONLY home + farmhouse — no companies, no cityRun`
> `b.h/b.w/b.d are DOC dims, not rendered size — use resolveBuildingVisualBounds`
> `dist2 is LINEAR despite the name`

A noun phrase (`water simulation notes`) tells a searcher nothing and costs them
the body to find out. So the help text asks for a sentence with a verb in it.

**Sized from what agents actually write, not from a guess.** Measured across
those 137 descriptions: **median 140 chars, p90 193, max 362, min 85**. Nobody
wrote a two-word title even with no rule telling them not to. So a ~200 char
title cap fits the p90 and only bites the outliers; a 60-char "keep it short"
rule would have fought every real example. The body gets a much looser cap
(~2000) purely as a runaway guard, not as a style rule.

The `did`-note standard still applies to both: *"rim rule in, per-cell sea clamp
deleted, 3 callers moved"* is a record; *"fixed the water bug"* is a checkbox,
and a diary of checkboxes costs a search and returns nothing.

### Project scoping — is a `project_id` column needed?

Asked by the operator, and the answer differs between the two halves.

**Shared diary: NO, and adding one would be storing the filename inside the
file.** Measured 2026-08-01: there are 12 dbs under `~/.claude/agent-presence/`,
one per project, and `resolveProject` keys the git path on `--git-common-dir` —
which is **identical across every worktree of a repo**. That is precisely the
mechanism that closes the 46-empty-worktree hole. The diary tables live in the
repo's db and are therefore already project-scoped by construction.

One caveat worth recording: `Traffic-7338dc38.db` exists alongside
`I--Projects-Traffic-48171415.db`. Both are this repo, resolved from different
starting directories — the second is the git resolution, the first a NON-git
resolution of a subdirectory that never found a `.git`. So project identity is
already slightly fuzzy at the edges. It does not affect the diary (agents run
from the repo), but it is the reason not to hand-roll a second identity scheme
on top: fix the resolver if it ever matters, do not add a column that disagrees
with the filename.

### Open: 54 findings about this tool are in the wrong project

MEASURED 2026-08-05, when this tool was extracted from the game repo into its
own: **the diary did not come with it.** 54 findings about crewmates live in
`I:\Projects\Traffic`'s db, keyed to that project — the CRLF trap,
`PRESENCE_TEST_DB` freezing at import, the transcript-slug bug, and about twenty
more. A session starting in this repo has none of them.

**32 of the 54 are `--scope`d to the tool** and would qualify for migration.
That is the scope mechanism failing for its own author's findings, which is a
defect rather than an inconvenience: a scoped finding is a claim about *the
tool*, and the tool moved.

Not decided. Migration was offered to the user and the conversation ended before
an answer, so **ask before doing it.** Whatever the answer, the general case
stands: extracting a project should be able to carry its scoped findings, and
nothing today does that.

**Personal diary: YES, and this is the interesting half.** The operator wants it
globally available — what Hopper learned about the user should follow the user
to another repo. But *"prefers the numbers in the commit message"* travels,
while *"wants water tests run alone because this box is loaded"* is about this
project. So the personal store needs:

- to live in ONE db, not per-project, or it is not global; and
- a `project` column on each entry, plus a `global` flag for what travels.

Session start then injects `global == 1 OR project == <this repo>`. Without the
column an agent carries Traffic's specifics into an unrelated repo and confidently
acts on them, which is worse than not remembering.

Storage for it: a single `~/.claude/agent-presence/personal.db`, keyed by
session id, deliberately outside the per-project files. That is a new resolution
path (everything today is per-project) and is the one real piece of new
plumbing in this plan.

### Freshness, and knowing when to stop trusting an entry

Three separate states, deliberately not one flag:

- **Age.** Shown always, relative (`14d`). An unqualified claim about code from
  three months ago is not wrong, it is *unverified* — the operator's own memory
  notes already flag things this way and it is cheaper than a confident guess.
- **Deprecated.** The agent that finds an entry no longer true marks it with a
  REASON. It stays readable and searchable, greyed and last in results. Deleting
  it loses the more valuable fact — that this was believed, and why it stopped
  being true. (`selfflattens-kills-fast-path` in existing memory is exactly
  this: "OBSOLETE — a memory can be confidently wrong".)
- **Superseded.** Points at the entry that replaced it, so a search lands on the
  current one and can still see what it grew out of.

An entry is never silently rewritten. Append-only, like `edits`, for the same
reason: the history is the part that answers "why did we think that".

### Folder scope — RULED, and it is what makes `pre-edit` work

Measured: 73 folders at depth 2 under `src/`. Too many to hand-curate, so scope
is **derived from the path**, never a maintained list.

An entry's scope is a tree-relative folder (`src/sim/water`). Matching is by
**path prefix**, verified 2026-08-01: an edit to `src/sim/water/flow.ts` and to
`src/sim/water/sources/spring.ts` both match a `src/sim/water` entry;
`src/sim/traffic/engine.ts` does not. Candidate scopes for a path are its own
prefixes — bounded by depth, so it is ~4 indexed equality lookups per edit, not
a `LIKE` scan. `pre-edit` already computes the tree-relative path.

An empty scope means repo-wide, and those show only on demand — a repo-wide
entry that fires on every edit is how this becomes noise.

### Commands

```sh
cli.ts note "<title>" [--body "<detail>"] --topic water [--tags perf,flaky]
                      [--kind warning] [--scope src/sim/water]
cli.ts recall <query> [--topic t] [--tag x] [--kind k] [--scope p] [--mine]
                      [--all]          # include deprecated
                                       # lists TITLES; bodies are opened by id
cli.ts note <id>                       # one entry in full, body included
cli.ts topics [--stale]                # what exists, counts, last write
cli.ts topic <name> [--limit n]        # titles under one topic
cli.ts tags                            # tag cloud with counts
cli.ts note-deprecate <id> "<why>"     # it stopped being true
cli.ts note-supersede <id> <newId>     # this one replaces it
cli.ts topic merge <from> <into>       # fold a duplicate
cli.ts diary check                     # dangling refs, orphan topics, typos
```

`recall` returning titles and `note <id>` opening one is the whole reason the
split exists: a search that dumped ten bodies would cost more context than the
question was worth, which is how a knowledge base stops being consulted.

FTS5 is available in `bun:sqlite` — verified 2026-08-01, `CREATE VIRTUAL TABLE
… USING fts5` with `ORDER BY rank` works. Search is a query, not a grep across
137 files, and the ranking comes free.

### Topics and tags both need merging, from day one

`water`, `water-sim` and `hydrology` will all appear within a week; so will
`perf` and `performance`. Without merging, search fragments and the feature
quietly stops working. Retrofitting a merge after 40 near-duplicates is a data
migration nobody will do. Both normalise like a name — lowercase, one word,
hyphens — reusing the rule that already exists.

### Surfacing — the part that decides whether this is used

A diary nobody reads is a diary nobody writes.

1. **`pre-edit`, one line.** It already fires on every Edit/Write and already
   has the path. *"3 diary entries touch `src/sim/water/` — `cli.ts topic
   water`"*, plus the body of any `warning` or `error` whose scope matches,
   because those are the ones worth interrupting for. Bounded: at most N lines,
   newest first, deprecated excluded.
2. **Session start**, counts and topics only — never bodies. That context is
   already long and every agent pays for it every session.
3. **Never auto-inject entry bodies at scale.** A pointer costs one line; a body
   costs hundreds, paid by everyone. The one exception is the matched
   warning/error above, which is small and certainly relevant.

### Integrity, shipped with the feature

4 dangling links out of 99 today because nothing checks. `diary check` reports
unresolved references, topics with one entry (usually a typo of a real one), and
topics with none. ~20 lines, and it ships in the same commit as the writes, not
after.

---

## Part 2 — The personal diary

### What it is — RULED

Per-agent, per-operator, keyed on the stable session id: **what this agent likes
to remember about the user**, in the shape Claude's own memory works. Not facts
about the repo — facts about the person, and about working with them.

That identity now exists: the session id is the conversation uuid, survives
restarts, and the given name survives with it (fixed 2026-08-01, `90d06cc`).

**In:** preferences, working style, standing corrections, the things that make
this operator different from a generic one. *"Hands rendering changes back to
check visually rather than screenshotting"*. *"Wants the numbers in the commit
message"*. *"Corrected me for auto-renaming instead of refusing with a reason"*.

**Not in:** anything true about the code. That is shared, and putting it here
hides it from everyone. The test: **would another agent be wrong to act on
this?** Yes → personal. No → shared.

### Character survives — RULED

**"Yes, that's the whole idea of personal memory."** So it persists across
restarts and across `--continue`, keyed on the conversation uuid, exactly as the
name now does.

Two things that follow and are worth stating:

- **It is scoped to the agent, not the repo.** Hopper's read of the operator
  differs from Luna's, deliberately — that is the feature. So the personal
  store is keyed by session id and NOT shared between agents.
- **A wrong belief needs an exit.** Since these persist and are injected every
  session, an entry that was a misread compounds. `forget` has to be as easy to
  reach as `remember`, and the operator has to be able to see what an agent
  believes about them — `cli.ts about-me [--agent <who>]`. A private model of a
  person that the person cannot read is the one shape of this feature that
  should not ship.

### Commands

```sh
cli.ts remember "<thing about the operator>" [--body "<detail>"]
                      [--tags style,commits] [--global]
cli.ts about-me [--agent <who>] [--all-projects]
cli.ts forget <id>                     # it was wrong, or no longer true
```

Same title/body split as the shared diary, for the same reason — session start
injects TITLES, and a body is opened only if the agent wants it.

`--global` marks the entries that travel between repos. Default is
project-scoped, because most of what an agent learns is about working on THIS
thing, and a preference carried into the wrong repo is acted on confidently and
wrongly. `about-me` shows this project plus globals; `--all-projects` shows
everything, which is how the operator audits it.

Injected at session start for that agent only. This is the one place automatic
injection is clearly right: small, certainly relevant, and the whole difference
between an agent that remembers how you work and one that does not.

---

## Documentation — RULED

**Markdown ONLY for actual documentation, and as little of it as possible.**

One human-facing document in `.claude/hooks/presence/`, written for a person
deciding whether to use this and how — folded into the existing `README.md`
rather than a new file, since a second doc is a second thing to keep true.
Everything else is the db.

Two things this rules OUT that earlier drafts had:

- **`diary export` is dropped.** It was justified as "findings should be
  greppable and in git"; the operator ruled markdown is not a requirement, so
  exporting 137-entries-worth of db into files nobody asked for is a second copy
  that immediately disagrees with the first. If a human wants to read the diary
  they run `cli.ts topic <name>`, which is one command and always current.
- **No per-topic markdown files.** The topic IS the query. A folder of topic
  files is the taxonomy-as-folders design this plan already rejected, arriving
  by the back door.

This document itself (`DIARY_PLAN.md`) is a plan and is fine as markdown; it
describes work, not a system. Once the work lands, the README section is the
thing that has to stay true, and this file becomes history.

---

## What could go wrong

- **Two systems, one job.** Diary and `memory/` both live. Proposed line: the
  diary owns **repo-scoped findings** (it is the one that works in worktrees);
  `memory/` keeps **cross-project** things and anything the operator's own
  memory instructions cover. Worth restating in the docs, because agents will
  otherwise guess per session.
- **Write-only.** Every knowledge base dies this way. `pre-edit` surfacing is
  the mitigation and the measurement — if entries never come back to anyone, the
  feature failed regardless of how many were written.
- **A diary of narration.** `did` notes went this way until the standard was
  written down. Help text carries it or the entries will not.
- **Personal memory drifting from reality.** Bounded by `about-me` being
  readable by the operator and `forget` being easy.
- **Cost on every edit.** `pre-edit` is on the hot path for every agent. The
  prefix lookup is indexed and bounded by depth, but it needs measuring like any
  other hot path — before and after, in the commit message.

## Phases

**P0 — shared diary, minimum.** Tables + FTS5, `note`/`recall`/`note <id>`/
`topics`/`topic`/`tags`. Title required, body optional, both capped.
Attribution and retention on existing conventions. No injection anywhere —
prove entries get written and are findable before spending anyone's context.

**P1 — surfacing.** `pre-edit` pointer + matched warnings, session-start counts.
Where the feature starts paying or is shown not to. Benched: `pre-edit` is on
every agent's hot path, so the prefix lookup gets before/after numbers in the
commit message like any other hot path.

**P2 — freshness.** Deprecate, supersede, `diary check`, topic/tag merge.

**P3 — personal diary.** New `personal.db` outside the per-project files,
`project` column + `--global`, `remember`/`about-me`/`forget`, session-start
block. The one piece of genuinely new plumbing, which is why it is last.

**P4 — the README section.** One human-facing doc, no export, no per-topic
files.
