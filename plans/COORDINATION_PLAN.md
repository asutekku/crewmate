# Coordination gaps: discoverability, questions, bug state

*Created: 2026-08-01*

Three gaps found by measuring the tool against itself rather than by
brainstorming features. Each is small, independent, and answers a question an
agent currently cannot ask.

Status legend: **[ ]** not started · **[~]** partial · **[x]** shipped and
verified against the code, not against this document.

---

## P0 — the usage string is 13 of 33 verbs  **[ ]**

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

- [ ] `VERBS` table; `usage()` generated from it, grouped
- [ ] test: every `case` label appears in `VERBS` (fails when they drift)
- [ ] README section per group, matching the same table

---

## P1 — questions  **[ ]**

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

- [ ] `questions` table + `ask`/`answer`/`asks`
- [ ] delivery of open questions at prompt-submit, above the unread early-return
- [ ] expiry against a dead target, with the asker told
- [ ] test that an expired question is reported, not silently dropped

---

## P2 — bug state and `--fixes`  **[ ]**

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

- [ ] `state` column, defaulting to `open` only for `kind='error'`
- [ ] `--fixes <id>` on `note`; `bugs` listing
- [ ] open bugs in scope surface at edit time alongside findings
- [ ] test: a `finding` cannot be given a state

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

P0 is an hour and unblocks nothing — do it first anyway, because every other
feature here is only useful if it can be found. P1 and P2 are independent.

Lineage and handoff live in [LINEAGE_PLAN.md](LINEAGE_PLAN.md).
