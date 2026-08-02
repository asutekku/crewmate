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

## What the live data said before any of this was built

Measured 2026-08-02, and it moved two decisions:

- **`personal.db` holds ZERO memories.** Four agents have written 32 shared diary
  entries and nobody has written a single personal one. So there is no migration
  to design, and — more importantly — the bug is not merely that memories die
  with a session; it is that **the feature is unreachable enough that nobody has
  used it once.** A lineage over an empty store inherits nothing.
- **Knowledge clusters by agent exactly as the plan assumed.** `ambrose` → water
  (3 of 3 `src/sim/water` entries), `alder` → ui (all 3), `akira` → net/roads,
  `hopper` → tooling (18 of 25). Every scope with more than one entry has a
  single author. The premise holds; only the key was wrong.
- **`aliases` already IS the durable table.** It survives `pruneStale` (which
  drops `sessions` rows at 90 min), it is `INSERT OR REPLACE` per uuid, and it
  holds four names against uuids whose sessions are long gone. A name is
  reserved for 60 h against four sources.

So the lineage key is a **name**, not a new synthetic id — `aliases` maps
uuid→name durably, and a name is what the operator types and remembers.

---

## P0 — memories key on a lineage, not a session  **[x]**

*Shipped 2026-08-02. Verified by driving a full succession end to end against an
isolated db, not against this document.*

Add `lineage TEXT` — a durable id for a *body of knowledge*, distinct from the
session holding it. `recall` filters `WHERE lineage = ?`.

**The key is a NAME, which is the one thing this plan got wrong.** It proposed a
new synthetic id; `aliases` already maps uuid→name durably, survives
`pruneStale`, and holds a name for 60 h against four sources. A second
identifier beside it would have been a column to keep in sync with the one that
already works. `lineageKey` falls back to `session:<uuid>` for an unnamed agent,
so an anonymous session stays private to itself rather than pooling every
nameless agent into one shared identity.

`session_id` stays on every row, untouched. Storage is append-only and "which
conversation learned this" remains answerable — the same frozen-at-write-time
split the diary and `edits` already use, and for the same reason: resolving
attribution at read time blanks out history the moment a session exits.

A lineage is created the first time an agent takes a role, and adopted by name
thereafter. Default: a session with no declared lineage keeps today's behaviour
(its own uuid as its lineage), so nothing existing changes shape.

- [x] `lineage` column + index; `forLineage` replaces `forSession`
- [x] `cli.ts inherit <lineage>` adopts one; bare `inherit` lists what is available
- [x] test: a memory written under uuid A is recalled under uuid B sharing a lineage
- [x] test: an agent with no lineage sees only its own, exactly as today

**One behaviour this created, stated rather than hidden: renaming yourself
splits your lineage.** A lineage is a name, so `call-me` starts a new body of
knowledge. The alternative — following renames through an alias chain — would
also merge two genuinely different agents that happened to reuse a name, and
names are only held for 60 h. The old lineage stays readable and inheritable
under its old name, which is what `inherit` is for. The test that previously
asserted the opposite ("a renamed agent is listed ONCE") was rewritten to pin
the real behaviour, not deleted.

`PersonalStore.agents()` was deleted in the same change — `lineages()` replaced
its only caller, and a grouping by session is exactly the wrong grain now.

---

## P1 — the successor is a disciple, never the master  **[x]**

*Shipped 2026-08-02 as `discipleName` in `core/names.ts`, beside `minionName`
which had already solved the possessive (`Iris'`, not `Iris's`).*

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

- [x] `lineage_from` on the session; display via `lineageName`
- [x] test: display is `Vega, Hopper's Disciple`, and `displayName` still returns bare `vega`

**Not `fullName`, which already exists** and means name+role (`Luna — Tooling
Master`). The new one is name+lineage, a different concern, so it is
`lineageName` over `discipleName`. The typecheck caught the collision.

**The split from `displayName` is the load-bearing part.** That function is what
a peer TYPES at `msg` and must stay one unquoted word; had the disciple form
leaked into it, every message to a successor would have failed. Pinned by a test
asserting `displayName` contains no space while `lineageName` reads in full.

---

## P2 — detection, so the forgetting case is caught  **[~]**

*The scope trigger shipped 2026-08-02. The keyword trigger is NOT built — see
the bottom of this section for why it was dropped rather than deferred.*

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

- [x] topic/scope → lineage index — **the shared diary already is one**
- [ ] keyword trigger at prompt-submit, once per conversation — **DROPPED**
- [x] scope trigger at pre-edit, alongside diary findings
- [x] test: silent for a live author, for one with no memories, and once a
      lineage is chosen; offers ONE lineage, never a menu

**No new index was needed.** The personal store has no scope column — a memory
is about the *operator*, not a folder — so the trigger keys on the shared
diary's scoped findings instead. Measured 2026-08-02: **all 11 scopes in this
repo have exactly one author**, and 5 of the 7 agents in the edit history are
already gone. The signal was sitting there.

Driven against the live db: editing `src/sim/water/flow.ts` names ambrose,
`src/ui/cards/BuildingCard.tsx` names alder, and `src/net/query/laneStation.ts`
is correctly silent because akira is still live.

**The keyword trigger is dropped, not deferred.** It would read the operator's
prose for topic words and offer a lineage from that. Three reasons it is worse
than the scope trigger it duplicates: it fires before there is any evidence the
agent will touch that ground; "roads" in a sentence is a far weaker signal than
an edit to a scoped folder; and it needs a once-per-conversation flag, which is
a stored bit whose only job is suppressing true advice — the shape this tool has
already shipped once and regretted. If the scope trigger proves too late in
practice, that is the measurement that would justify revisiting it.

---

## P3 — a live lineage cannot be inherited  **[x]**

*Shipped 2026-08-02, and it fired against my own session on the first real run:
`inherit` listed `hopper` as "still held — ask them instead of inheriting",
because hopper is me and I am still here.*

Adoption while the original is **live** is a fork, not a succession. Two sessions
writing one lineage makes the memory a composite of two agents' beliefs with no
way to tell them apart.

- [x] `inherit` refuses a live lineage and says who holds it
- [x] test: a stale holder does NOT block — otherwise nothing could ever be
      inherited; a session that already took a lineage holds it too, so a
      disciple's disciple cannot start a third writer
- [ ] **shadowing** (`vega, studying under akira` — reads, does not write) — NOT
      BUILT

**Shadowing was designed here and not built, deliberately.** The refusal already
tells you who holds the lineage, and the useful move against a *live* agent is
`msg` — asking the agent that still has the context beats reading a snapshot of
what it wrote down. Shadowing would add a second lineage state, a read/write
asymmetry, and a display form (`studying under`), to serve a case the existing
message channel serves better. If someone wants a live agent's memories, the
honest answer is to ask it.

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
