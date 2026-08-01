# Lineage: knowledge that outlives the conversation that learned it

*Created: 2026-08-01*

An agent is a conversation uuid. Delete the transcript and the agent is gone —
not degraded, gone. That is fine and the tool should not fight it. What must
**not** die with it is the accumulated knowledge of a piece of ground: the roads
agent's hard-won facts about `src/gen/roads/`, the water agent's decisions, the
gotchas that cost someone an hour.

Today they do die, and this plan is about why.

Status legend: **[ ]** not started · **[~]** partial · **[x]** shipped and
verified against the code, not against this document.

---

## The bug

`memories` is keyed `(session_id, id)` and `recall` filters on `session_id`.
**A new conversation sees an empty store.** The `agent` column is frozen text
that nothing queries.

So the scenario the user named:

> I might start a new session with roadworks, and if I forget a roadwork agent
> already exists, it might create a completely new empty state that has to learn
> everything from scratch.

…is not a risk. It is the current behaviour, every time.

`personal.db` was built as a message in a bottle for a successor. It was asked
for as a spine. That gap is this plan.

---

## P0 — memories key on a lineage, not a session  **[ ]**

Add `lineage TEXT` — a durable id for a *body of knowledge*, distinct from the
session holding it. `recall` filters `WHERE lineage = ?`.

`session_id` stays on every row, untouched. Storage is append-only and "which
conversation learned this" remains answerable — the same frozen-at-write-time
split the diary and `edits` already use, and for the same reason: resolving
attribution at read time blanks out history the moment a session exits.

A lineage is created the first time an agent takes a role, and adopted by name
thereafter. Default: a session with no declared lineage keeps today's behaviour
(its own uuid as its lineage), so nothing existing changes shape.

- [ ] `lineage` column + index; `recall` filters on it
- [ ] `cli.ts inherit <lineage>` adopts one
- [ ] test: a memory written under uuid A is recalled under uuid B sharing a lineage
- [ ] test: an agent with no lineage sees only its own, exactly as today

---

## P1 — the successor is a disciple, never the master  **[ ]**

**USER RULING 2026-08-01** (diary note #20). A session that loads another
agent's memories displays as:

```
Vega, Hopper's Disciple
```

Never as `hopper`.

**The correctness half.** A successor has the knowledge and not the transcript.
Naming it `hopper` makes `blame`, `--history` and every work row point at a
conversation that did not do the work — the `adela`→`akira` failure from the
other direction, where a name outlives the thing it named. The disciple form
carries both facts: `vega` is the live uuid you can resume, `hopper` is where
the knowledge came from. A disciple is by construction not the master, so the
form cannot assert a continuity it does not have.

**The half that is the point anyway.** The roster is read by a human across
eight windows. `Hopper's Disciple` is more memorable *and* more truthful than
`vega (inherited: hopper)`. Whimsy that carries information is not decoration,
and the tool already has `Keeper of Wet Things` in it. Keep it.

A resume is different and needs no such marking: same uuid, same transcript,
same everything the tool tracks. That is just `hopper`.

- [ ] `lineage_from` on the session; display via `fullName`
- [ ] test: display is `Vega, Hopper's Disciple`, and `blame` still resolves to vega's uuid

---

## P2 — keyword detection, so the forgetting case is caught  **[ ]**

Naming fixes nothing if the new agent never learns a lineage exists. It must be
**told, unprompted**.

The machinery is already here: `diary_fts` with bm25 ranking, `nearTopic`,
topics, scopes, and `edits` knowing who touched what. What is missing is the
trigger.

**Two triggers, both wanted:**

- **Keyword, once per conversation.** The user's or the agent's message mentions
  roads → surface lineages owning that topic, and offer the disciple role. Once
  per conversation, never per turn: a suggestion that repeats is a suggestion
  that gets skipped, and then the one that mattered is skipped too (the stale
  nudge learned this already).
- **Detected by edit.** The first edits land in `src/gen/roads/` → a lineage
  owning that scope surfaces the way diary findings already do at edit time.

The edit trigger is the one that catches *forgetting*, which is the case the
user actually named. The keyword trigger catches it earlier, before work starts.

```
A lineage already knows this ground: akira (roads, junctions-roads) —
47 memories, last active 13m ago. `cli.ts inherit akira` to take it up
as Akira's Disciple.
```

- [ ] topic/scope → lineage index
- [ ] keyword trigger at prompt-submit, once per conversation
- [ ] scope trigger at pre-edit, alongside diary findings
- [ ] test: fires once, not per turn

---

## P3 — a live lineage cannot be inherited  **[ ]**

Adoption while the original is **live** is a fork, not a succession. Two sessions
writing one lineage makes the memory a composite of two agents' beliefs with no
way to tell them apart.

So a live lineage can only be **shadowed**: `vega, studying under akira` — reads,
does not write. Writes stay single-owner. When akira goes, vega can inherit
properly.

- [ ] `inherit` refuses a live lineage, offers shadowing
- [ ] test: shadowed reads work, shadowed writes are rejected

---

## P4 — handoff  **[ ]**

Once a dormant item names its uuid and carries its plan, steps, findings and
lineage, `handoff <item>` is **rendering**, not new state — no acceptance, no
scheduler, no assignment.

It is a will, not a job ticket: the thing that extracts what is worth keeping
before the pointer dangles.

**A dormant item should report whether its transcript still exists.** The
`sessions` table stores the path; `Bun.file(transcript).exists()` is the whole
check. "Resumable" vs "author gone, record remains" is a real distinction and
cheap to make true — and it is the difference between `--resume` and a handoff.

- [ ] session-end marks open items `dormant` (visible, clearly not being worked)
- [ ] `handoff <item>` renders the brief
- [ ] transcript-exists check on dormant items

---

## The thing that makes this safe

**Memory that survives uuid changes needs a `forget` that works**, or a wrong
belief becomes immortal — inherited, re-inherited, and never re-examined.
`forget` currently DELETEs, which is right, and is asymmetric to the diary's
`deprecate` on purpose: a finding is history worth keeping, a wrong personal
belief is not.

Anything inherited is also, by construction, **unverified by its inheritor**.
The disciple display is what keeps that honest at a glance.
