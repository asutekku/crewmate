# Affinity: do some agents work well together?

*Created: 2026-08-01*

**Status: NOT RECOMMENDED YET, and this document is mostly the measurement that
says why.** Written up rather than dropped because the idea is good and the
blocker is data volume, which changes on its own over time.

---

## The idea

Agents that have collaborated productively — worked adjacent files without
stepping on each other, answered each other's questions usefully — get surfaced
to each other, or to the operator when deciding who to spawn.

## What the data says

Measured 2026-08-01 against the live Traffic db:

| Signal | Count |
|---|---|
| messages, total | 335 |
| directed messages (`to_session != ''`) | 60 |
| distinct agents in `edits` | 4 |
| files touched by more than one agent | **4** |
| work items, total | 21 |

**Four co-edited files across the tool's entire history.** Any affinity score
computed from this is noise dressed as insight — with 4 agents there are 6
possible pairs, and a handful of shared files distributes across them at random.
A recommendation drawn from that would be confidently wrong, which is the most
expensive kind of wrong for a tool whose value is that its record is checkable.

## The deeper problem: no outcome is recorded

Even at ten times the volume, the schema cannot currently answer the question.

- `edits` records *that* two agents touched a file — never whether the second
  had to undo the first.
- `messages` records *that* one agent messaged another — never whether the reply
  helped. `kind` covers `breaks`/`needs`/`done`, not usefulness.
- `work` records `outcome` only as done/abandoned, and only about one agent.

So "worked well together" has **no column to be true in**. Affinity built on
co-occurrence alone would measure *proximity*, and proximity is what the overlap
warning already surfaces — as a hazard, not a virtue. Two agents in one file is
currently evidence of collision risk; scoring it as affinity would invert the
meaning of the same row.

## What would have to exist first

1. **An outcome on an interaction.** The `questions` table in
   [COORDINATION_PLAN.md](COORDINATION_PLAN.md) is the natural home: a question
   that got answered, and whether the asker found it useful, is a real signal
   with a real column. That is one honest bit per interaction, and it accrues
   without anyone being asked to rate a colleague.
2. **Volume.** Tens of agents over months, not four over two days.
3. **A reason to act on it.** Nothing in the tool spawns agents — the operator
   does. Until affinity can change a decision something actually makes, it is a
   statistic with no consumer.

## What is worth doing now instead

The useful half of "who works well together" is available today without any
scoring:

- **`cli.ts blame <path>`** already answers "who has been in this file" —
  including after their session ended, which is when it is asked.
- **Lineages** ([LINEAGE_PLAN.md](LINEAGE_PLAN.md)) answer the question the
  operator actually has, which is not *"who pairs well with vega"* but *"does
  anyone already know this ground"*.

Those cover the real need. Affinity is the interesting version of the question,
not the useful one — yet.

## Revisit when

The `questions` table has shipped and accumulated a few hundred answered
questions across a dozen-plus agents. At that point the signal is an outcome
rather than a co-occurrence, and this becomes worth a second look.

Until then, filing this as a good idea measured and deferred — not rejected.
