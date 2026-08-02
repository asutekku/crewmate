# Court: obligations, message semantics, and a budget for what gets injected

*Created: 2026-08-02*

Agents in this tree already talk. What they cannot do is **hold each other to
anything**: a promise made in a message survives exactly as long as the sentence
that carried it. This plan adds the smallest set of durable objects that fixes
that, plus the constraint that stops them from drowning the session-start block
they will all want to write to.

It comes out of a long design exchange (the source documents are in
[`../ideas/`](../ideas/)) and one audit of the 50 directed messages this repo
has actually produced. **The audit contradicted the prediction made before it**,
which is the main reason to trust it over the reasoning that preceded it.

Status legend: **[ ]** not started · **[~]** partial · **[x]** shipped and
verified against the code, not against this document.

---

## What the messages contain, under rubric v1

Every number below is from `messages` in the live store, 2026-08-02. The source
text, the per-message labels and both reviewers' classifications are preserved
so any aggregate can be traced to the message that produced it.

**These are rubric-v1 observations, not settled facts about the corpus.** The
blind review found v1 systematically inadequate — that is what P1 exists to fix
— so every figure here is provisional and is re-derived in the v2 pass. They are
kept because they are what the design was reasoned from, not because they are
final.

**50 directed messages examined, 5 excluded** (4 attribution self-tests, 1
channel test), **45 analysed.**

| | |
|---|---|
| expect a future action | **30/45 (67%)**, all explicit |
| contain **at least one** named responsible party | **30/45** |
| carry an explicit condition | **15/45 (33%)** |
| carry more than one purpose | **41/45** — *threshold-dependent, see below* |
| warning ∪ correction | **29/45 (64%)** — a UNION; the labels overlap on 2 |

An earlier draft of this table read *"the same 30; no action was ever orphaned"*.
That claim was an artefact of the boolean, and this very document reports the
counter-example: the blind reviewer found a message carrying an owned action
**and** a separate unowned one ("they're real and someone should chase them"),
which scored `true` on the strength of the first. **Action-level orphaning was
not measurable under v1 and is deferred to the v2 pass.**

The prediction recorded before the audit ran was "mostly FYI, no future action
expected." It was wrong: under rubric v1, two thirds of directed traffic expects
an action, and every future-action message contains **at least one** named
responsible party. That is not the same as every action having an owner — which
is exactly the distinction v1 could not see.

### Obligation episodes, not messages

Acceptance belongs to an **episode** — one proposed responsibility, however many
messages it takes to settle. Counting messages gets this wrong in both
directions, so the boundary rule is written down here to make grouping
reproducible: same responsibility, same responsible party, same subject or file
scope, uninterrupted negotiation chain; **a counter stays inside the episode**,
a materially new responsibility starts another.

**8 acceptance-requiring episodes: 4 accepted, 2 countered, 1 declined, 1
unassessable.** Seven of eight resolved explicitly.

The same corpus counted per-message gives 5 of 14 (36%), because an accepted
episode spans 3–6 messages of which only one carries the acceptance. The
episode figure is the behavioural one.

**What this does and does not establish.** It is not an adoption estimate — 8
episodes, found retrospectively in conversations that happened to be visible
enough to group. The supportable claim is narrower and sufficient:

> Real coordination episodes already use explicit negotiation and resolution
> vocabulary in prose. Accept, decline, counter and return are transitions these
> agents perform today, without any structure to record them in.

### Conditions: anchorable ≠ automatically evaluable

15 conditional messages, split by **what the system could actually do** rather
than by whether a condition exists:

| handling | n | example |
|---|---|---|
| automatic | **6** | "the moment it lands on master" — commit reachability |
| resurface on related event | **5** | "if you're back in `waterSim.ts`" — unprovable, but the commitment can resurface when that file is touched |
| manual | **4** | "if any of your numbers are fill-rate" — a judgement |

**13/15 are anchorable** to a real object (4 commit, 3 work item, 3 file
activity, 2 test result, 1 work step). An earlier draft of this plan said "12/15
structurally linkable", which conflated all three rows and implied a rules
engine the evidence does not fund.

### Corrections: half target durable knowledge

14 corrections — 6 finding, 3 work status, 2 message, 2 rendering/transport,
1 decision.

**7 of 14 target durable knowledge.** The rest need edit-or-clarify, not
supersession. And 2 exist *only* because the shell ate backticks in a quoted
message body — a transport bug wearing a correction's clothes, which no
supersession model would help.

Even for the 7: a correction means **contradictory evidence attached to a
claim**. Supersession stays an explicit authoritative action.

### Where obligations were lost

Four future-action messages had no observable resolution. These are better
specification than any percentage, and become the acceptance tests in P2:

| # | what it was | why it was lost |
|---|---|---|
| 36 | "tell me the target folder and I'll put it there" | question never answered; overtaken by later work |
| 97 | "when you merge P3, move them yourself" | conditional handoff; trigger may never have fired |
| 146 | "if you're back in `waterSim.ts`, tell me and I'll stay out" | **condition never surfaced**; a collision check evaporated silently |
| 295 | hands a fix back after three failed attempts | recipient inactive; thread ends |

---

## What the blind review found

The audit had one classifier who also wrote the rubric and formed the
hypothesis. An independent reviewer re-classified a stratified 15-message sample
against the **frozen** rubric, blind to the first labels. Both label sets are
preserved; neither was averaged or overwritten.

| dimension | agreement |
|---|---|
| kinds — exact | **2/15** |
| kinds — Jaccard | **0.60** |
| priority | 11/15 |
| futureAction | 10/15 |
| namedResponsibleParty | 11/15 |
| **outcome** | **7/15** |

Mean kinds per message: **2.6 vs 4.1**. The second reviewer applied more labels
on nearly every message and never fewer — a threshold the rubric never stated,
which is why the multi-purpose figure above is marked threshold-dependent.

**The disagreement was systematic, not case-by-case**, and it produced the
finding this plan's schema is built on:

> A flat bag of message kinds is the wrong abstraction.

Four purposes had no label and were all being squashed into `fyi`, the rubric's
dump bucket — and they are not four more kinds, they are **four different
dimensions**:

- **clearance** ("go ahead on packBand now") is a *disposition*, not a purpose.
  In a shared checkout, unblocking a peer is the most consequential act there
  is, and it had nowhere to live.
- **constraint** ("go ahead, but keep it inside `packBand`") is a *modifier* on
  consent.
- **withdrawal** ("I am stopping rather than trying a fourth fix") is a *state
  transition* about the sender, distinct from a handoff.
- **reported third-party obligation** ("already replied asking it to skip
  `test/water*.ts`") is *provenance*.

Adding all four to `kinds[]` would have repeated the warning-vs-correction
orthogonality error a third time.

Three further holes, each a design input:

- **`namedResponsibleParty` as one boolean hides orphans.** One message carried
  an owned action *and* "they're real and someone should chase them"; it scored
  `true` on the strength of the first and the orphan vanished.
- **Forbearance is a commitment.** "I will NOT move your water files", "I am not
  touching `emit.ts` again". **Ruling: these count** — in a shared tree a promise
  *not* to touch a file is a primary coordination act, and its fulfilment and
  violation are detected differently from an action's.
- **A sender's declared purpose can contradict the text.** One message opens
  "FYI, not a request" and then asks for something. The system must not silently
  override the sender.

---

## Two attribution defects block sender authority

Diary findings 40 and 41 (`cli.ts recall from_name`), both in
`messages.from_name`, found by two different readers:

- row 9 attributes plainly agent-authored text to `human`;
- row 161 attributes one agent's text to a **sibling session name** (`-e2` vs
  `-7f`, same base) — a suffix swap suggesting the handle is resolved per-send
  rather than pinned to session identity.

So neither the stored name nor the signature inside the body is independently
trustworthy. **Identity comes from the runtime session record; a body signature
is content, not authority.** Precedence when repairing:

1. authenticated session id
2. explicit, validated `--from`
3. operator invocation outside a session
4. legacy rows — **marked uncertain, never force-corrected**

Until that lands, nothing in this plan may derive default authority or priority
from historical `from_name`. Sender-population conclusions are deferred with it:
the corpus reads 44 agent / 1 operator, and that one row is the known-bad one.

---

## The constraint everything else spends against

Every feature below wants lines at session start. **The injected block is the
scarcest resource this tool has**, and it is the one thing already known to
change agent behaviour: the identity text shipped 2026-08-01 is why a fresh
session answers "I'm Anton" on turn one where an earlier one hedged with "I'm
Claude Code, and in this session I'm anouk".

Ten features each appending three lines would undo that quietly, and **no test
would catch it**. So the budget is a mechanism, not a review habit.

### Identity is envelope, not candidate

A priority is a comparison, and every comparison has a losing path: a bad
tie-break, an oversized urgent candidate, a budget configured below the header,
an off-by-one in truncation. Identity must not be in the auction at all.

```ts
interface InjectionEnvelope {
  mandatoryHeader: string[];   // identity, role, project. Never eligible for eviction.
  // Conditionally mandatory: added whenever ANY peer-authored text is selected.
  peerFraming: string[];
  candidates: InjectionCandidate[];
  budgetChars: number;
}

// The only budget any candidate ever sees:
Math.max(0, budgetChars - renderedMandatoryHeader.length - renderedPeerFraming.length)
```

**The trust boundary is part of the envelope, not a candidate.** The shipped
session-start text already says peer messages are reference rather than operator
instruction, and that text addressed to another agent is not yours to act on.
That framing is what makes injected peer prose safe to read — so it must be
subtracted from the budget alongside identity, never ranked against the content
whose authority it explains. It is *conditionally* mandatory: no peer content
selected, no framing needed, and the budget keeps the space.

If the configured budget is smaller than the mandatory header, **render the
header in full and record that the budget was exceeded**. A block that silently
truncates identity fails at the one job the injection has.

### Candidates are deduped, fingerprinted and inspectable

```ts
interface InjectionCandidate {
  key: string;
  priority: number;
  text: string;
  actionable: boolean;
  dedupeKey: string;
  stateVersion: string;   // content fingerprint, NOT a timestamp
}
```

`stateVersion` over a timestamp because "don't show this again unless it
changed" is a content question. This tool already has the timestamp version of
that bug: a claim re-announced on every edit put six identical lines in one log
view, and the fix was a time-based mute that still cannot tell a changed claim
from a repeated one.

Allocation order: identity (envelope) → user-directed → obligations needing
action → breaking changes affecting active work → active work and blockers →
peer updates → informational. Everything below the line is **queryable, not
injected**, and the block says how many were omitted.

### Most of this plan does not belong at session start

Peer context, historical decisions, inferred experience, tales and project
status are **on demand or triggered by what the agent is touching**. "Rowan has
extensive context in procedural geometry" is useful when about to edit that
subsystem and noise in every other session.

> Session start restores continuity. It does not preload the database.

---

## The phases

### P0 — Injection envelope, allocator, manifest [ ]

Unblocked; nothing here depends on the taxonomy.

- [ ] `InjectionEnvelope` with the mandatory header outside the budget, and a
      test that fails if identity can be evicted by any candidate arrangement
- [ ] the **peer trust framing** subtracted from the budget too, whenever any
      peer-authored text is selected — with a test that no arrangement of
      candidates can inject peer prose without it
- [ ] one allocator: deterministic order, stable tie-breaks, dedupe before
      budgeting, omission count preserved, no model call on the path
- [ ] suppression by `stateVersion` across lifecycle hooks — an obligation shown
      at session start is not re-injected at the next prompt unless it changed
- [ ] **an oversized candidate degrades, it does not vanish.** Candidates are
      atomic and never cut mid-line; every producer supplies a bounded compact
      rendering; an actionable item too large for the remaining budget leaves a
      pointer rather than silence:

      ```text
      Review request from Rowan omitted for length — run `cli.ts obligation 42`.
      ```

      Otherwise one verbose obligation either monopolises the block or disappears
      from it, and both failures are invisible
- [ ] selected/omitted recorded **per recipient and `stateVersion`**, so what an
      agent was actually shown is reconstructable after the fact
- [ ] `cli.ts injection [--session <name>]` — mandatory / selected / omitted with
      the budget line. Prioritisation *will* be wrong; debugging a rendered
      paragraph after an agent behaves oddly is the hard way
- [ ] install manifest in the installed dir: `installedAt`, `sourceRevision`,
      `schemaVersion`, `featureSetVersion`. The installed copy at
      `~/.claude/agent-presence/bin/` genuinely diverges from source — sessions
      run whatever was installed when they started, so without this "did this
      session ignore the feature or never have it?" is unanswerable

### P1 — Rubric v2 corpus pass [ ]

Blocks P2's schema only. **This is the gate on taxonomy-dependent fields**, not
on P0.

- [ ] rewrite the rubric around orthogonal dimensions (below), then **freeze it**
- [ ] reclassify all 45 messages under v2
- [ ] report **per-dimension support counts** alongside the labels — 45 messages
      from one week against ~12 dimensions means some fields will rest on two or
      three examples, and a field justified by two must not look as well-founded
      as one justified by thirty
- [ ] re-run the **original 15 as a regression set** — v2 was designed around
      their failures, so they check that the known-hard cases now have somewhere
      to live. That is not validation
- [ ] **a fresh 15 drawn from the other 30 as a reviewer holdout**, classified
      blind by a new reviewer. A v2 pass by one classifier re-inherits the
      problem the first blind review exposed, and grading v2 on the examples that
      produced it grades its own homework.

      **This is not a corpus holdout and the plan must not imply it is.** The
      rubric's author has read all 45 messages, so nothing here is unseen data.
      What it tests is narrower and still worth having: *can a fresh reviewer
      apply v2 consistently to examples that did not directly produce its
      known-defect list?*
- [ ] **per-dimension agreement is the primary result; whole-message exact match
      is secondary and deliberately strict.** A richer orthogonal schema can hold
      exact match low while every dimension that matters improves — v1's two
      failure modes (a threshold nobody stated, and outcomes borrowed from the
      previous message) had different causes and would move independently

The corpus is not only design evidence — it becomes regression fixtures, CLI
formatting examples, and evaluation data if intent suggestion is ever automated.
That is why it is worth rerunning rather than patching.

### P2 — Obligations + message semantics + minimal exposure [ ]

One vertical slice. Splitting it fails in both directions: kinds alone label
traffic nobody can act on; obligations alone are a command an agent must
remember unprompted — which is how a feature ends up at one row.

**Do not lock this schema until all of these hold.** P0 is unblocked and does not
wait on any of them:

1. every rubric-v1 aggregate labelled provisional — done, above
2. act-level records rather than a singular message kind — specified below
3. the automatic-creation rule stated once, not twice differently — below
4. branching acceptance tests for 36 and 146 — below
5. conditions and constraints attached to acts, not messages — below
6. obligation history as events, not a mutable state column — below
7. **binding separated from activation** — below
8. **the event union covers activation, release, withdrawal and violation** —
   below
9. **clearance is a real object**, not prose about a disposition with no type —
   below
10. **warning and priority restored as orthogonal data** — `hazard` on the act,
    `priority` on delivery
11. the v2 reviewer holdout passed (P1)
12. `rubric-v2.md` written and frozen before that review runs (P1)

Items 1–10 are settled in this document. **11 and 12 are the gate**, and they
are P1's output — which is why P1 sits between the allocator and this slice
rather than after it.

**The boundary the whole slice rests on:**

> Messages carry prose. **Structured acts** create obligations, corrections,
> clearances and handoffs.

A message is transport. Zero or more acts attach to it, so a plain `msg` stays
unstructured and the system never has to parse a compound sentence to know what
it owes. `ask`, `request`, `promise`, `handoff` and `grant` each mint one act
*and* emit readable prose.

```ts
type SpeechAct =
  | 'inform' | 'question' | 'request' | 'promise'
  | 'proposal' | 'correction' | 'handoff' | 'clearance';

/** Where an act came from. Only the first two may drive authoritative state. */
type ActOrigin = 'explicit_command' | 'sender_declared' | 'inferred' | 'reported';

interface MessageAct {
  id: string;
  sourceMessageId: number;
  type: SpeechAct;
  origin: ActOrigin;

  // ROUTING is not RESPONSIBILITY. "I will tell Rowan when P3 lands" reaches
  // Rowan, but the author is the one who owes the telling.
  authorSessionId: string;          // immutable: who made this act
  recipientSessionIds: string[];    // who the prose is addressed to
  responsibility?: Responsibility;  // who owes the action, if anyone yet

  text: string;
  condition?: ObligationCondition;   // per ACT, not per message
  constraints?: string[];            // per ACT
  hazard?: { summary: string; subjectRef?: ObjectRef };  // semantic, not delivery
}

/** Delivery weight. Orthogonal to `hazard` — an urgent question is not a warning,
 *  and a warning about something months away is not urgent. */
interface MessageDelivery {
  priority: 'normal' | 'important' | 'urgent';
}

/**
 * Clearance is NOT an obligation and does not fit the obligation lifecycle:
 * nobody owes anything, and it ends by revocation rather than fulfilment.
 * It gets its own object with its own `grant -> revoke` life.
 */
interface Clearance {
  scope: ObjectRef[];              // files, paths, subsystems
  grantedBy: string;
  grantedTo: string;
  constraints: string[];           // "stay inside packBand/fillRow"
  releaseBoundary?: ObligationCondition;
}
```

**One act per message is the wrong unit** — an earlier draft of this file had a
singular `declaredKind`, which is the flat-bag error this plan spends a section
arguing against, committed in the schema two pages later. Message 36 carries a
question *and* a self-promise; answering the question does not fulfil the
promise. Message 112 carries a clearance, a scope constraint on that clearance,
and a promise with its own separate landing condition.

That last example is also why conditions and constraints live on the act:

> Go ahead on `packBand`, but stay inside `packBand/fillRow`. I'll ping you when
> my change lands.

The scope constraint governs the clearance; the landing condition governs the
promise. A message-level list loses which belongs to which.

- [ ] acts as their own records; a message may have none, one, or several
- [ ] the **sender's declared act wins**. Parsing may surface *"this appears to
      contain an expected action — record a request?"* and may never manufacture
      one. "FYI, not a request" wins
- [ ] **inferred signals are not acts and are not stored as acts.** A separate,
      weaker record keeps a guess from ever being mistaken for a commitment by a
      later query that forgets to filter on `origin`:

      ```ts
      interface InferredSignal {
        sourceMessageId: number;
        suggestedType: SpeechAct;
        confidence: number;
      }
      ```

      Promotion to a real act requires the sender confirming it
- [ ] **binding is not activation** — two independent folds, not one state
      column. "Do I owe this?" and "is it actionable now?" are different
      questions, and collapsing them is what made an earlier draft say a
      self-promise *opens immediately* while the branching tests had the same
      promise *activate later*:

      ```ts
      type AuthorityState  = 'proposed' | 'binding' | 'declined' | 'cancelled';
      type ActivationState = 'waiting' | 'active' | 'released' | 'satisfied' | 'violated';
      ```

      In test 36 the promise to move the file is **binding the moment it is
      made** and **waiting** until the folder question is answered. In 146 the
      refrain promise is binding immediately and only becomes active if the peer
      confirms they are editing `waterSim.ts`. Both states are real from the
      start; neither implies the other.

- [ ] obligation state is a **fold over events**, not a mutable column — the
      work-records tables already do this and it is the pattern that keeps
      `counter`, `return`, reassignment and inheritance from erasing history:

      ```ts
      type ObligationEvent =
        // authority
        | { type: 'created' }
        | { type: 'accepted' }
        | { type: 'declined'; reason?: string }
        | { type: 'countered'; replacementId: string }
        | { type: 'reassigned'; from: string; to: string }
        | { type: 'returned'; to: string }
        | { type: 'withdrawn'; by: string; reason?: string }
        | { type: 'cancelled'; reason: string }
        // activation
        | { type: 'activated'; triggerRef?: ObjectRef }
        | { type: 'released'; why: string }
        | { type: 'expired'; episodeId: string }
        // outcome
        | { type: 'fulfilled'; evidenceRef?: ObjectRef }
        | { type: 'violated'; evidenceRef?: ObjectRef };
      ```

      **`violated` is load-bearing once `refrain` exists.** A no-touch promise
      whose breach cannot be recorded is a promise the system can express but
      not enforce — and the breach is the entire reason such promises are worth
      making in a shared tree. `withdrawn` is likewise distinct from `cancelled`
      and `returned`: the holder stepping back ("I am stopping rather than trying
      a fourth fix") is a different event from the work being handed on or
      called off, and message 295 is exactly that case.

- [ ] dispositions **typed against their targets** — `grant`/`revoke` apply to a
      clearance, `accept`/`decline`/`counter` to a request or handoff, `return`
      to held responsibility. One untyped union permits nonsense like accepting a
      revocation
- [ ] **automatic creation rule, stated once so it cannot drift:** an explicitly
      structured directed *question* and an explicitly structured *self-promise*
      become **binding** on creation — the first because the recipient is named,
      the second because the maker binds themselves and should not have to accept
      their own promise. *Requests* and *handoffs* start `proposed` and need the
      recipient's act. Binding says nothing about activation: a conditional
      commitment is binding and `waiting` until its trigger fires. **Inferred
      prose never creates authoritative state** — only `explicit_command` and
      `sender_declared` origins may drive a transition
- [ ] `CommitmentMode: 'perform' | 'refrain'` — forbearance is not a negated
      action; fulfilment and violation are detected differently
- [ ] **a refrain commitment requires a release boundary** — a release condition,
      an `untilRef`, or explicit clearance. "I will not touch `emit.ts`" almost
      always means *until you return it or this episode closes*; without a
      terminator it becomes a permanent stale prohibition nobody remembers to
      lift
- [ ] condition as `{ text, anchorRef?, handling }` where handling is
      `automatic | resurface_on_related_event | manual`. The system never
      evaluates natural language; it knows which commitments to surface when the
      anchored object changes
- [ ] responsibility as a discriminated union, so the contradictory state cannot
      be represented: `{ kind: 'assigned'; agentIds: [string, ...string[]] } |
      { kind: 'unassigned' }`. **Start with a single owner** — multiple owners
      raise any-of versus all-of semantics and nothing in the corpus needs shared
      ownership. An unassigned expected action is a **responsibility gap**;
      assignment or acceptance converts it into an obligation
- [ ] correction carries `correctionType` and an optional `contradictsRef`.
      Attaching contradictory evidence only — supersession stays explicit
- [ ] **`reportedThirdPartyAct` is not a boolean.** Provenance needs who
      reportedly acted, what they committed to, where the report came from and
      whether it was confirmed — `{ reportedActorId?, actType, summary,
      sourceRef?, confidence: 'reported' | 'confirmed' }`. A boolean would record
      only that provenance once existed. **Defer it from P2 if that is too much
      for the first slice; do not ship the boolean**
- [ ] minimal exposure record written when obligations are first surfaced:
      `sessionId · featureKey · surface · exposedAt · installedRevision`

Acceptance tests, from the four lost obligations. Two of them **branch**, and
the branches have different consequences — which is the clearest evidence that
one message can produce *linked* obligations rather than one status:

- [ ] **#36** — two linked obligations from one message. The question is
      `binding` + `active` on arrival; the sender's promise to move the file is
      `binding` + **`waiting`** from the same instant. Answering the question
      satisfies the first and emits `activated` on the second, which stays
      `active` until the move. **A test that only checks the question passes on
      half the message**
- [ ] **#97** — condition and anchor preserved; outcome may stay honestly
      unassessable and is **never** falsely marked fulfilled
- [ ] **#146** — recipient and file anchor retained; activity in `waterSim.ts`
      produces a delivery. The refrain commitment is `binding` + `waiting`
      throughout. Then it branches: *"stale claim"* satisfies the question and
      emits `released` on the commitment; *"yes, I'm in there"* satisfies the
      question and emits `activated`, holding until cleared. **Same two events,
      opposite branches — the test must exercise both**
- [ ] **#295** — stays visible despite an inactive recipient; reassignable,
      cancellable, inheritable. `withdrawn` is recorded as itself, not folded
      into `cancelled` or `returned`. **Inactivity never implies completion**

### P3 — Full exposure ledger + denominator-aware stats [ ]

- [ ] availability / exposure / use kept **separate**. A session can run a build
      containing a feature and never see it mentioned
- [ ] `surface` distinguishes an actionable delivery from a line in `cli.ts help`
- [ ] session-level denominators derived from raw events — twenty session-start
      reminders are not twenty adoption opportunities
- [ ] `stats` reports observations and denominators as **fields**, so the caveat
      travels with the number instead of being a formatter line someone drops
      when quoting it

### P4 — Decisions [ ]

- [ ] `chosen · rationale · revisitWhen`, plus optional alternatives and
      concerns, plus source refs. A single agent choosing between two approaches
      still has an alternative, and *"we rejected X because Y"* is what a later
      agent needs
- [ ] a finding records what is true; a decision records what was chosen; an
      obligation records what someone agreed to do. Three different objects

### P5 — Tales, domain experience [ ]

- [ ] tales as a curated diary kind, linking existing findings rather than
      duplicating them. Threshold: *would a later agent misunderstand the project
      seeing only the final finding and not how the team got there?*
- [ ] **domain experience, not expertise.** An edit log proves exposure and
      context, not skill — this tool's own busiest agent is partly busy from
      getting it wrong repeatedly. Output is evidence plus interpretation
      (*"383 edits, 21 retained findings, last active 2h ago → extensive current
      context"*), never a score

---

## Deferred, with reasons

Not "later" as a way of saying no — each names what would change the answer.

| | why | what would change it |
|---|---|---|
| **reactive routing** | needs canonical events + durable per-recipient deliveries. Real, but it needs P2's objects to route | P2 lands and deliveries have something to carry |
| **peer context / collaboration notes** | mostly a *query* over findings already stored, plus a sparse written note. Cheap, but session start is the wrong place for it | P0's on-demand path exists |
| **relationship / trust scores** | needs repeat encounters between the same two names. **The evidence I had for this was weak in two different ways** — a concurrency figure that measured an operator's usage budget, and a 52-vs-8 name-churn ratio that `stats` later showed to be 23-vs-8 off a cumulative column | lineage holds names steady across sessions, and repeat pairs actually appear |
| **councils** | modal co-presence in the observed sample is 2 | more co-present agents, measured — not assumed |
| **personality / temperament inference** | edit counts support "has context here", never "is cautious" | nothing foreseeable |
| **ceremonies, guildhall, project weather** | derived views over objects that do not exist yet | P2–P4 |
| **anything that claims to wake an idle session** | **a hook cannot start a turn in a session sitting at a prompt.** The honest promise is *earliest available delivery*, never *immediate* | a harness change, not a tool change |

---

## Notes for whoever picks this up

**The activity numbers here are one operator's week**, spent mostly on this tool,
during a period of rationed usage. `cli.ts stats` prints its sample window above
its tables for exactly this reason. Two conclusions in the design conversation
were built on numbers that measured the *sample* and got quoted as properties of
the *system*; both are corrected above. Do not re-quote the counts as ceilings.

**The audit's three layers are preserved** — source text verbatim, per-message
labels with confidence and reason, aggregates derived from them. Any figure in
this plan traces to a message id. Disagree with an aggregate and you can find
the message that produced it.

**Nothing here has been built.** Every box is `[ ]`, and this file has no
authority to say otherwise: the plan next to it carried four `[x] IMPLEMENTED`
markers for code that was never written.
