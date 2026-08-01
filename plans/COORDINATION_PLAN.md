# Coordination gaps: discoverability, questions, bug state, plan links

*Created: 2026-08-01*

Four gaps found by measuring the tool against itself rather than by
brainstorming features. Each is small, independent, and answers a question an
agent currently cannot ask.

Status legend: **[ ]** not started · **[~]** partial · **[x]** shipped and
verified against the code, not against this document.

---

## P0 — the usage string is 13 of 33 verbs  **[x]**

*Shipped `01c5935`. Verified against `core/verbs.ts` and `test/verbs.test.ts`,
not against this document.*

`cli.ts --help` lists `who / log / msg / say / quit / clear / where / doing /
did / step / add / done / board / mine`. The dispatcher has 33 `case` labels.
Missing entirely: `note`, `recall`, `topics`, `topic`, `tags`, `note-deprecate`,
`note-supersede`, `diary`, `remember`, `about-me`, `forget`, `breaks`, `needs`,
`files`, `blame`, `call-me`, `name`, `call-you`, `role`.

**Why this outranks its size.** The tool is discovered at runtime by agents, not
read as a manual. The only verbs an agent learns are the ones a hook happens to
mention: SessionStart advertises `recall`/`note`/`topic`, CLAUDE.md advertises
the work verbs. `breaks` and `needs` are advertised nowhere and have been used
by nobody but their author since shipping.

**Fixing the literal is not the fix.** It drifted once and will drift again the
next time a verb lands. The fix is a single `VERBS` table of
`{verb, args, blurb, group}` that both `usage()` and the dispatcher read, plus a
test asserting every `case` label in `cli.ts` appears in the table. The test is
the deliverable; the string is a by-product.

Group the output — 33 flat verbs is its own kind of unfindable:
**presence · work · diary · memory · identity**.

Filed as diary note #18.

- [x] `VERBS` table; `usage()` generated from it, grouped
- [x] test: every `case` label appears in `VERBS` (fails when they drift)
- [x] README section per group, matching the same table

**What it cost, and what that taught.** Two layout bugs, both found by looking
at output rather than by a test. A fixed 46-char column read fine at 100 columns
and collapsed at 80; the fix then had its own bug, where `note`'s 62-char spec
padded all 33 verbs to 62 and pushed the worst pair to 126 columns, so the table
never fired even at 120. The column is now a fixed point over the rows that
share it. Both are pinned by tests that were verified to FAIL on the broken form
first.

The README had drifted identically, in the file that explains why drift is bad:
12 of 18 `core/` modules and 12 of 14 hooks listed, and "13 hooks" against 15
registered. Its three new tests assert a minimum file count before checking,
because a glob that resolves to nothing makes the check pass **vacuously**.

---

## P1 — questions  **[x]**

*Shipped in the questions commit. Verified on the live roster.*

`msg` is fire-and-forget. When an agent needs to know whether a peer has
finished with a file, the only move is `msg` and hope; a reply arrives as an
unread line with no link to the question.

```sh
cli.ts ask <name> "<question>"     # opens a question
cli.ts answer <id> "<answer>"      # closes it, delivers to the asker
cli.ts asks                        # what is open ON me
```

**A question is not a message with a flag.** It has state, so it gets its own
table:

```sql
questions(id, asker_session, asker_name, target_session, target_name,
          text, answer, asked_ms, answered_ms, expired_ms)
```

Reusing `messages` would mean either a nullable answer column on every chat line
or a second row that has to find its parent. Both are worse.

**It must expire.** A question against a session that dies is otherwise a row
nobody closes — the exact `asked_turn_ms` failure recorded in note #10, where a
column shipped with no caller and every work item dangled forever. A question
whose target has been gone longer than `STALE_MS` reports back to the asker as
unanswerable. That path needs a test that runs the expiry, not just stores it.

**Never blocking.** A hook that waits for an answer stalls a turn on a peer that
may never reply. Questions surface at `UserPromptSubmit` like every other piece
of peer news.

- [x] `questions` table + `ask`/`answer`/`asks`
- [x] delivery of open questions at prompt-submit, above the unread early-return
- [x] expiry against a dead target, with the asker told
- [x] test that an expired question is reported, not silently dropped

---

## P2 — bug state and `--fixes`  **[x]**

*Shipped as `e9497c2`. Verified by closing all four real open bugs.*

The diary is already a bug list: `kind: error` plus `--scope` is a bug report.
What it lacks is the one field that separates a bug list from a log — **state**.
A finding is true forever; a bug is open until it is closed.

```sh
cli.ts note "…" --fixes 13     # files the fix AND closes #13, linked
cli.ts bugs                    # open errors, scoped like everything else
```

**State applies only to `kind='error'`.** A `finding` is a fact and has no open
state; giving one a state invites an agent to "close" a piece of knowledge.
`--fixes` reuses the `supersede` chain that already exists, so the mechanism is
mostly built.

**Do not auto-close on commit.** Tempting, since the commit hook exists — but
`git commit -q` prints nothing (note #13), so a sha-triggered close would work
sometimes and silently miss the rest. A bug list that closes bugs at random is
worse than one that closes none. Manual `--fixes` is honest.

**The risk to design against:** a bug list nobody closes is worse than no bug
list, and this repo has direct evidence of that failure mode. If open state
exists, something must periodically raise open bugs in scope — the stale-item
nudge is the working precedent.

- [x] `state` column, defaulting to `open` only for `kind='error'`
- [x] `--fixes <id>` on `note`; `bugs` listing
- [x] open bugs in scope surface at edit time alongside findings
- [x] test: a `finding` cannot be given a state

---

## P3 — a work item knows which plan it is executing  **[~]**

*The link and `plans` shipped as `4eb260b`; the `pre-edit` suggestion — the
one that makes links actually happen — as `7d4b526`. Backfill and the git
fallback are DEFERRED by the user (2026-08-01): both are about plans nobody has
linked, and the suggestion addresses that at the point of work instead.*

**The user's complaint is the spec:** *"we have shitton of plan files, but I
have no idea which ones we have acted on, which ones are completed."*

Measured 2026-08-01 — **82 plan documents** under `audit_reports/`,
`docs/plans/` and `plans/`. (A naive `find` says 1306: 25 stale worktrees each
carry a full copy, so any sweep of this repo MUST exclude `.claude/worktrees`
or the number is 16× wrong.) Of the 82, **26 declare a status line and 56
declare nothing**.

### Why the doc cannot answer this, and neither can git

The 26 self-reported statuses are the **weaker** signal. `WORK_RECORDS_PLAN.md`
carried four `[x] IMPLEMENTED` markers for phases nobody had written — which is
why this file's own legend says checkboxes are re-measured against the code.

The obvious fix is to derive state from git: commit count and last-touched date
are free, already true, and no optimistic author can edit them. **That was
tried and it is wrong**, for a reason found in live data rather than reasoned
about:

> An agent writes a plan, then implements it. It never touches the plan file
> again.

At the time of writing, `ambrose` (the water agent) had **4 of 6 steps done and
`16a92ee` shipped**, while the plan file it was executing had **zero git
commits**. A git-derived inventory would have reported that plan as untouched.
The signal is in the wrong place: the *work* moved, the *document* did not.

### What the board already knows

`work_events` currently holds `did` ×86, `started` ×25, `closed` ×22 and
**`landed` ×9 with real shas** — `16a92ee | feat(water): the ground holds water`.
Every ingredient exists. The only missing thing is the join between an item and
the plan it executes.

```sh
cli.ts doing "<subject>" --plan-doc audit_reports/terrain-water/WATER_PLAN.md
cli.ts plans                      # every plan, with who executed it and what shipped
```

`cli.ts plans` derives per plan, storing nothing that can rot:

| Column | Source | Trust |
|---|---|---|
| who executed it | linked work item's agent | fact |
| how far | the item's step ratio | fact |
| what shipped | `landed` shas on that item | **proof** |
| when it stalled | `updated_ms` | fact |
| declared status | parsed from the doc | **a claim, labelled as one** |
| commit history | git, for unlinked plans | fallback |

For ambrose's plan that reads *"4/6, ambrose, 16a92ee, blocked on step 6"* —
none of which is in the file, all of which is already in the db.

### The parts that need care

**Backfill, or it launches empty.** 82 plans exist and none carry a link. A
one-time match of item subjects against plan filenames gets most; anything
ambiguous stays **unlinked rather than guessed**, because a wrong link is worse
than none — it asserts work happened that did not.

**Git stays as the fallback, not the primary.** For plans nobody links,
commit-count-and-last-touched still beats the 56 that declare nothing.

**Shipped vs abandoned is genuinely hard** and should not be faked. Both look
like a doc that stopped moving. A linked item with `landed` shas answers it; an
unlinked plan does not, and `plans` should say "unknown" rather than infer.

**The adoption risk is real and named.** This only works if agents pass the
flag — the same weakness that left `breaks` and `needs` used by nobody but
their author. Two mitigations, both using machinery that already exists:
`pre-edit` can suggest linking when a plan doc is edited, and the stale nudge
can ask "is this executing a plan?" once per item.

- [x] `plan_doc` on `work`; `--plan-doc` on `doing`, and a `link` verb for items already open
- [x] `cli.ts plans` — derived, storing nothing
- [ ] backfill by filename match; ambiguous stays unlinked — DEFERRED (user, 2026-08-01)
- [ ] git fallback for unlinked plans — DEFERRED (user, 2026-08-01)
- [x] `pre-edit` suggests linking when a plan doc is edited
- [x] test: a plan with a linked item and a `landed` sha reports shipped; an unlinked one reports unknown, never abandoned

---

## Deliberately rejected

**Locks / claims.** The tool is advisory by design and that is why agents
tolerate it. A lock that can be ignored is noise; one that cannot will strand a
file when a session crashes — and sessions crash here.

**Cross-repo diary.** `personal.db` is already global. Findings are repo-scoped
on purpose.

**Sprint / assignment.** No agent can accept work and there is no scheduler. It
would be a table nobody writes to.

---

## Order

P0 shipped first because every other feature here is only useful if it can be
found. P1, P2 and P3 are independent of each other; P2 and P3 share the same
shape (link a record to the thing it resolves) and are cheaper together than
apart.

Lineage and handoff live in [LINEAGE_PLAN.md](LINEAGE_PLAN.md).
