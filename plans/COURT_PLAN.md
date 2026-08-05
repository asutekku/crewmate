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
  // NOT a hard output ceiling: the mandatory header may exceed it (and says so),
  // and the aggregate fallback sits outside it. It is the figure candidates are
  // allocated against, so it is named for that rather than for a total nothing
  // actually enforces.
  targetChars: number;
}

// The only budget any candidate ever sees:
Math.max(0, targetChars - renderedMandatoryHeader.length - renderedPeerFraming.length)
```

`cli.ts injection` reports the two separately, so an overflow is visible rather
than implied:

```text
target: 700   rendered: 742   mandatory overflow: 42
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
  origin: 'operator' | 'peer' | 'system';
  requiresPeerFraming: boolean;   // the allocator cannot infer this from text
}
```

**Peer framing creates a circularity, so the order is specified rather than
discovered:** the budget depends on whether framing is needed, and that depends
on which candidates are selected.

1. reserve the mandatory base header
2. sort and dedupe
3. **the first peer-framed candidate selected consumes its own size *and* the
   framing overhead, atomically** — both fit or neither is selected
4. later peer candidates consume only their own size
5. if that first candidate plus framing cannot fit, fall back to its compact
   actionable form, or omit it

**And one aggregate fallback outside the discretionary budget.** If the envelope
leaves no room even for a pointer, actionable work would vanish silently — so a
single bounded line always survives:

```text
3 actionable items pending — run `cli.ts inbox`.
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

### P0 — Injection envelope, allocator, manifest [x]

Unblocked; nothing here depends on the taxonomy.

Shipped as `50aa1d3`. The boxes below sat unticked while the code was already in
the tree — verified against the source 2026-08-05, not against this document.

- [x] `InjectionEnvelope` with the mandatory header outside the budget, and a
      test that fails if identity can be evicted by any candidate arrangement
- [x] the **peer trust framing** subtracted from the budget too, whenever any
      peer-authored text is selected — with a test that no arrangement of
      candidates can inject peer prose without it
- [x] one allocator: deterministic order, stable tie-breaks, dedupe before
      budgeting, omission count preserved, no model call on the path
- [x] suppression by `stateVersion` across lifecycle hooks — an obligation shown
      at session start is not re-injected at the next prompt unless it changed
- [x] **an oversized candidate degrades, it does not vanish.** Candidates are
      atomic and never cut mid-line; every producer supplies a bounded compact
      rendering; an actionable item too large for the remaining budget leaves a
      pointer rather than silence:

      ```text
      Review request from Rowan omitted for length — run `cli.ts obligation 42`.
      ```

      Otherwise one verbose obligation either monopolises the block or disappears
      from it, and both failures are invisible
- [x] selected/omitted recorded **per recipient and `stateVersion`**, so what an
      agent was actually shown is reconstructable after the fact
- [x] `cli.ts injection [--session <name>]` — mandatory / selected / omitted with
      the budget line. Prioritisation *will* be wrong; debugging a rendered
      paragraph after an agent behaves oddly is the hard way
- [x] install manifest in the installed dir: `installedAt`, `sourceRevision`,
      `schemaVersion`, `featureSetVersion`. The installed copy at
      `~/.claude/agent-presence/bin/` genuinely diverges from source — sessions
      run whatever was installed when they started, so without this "did this
      session ignore the feature or never have it?" is unanswerable

### P1 — Rubric v2 corpus pass [x]

Blocks P2's schema only. **This is the gate on taxonomy-dependent fields**, not
on P0.

#### The v2 observation model

The rubric is an **annotation model, not the P2 storage schema**. It records what
is present in the prose without turning an inference into authority. Its fields
may justify, remove or reshape a P2 type; they do not create an obligation.

Every act carries the shortest decisive source span(s), as half-open UTF-16
offsets into the immutable message body plus the quoted text. Offsets make a
repeated phrase unambiguous; the quote makes an off-by-one reviewable. Two
reviewers can then disagree about a boundary without the scorer guessing which
phrases they meant. The frozen rubric defines these orthogonal dimensions and no
reviewer derives them by reading the P2 implementation sketch:

1. **acts** — zero or more act-level records: `inform · question · request ·
   promise · correction · handoff · grant · proposal`. The rubric states the
   inclusion threshold for a genuine act versus incidental language, and a
   message may contain several acts of the same type
2. **participants and responsibility, per act** — author, recipients, and
   `assigned(actor) | unassigned | none`. This is where a message containing one
   owned action and one orphan preserves both
3. **commitment mode, per promise** — `perform | refrain`; forbearance is in
4. **condition, per act** — absent, or `automatic |
   resurface_on_related_event | manual`, with the anchor and branch text kept.
   The annotation says what handling the prose supports; it does not pretend the
   natural-language condition is executable
5. **constraints, per act or clearance** — attached to the thing they qualify,
   never collected at message level
6. **clearance** — grant/revoke meaning and scope, separate from an obligation
7. **hazard notice** — present/absent with subject and decisive span, independent
   of act type and of priority
8. **correction semantics** — `self_erratum | peer_correction |
   implementation_correction`, plus a target when the text supplies one;
   contradictory evidence does not imply supersession
9. **provenance** — direct, sender-reported third-party act, or inferred signal.
   A report names the reported actor/act when present and never becomes a direct
   act merely because the reviewer believes it
10. **sender declaration, per act** — e.g. "FYI, not a request". It governs only
    the act it qualifies; conflicting content is preserved as a conflict rather
    than silently overruling the sender
11. **response linkage** — `respondsToMessageId?` and response disposition
    (`acknowledge | accept | decline | counter | answer | return | none`), kept
    separate from `outcomeOfThisMessage` (`fulfilled | violated | unresolved |
    unassessable`). Reviewers may use the preserved corpus sequence to establish
    an explicit linkage, but may not borrow the previous message's outcome as
    this one's
12. **priority, per recipient** — `normal | important | urgent`, judged by the
    consequence of ignoring the delivery rather than typography
13. **object anchors** — file, commit, work item, test, message or other explicit
    object refs, attached to the relevant act/hazard/condition
14. **confidence and ambiguity, per annotated record** — `high | medium | low`
    plus a note. Missing, `none`, `unknown` and `not_applicable` are defined
    separately; they are never interchangeable empty values

Conditional offers get an explicit decomposition rule with worked examples.
Sender labels versus content, branched obligations, same-message owned and
orphaned actions, and the difference between no observed response and an
unassessable outcome each get a positive and a negative example. Those are v1's
known failure boundaries, not optional commentary.

#### Freeze and artifacts

- [x] write `rubric-v2.md`, including the field schema, allowed values,
      applicability rules, act threshold, conditional-offer rule, source-span
      rule and worked boundary examples
- [x] freeze it **before any v2 classification**. Record `frozenAt`, a SHA-256
      hash, corpus hashes, excluded ids and rubric version in
      `audit-v2-manifest.json`. Any semantic rubric edit after classification
      begins invalidates the pass and requires both reviewers to rerun; typo-only
      edits are logged without replacing the frozen file
- [x] add, never overwrite, these artifacts beside v1:
      `audit-v2-primary.json`, `audit-v2-regression.json`,
      `audit-v2-holdout-review.json`, `audit-v2-agreement.json` and
      `audit-v2-report.md`. Raw reviewer labels remain immutable; adjudication,
      if useful, is a separate file and never the input to agreement figures
- [x] reclassify all 45 messages under v2. Preserve the five exclusions in the
      manifest, and preserve known transport and attribution defects as source
      caveats rather than repairing the source text by intuition
- [x] report **per-dimension positive support, applicable denominator and missing
      count** alongside every aggregate. With 45 messages against fourteen
      dimensions, a field supported by two examples must not look as founded as
      one supported by thirty. Fewer than five positive examples is explicitly
      `provisional`, however good its agreement looks

#### Regression and fresh-review holdout

- [x] report the **original 15 ids** as a regression slice of the primary pass.
      It passes only when every defect recorded in the v1 blind review is
      representable in its intended dimension without an `inform`/`fyi` dump
      label, a message-level owner boolean, or a free-text workaround. This is a
      known-hard regression set, not validation and not a prevalence sample
- [x] before the new reviewer starts, draw **15 ids from the other 30** with a
      recorded deterministic seed and algorithm; store the ordered population,
      selected ids and seed in the manifest. Do not redraw for better coverage
      or better scores
- [x] a fresh reviewer classifies those 15 blind to the primary v2 labels, v1
      labels, prior blind-review notes, aggregates and P2 schema. They receive
      only the frozen rubric, the **full verbatim source corpus** in order, the
      15 ids they must label, and the source caveats. The surrounding rows are
      necessary to score response linkage and later outcome; they are context,
      not additional review items. Preserve the reviewer's output exactly as
      returned

This is a **reviewer holdout, not a corpus holdout**. The rubric's author has read
all 45 messages, so no example is unseen data. It tests the narrower claim that a
fresh reader can apply v2 consistently to messages that did not directly produce
the known-defect list.

#### Scoring and the gate into P2

Act agreement has to be defined before it can be measured. Two acts align when
their decisive source spans overlap; alignment maximises total span overlap
one-to-one without considering the proposed type. Unmatched acts count as
boundary disagreement. Type agreement is scored only after alignment, so a type
error cannot be hidden by refusing to pair the records. Non-act records align by
their declared subject span and dimension. The scorer and its tests live beside
the artifacts; hand arithmetic is not the authority.

- [x] for every single-valued applicable dimension report the confusion matrix,
      raw agreement and Cohen's kappa; when kappa is undefined because one class
      has no variance, say so rather than coercing it to 0 or 1
- [x] for act boundaries/types and other multi-valued dimensions report
      precision, recall and F1 in both reviewer directions, plus exact
      whole-message match as a deliberately strict secondary figure
- [x] **P1 passes** only when all of the following hold:
      1. every dimension reports support and applicability denominators;
      2. dimensions with at least five applicable holdout examples reach
         **≥80% raw agreement and κ ≥0.60** (or ≥80% with kappa explicitly
         undefined for a no-variance dimension);
      3. act boundary/type micro-F1 is **≥0.80**;
      4. no structural dimension — responsibility, condition attachment,
         clearance, sender declaration or response linkage — has a repeated
         directional disagreement on three or more holdout messages;
      5. the original-15 regression condition above passes; and
      6. every failed dimension is either revised and the entire frozen review
         rerun, or explicitly deferred from P2. Low-support dimensions are
         marked provisional and may justify only the narrow cases actually
         observed, never an unsupported generalisation. A caveat may narrow the
         schema; it may not wave a failed field through

Whole-message exact match has **no pass threshold**. A richer orthogonal model
can keep it low while each consequential dimension improves; v1's threshold
ambiguity and borrowed outcomes had different causes and must be visible
separately.

The corpus is not only design evidence — it becomes regression fixtures, CLI
formatting examples, and evaluation data if intent suggestion is ever automated.
That is why it is worth rerunning rather than patching.

### P2 — Obligations + explicit message semantics [x]

One vertical slice. Structured acts create durable state, the obligation fold
makes that state actionable, and P0's existing allocator and append-only
`injection_ledger` deliver it. P2 does **not** build another exposure path.

#### Revision after the P0 implementation and P1 gate

This section is authoritative where older P2 text below used broader draft
types. P1 passed act boundaries/types, priority, responsibility, commitment
mode, condition handling, clearance, hazards, responses and outcomes. It did
not license every field the annotation model could express.

| P2 decision | Evidence and consequence |
|---|---|
| keep the consequential explicit act-record unit, one or many per message | act boundary F1 0.852 and type F1 0.835; `inform`/`proposal` remain prose because P2 gives them no lifecycle |
| keep one responsible principal, separate from routing | responsibility 100%, κ 1.000 |
| keep `perform` / `refrain` | commitment mode 88.9%, κ 0.769 |
| keep typed automatic / related-event / manual conditions | condition handling 95.9%, κ 0.916 |
| keep clearance, hazard, priority, response and outcome as orthogonal records | each passed its applicable gate |
| keep correction only for an explicit structured correction command | only four holdout examples; subtype remains provisional |
| **defer generalized constraints** | only three full-corpus positives; no `constraints[]` column or field in P2 |
| **defer generalized object anchors** | 55.1% raw agreement; no generic `ObjectRef`, `subjectRef`, `anchorRef`, or inferred file/commit link |
| **defer confidence** | annotation-QC metadata, never authoritative presence state |
| **defer provenance and inferred signals** | no `InferredSignal`, `ReportedAct`, reported-act boolean, or promotion workflow in P2 |

The deferrals are schema boundaries, not omitted TODOs. P2 preserves the full
sender-supplied `text` on every act, clearance, hazard, condition and event, so
information is not destroyed while unsupported structure is withheld. A later
phase may add one deferred dimension only with new evidence and a migration.

P2 accepts semantics only through explicit CLI/API variants. Plain `msg`/`say`
remains prose and creates no act, obligation, clearance, correction or hazard.
There is no intent parser, suggestion classifier, or automatic promotion from
historical messages. This makes the P1 sender-declaration conflict safe by
construction: the structured command is the declaration, and unrelated prose
cannot manufacture a second act.

P0 is the only delivery/exposure authority. An actionable obligation becomes an
`InjectionCandidate` with:

- `key`/`dedupeKey = obligation:<obligationId>`;
- `stateVersion = sha256(canonical folded snapshot)`, where the canonical input
  includes the event version and contains no timestamp;
- priority maps exactly as `normal = 100`, `important = 105`, `urgent = 110`,
  preserving P0's rule that obligations needing action outrank roster (`90`);
- full and compact renderings generated from the same folded snapshot.

Every selected, suppressed and omitted version is therefore reconstructable in
the existing `injection_ledger`; no P2 `exposure` table or parallel suppression
state is permitted. `cli.ts injection` remains the diagnostic surface.

The first implementation slice is deliberately closed:

1. explicit `ask`, `request`, `promise`, `handoff`, `grant`, `correct`, and
   `hazard` commands create typed records and readable prose in
   one transaction;
2. obligation and clearance events append with optimistic version checking and
   idempotency keys, then fold to current state;
3. the allocator receives active/waiting/relevant obligation candidates and
   records their delivery through P0;
4. no historical backfill and no free-prose classification occur in P2;
5. migrations are additive and old clients keep reading plain messages.

P1's `inform` and `proposal` labels do not become P2 records: information and
optional approaches with no authoritative lifecycle continue through `msg`/`say`.
This avoids typed status channels nobody can act on while preserving the P1 rule
that a message may create zero acts. A proposal becomes structured only when the
sender turns it into a request, promise, handoff or grant.

Candidate production is state-specific; "exists" is not synonymous with
"actionable":

| folded state | recipient | candidate |
|---|---|---|
| proposed request/handoff | proposed responsible actor | actionable: accept, decline or counter |
| binding + active | current responsible actor | actionable: fulfil, relinquish, return, or report violation |
| binding + waiting | current responsible actor | non-actionable compact context only; omitted rows do not enter the inbox |
| unassigned + binding | operator and authorized coordinator sessions | actionable responsibility gap |
| terminal authority/activation state | nobody | no candidate; history remains queryable |

An event that changes any row increments the obligation version, changing
`stateVersion` even when the rendered sentence happens to remain identical.
That is intentional: P0 reconstructs which folded state was delivered, not only
which bytes happened to render.

Convenience CLI commands (`ask`, `request`, `promise`, `handoff`, `grant`,
`correct`, `hazard`) call one typed service. A compound message uses
`act batch --json <file>`; the service validates every act, dependency and
participant first, then writes the message, acts, initial events and dependencies
in one transaction. Partial compound messages are forbidden. Human-readable
prose is rendered from the accepted typed input and stored with it; callers do
not separately supply prose that could contradict the act.

**This schema is now locked to the supported slice above.** P0 and P1 are
complete; the following checklist records the invariants P2 must implement:

1. every rubric-v1 aggregate labelled provisional — done, above
2. act-level records rather than a singular message kind — specified below
3. the automatic-creation rule stated once, not twice differently — below
4. branching acceptance tests for 36 and 146 — below
5. conditions attach to acts; generalized structured constraints are explicitly
   deferred by P1 and remain only in preserved act text
6. obligation history as events, not a mutable state column — below
7. **binding separated from activation** — below
8. **the event union covers activation, release, withdrawal and violation, and
   every event lands in a declared state** — the transition table, below
9. **clearance is a real object with its own event log**, not prose about a
   disposition with no type — below
10. **warning and priority as orthogonal data** — `HazardNotice` as its own
    record, `priority` per recipient on delivery
11. **acts are discriminated variants**, so a correction without its explicit
    provisional subtype or a grant carrying responsibility cannot be built
12. **`ActorRef` everywhere a session string was**, and trustworthy attribution
    for new writes: diary 40 and 41 closed
13. **typed `TriggerSpec` for automatic conditions**, and `ObligationDependency`
    for the linked cases the branching tests describe
14. **`created` seeds both folds** — it declares authority and activation, or the
    fold has no valid starting state
15. **relinquishing does not end the obligation** — `withdrawn` pulls an
    unaccepted proposal, `relinquished` leaves it binding and unowned. Otherwise
    an agent deletes required work by declining to do it
16. **one resolution vocabulary** — `fulfilled` + `resolutionKey`, no `answered`,
    no untyped `onResolution`
17. **active refrain success is `fulfilled`, not `released`** — "it worked" and
    "it stopped mattering" must not collapse into one state
18. **`ActOrigin` has one authoritative value, `structured_command`**; inferred
    and reported records do not exist in the P2 schema
19. **`ResponsibleActorRef` narrows who may own an obligation** to agent or
    operator
20. **an authenticated actor on every event record, and the authorization matrix
    written before the CLI**
21. **`assigned` as its own transition from unowned** — `reassigned` cannot start
    from nowhere
22. **version-checked appends and idempotency keys**, because several agents and
    hooks write one store
23. the v2 reviewer holdout passed (P1)
24. `rubric-v2.md` written and frozen before that review runs (P1)

Items 1–22 are settled subject to the P1 narrowing above. **23 and 24 passed**;
P2 may now implement only the supported slice and must preserve the recorded
deferrals.

**Schema iteration ends here.** Items 14–22 all came from reading the fold on
paper, and the paper has given up what it has: three of the last six were places
the *types* permitted what the *prose* forbade, which is precisely the class a
compiler and a test suite catch for free. Further prose passes are now more
likely to add complexity than remove risk. **The fold and its tests are the
authority from this point** — when they disagree with this document, they are
right and it gets corrected.

**The boundary the whole slice rests on:**

> Messages carry prose. **Structured acts** create obligations, corrections,
> clearances and handoffs.

A message is transport. Zero or more acts attach to it, so a plain `msg` stays
unstructured and the system never has to parse a compound sentence to know what
it owes. `ask`, `request`, `promise`, `handoff` and `grant` each mint one act
*and* emit readable prose.

```ts
/**
 * Never a bare session string. A session id cannot say "the operator", cannot
 * carry a system-generated act, and has nothing to become when the session that
 * made a commitment ends and the obligation is inherited. `legacy_uncertain`
 * exists because two rows in this very store have a wrong `from_name` (diary 40,
 * 41) and force-correcting them would invent history.
 */
type ActorRef =
  | { kind: 'agent'; agentId: string }   // immutable session uuid, NOT the display name
  | { kind: 'operator' }
  | { kind: 'system'; component: string }
  | { kind: 'legacy_uncertain'; label: string };

/**
 * Who can OWE something — a strict subset of who can be referenced.
 *
 * `ActorRef` alone would permit `assigned` to a `system` component or to
 * `legacy_uncertain`, i.e. an obligation owed by "probably Hopper". That
 * contradicts the requirement that new obligations carry trustworthy
 * attribution, so the narrowing is a type rather than a rule in prose.
 * `legacy_uncertain` stays usable for historical AUTHORSHIP, never for
 * ownership.
 */
type ResponsibleActorRef =
  | { kind: 'agent'; agentId: string }
  | { kind: 'operator' };

/** ONE owner. Any-of versus all-of semantics are undesigned and nothing in the
 *  corpus needs them; widen this only when that design exists. */
type Responsibility =
  | { kind: 'assigned'; actor: ResponsibleActorRef }
  | { kind: 'unassigned' };

/**
 * Where an act came from. P2 accepts exactly one authoritative origin.
 *
 * `inferred` and `reported` were members here while the prose said inferred
 * signals are not acts and are not stored as acts. Leaving them in the union
 * meant a query that forgot to filter on origin could read a guess as a
 * commitment; removing them makes that unrepresentable. P1 deferred both, so
 * P2 has no inferred or reported record type at all.
 */
type ActOrigin = 'structured_command';

interface ActBase {
  id: string;
  sourceMessageId: number;
  origin: ActOrigin;
  // ROUTING is not RESPONSIBILITY. "I will tell Rowan when P3 lands" reaches
  // Rowan, but the author is the one who owes the telling.
  author: ActorRef;         // immutable: who made this act
  recipients: ActorRef[];   // who the prose is addressed to
  text: string;
}

// Variants, so the type system enforces what the prose asks for: a correction
// without a subtype and a handoff without a subject are unrepresentable rather
// than merely discouraged. A flat interface with every field optional permits
// `{ type: 'grant', responsibility, condition }`, which means
// nothing.
type MessageAct =
  | (ActBase & { type: 'question';
      responsibility: Extract<Responsibility, { kind: 'assigned' }>;
      condition?: ObligationCondition })
  | (ActBase & { type: 'request';
      proposedResponsibility: Responsibility;
      condition?: ObligationCondition })
  | (ActBase & { type: 'promise';
      responsibility: Extract<Responsibility, { kind: 'assigned' }>;
      mode: 'perform'; condition?: ObligationCondition;
      releaseBoundary?: ObligationCondition })
  | (ActBase & { type: 'promise';
      responsibility: Extract<Responsibility, { kind: 'assigned' }>;
      mode: 'refrain'; condition?: ObligationCondition;
      releaseBoundary: ObligationCondition })
  | (ActBase & { type: 'correction';
      correctionType: CorrectionType; contradictsActId?: string })
  | (ActBase & { type: 'handoff';
      subject: string; proposedRecipient: ResponsibleActorRef })
  | (ActBase & { type: 'grant'; clearanceId: string });

interface ObligationBase {
  id: string;
  sourceActId: string;
  createdBy: ActorRef;
  condition?: ObligationCondition;
  validResolutionKeys: string[];     // declared up front; empty means unbranched
}

type Obligation =
  | (ObligationBase & { kind: 'question' | 'request' | 'handoff' | 'unassigned_work' })
  | (ObligationBase & { kind: 'promise'; mode: 'perform';
      releaseBoundary?: ObligationCondition })
  | (ObligationBase & { kind: 'promise'; mode: 'refrain';
      releaseBoundary: ObligationCondition });

/** Derived by folding events; never persisted as a mutable current-state row. */
interface ObligationSnapshot {
  obligationId: string;
  authority: AuthorityState;
  activation: ActivationState;
  currentResponsible: Responsibility;
  version: number;
}

/**
 * A hazard is its OWN record, not a field on an act.
 *
 * Message 110 carries a request, a promise, and a wake-epsilon warning that
 * belongs to neither — it is about the subsystem. As a field it would have to be
 * duplicated across acts or arbitrarily assigned to one; as a record it is
 * stored once, can span several acts, and a warning-only message needs no
 * invented `inform` act to hold it.
 */
interface HazardNotice {
  id: string;
  sourceMessageId: number;
  relatedActIds: string[];
  summary: string;
  subject: string;
}

/** Delivery weight, per recipient. Orthogonal to a hazard — an urgent question
 *  is not a warning, and a warning about something months away is not urgent. */
interface MessageDelivery {
  sourceMessageId: number;
  recipient: ResponsibleActorRef;
  priority: 'normal' | 'important' | 'urgent';
}

/**
 * Clearance is NOT an obligation: nobody owes anything under it, and it ends by
 * revocation rather than fulfilment. `grant` is the ACT; it creates this object;
 * `revoke` is a later event against it. Without its own event log the
 * `grant -> revoke` life is describable but not auditable.
 */
interface Clearance {
  id: string;
  sourceActId: string;
  scopeText: string;               // preserved sender declaration, not parsed
  grantedBy: ActorRef;
  grantedTo: ResponsibleActorRef;
  releaseBoundary?: ObligationCondition;
}

type ClearanceEvent =
  | { type: 'granted' }
  | { type: 'revoked'; reason?: string }
  | { type: 'expired'; reason: string };

interface ClearanceEventRecord {
  id: string;
  clearanceId: string;
  actor: ActorRef;
  occurredAt: number;
  expectedVersion: number;
  idempotencyKey: string;
  payload: ClearanceEvent;
}
```

Clearance appends use the same transaction/version/idempotency protocol as
obligations. `granted` is written by the structured grant's authenticated
author, `revoked` by that grantor or the operator, and `expired` by an allowlisted
system trigger or the operator. Granting and its initial event are atomic.

**One act per message is the wrong unit** — an earlier draft of this file had a
singular `declaredKind`, which is the flat-bag error this plan spends a section
arguing against, committed in the schema two pages later. Message 36 carries a
question *and* a self-promise; answering the question does not fulfil the
promise. Message 112 carries a clearance, a scope constraint on that clearance,
and a promise with its own separate landing condition.

That last example is why conditions live on the act while the original text is
preserved verbatim:

> Go ahead on `packBand`, but stay inside `packBand/fillRow`. I'll ping you when
> my change lands.

The landing condition governs the promise. P1 did not establish reliable
structured constraint or anchor extraction, so P2 keeps "stay inside
packBand/fillRow" inside the grant's `scopeText`/act text rather than pretending
it has a trustworthy general-purpose constraint object.

- [x] acts as their own records; a message may have none, one, or several
- [x] the **sender's explicit structured command is the declaration.** `msg` and
      `say` never create semantic records, even when their prose looks like a
      request. A compound intent is entered as several explicit acts in one
      transaction, so "not a request, but I promise to ping" can create only the
      promise. P2 contains no parser or suggestion surface
- [x] **inferred signals and reported acts are absent from P2.** P1 explicitly
      deferred provenance and confidence. Plain prose remains only prose; there
      is no weaker record, classifier output, or promotion path that a later
      query could confuse with authority
- [x] **binding is not activation** — two independent folds, not one state
      column. "Do I owe this?" and "is it actionable now?" are different
      questions, and collapsing them is what made an earlier draft say a
      self-promise *opens immediately* while the branching tests had the same
      promise *activate later*:

      ```ts
      type AuthorityState =
        'proposed' | 'binding' | 'declined' | 'countered' | 'withdrawn' | 'cancelled';
      type ActivationState =
        'waiting' | 'active' | 'fulfilled' | 'released' | 'violated' | 'expired';
      ```

      In test 36 the promise to move the file is **binding the moment it is
      made** and **waiting** until the folder question is answered. In 146 the
      refrain promise is binding immediately and only becomes active if the peer
      confirms they are editing `waterSim.ts`. Both states are real from the
      start; neither implies the other.

- [x] obligation state is a **fold over events**, not a mutable column — the
      work-records tables already do this and it is the pattern that keeps
      `counter`, `return`, reassignment and inheritance from erasing history:

      ```ts
      type ObligationEvent =
        // CREATION SEEDS BOTH FOLDS. `{ type: 'created' }` alone cannot say
        // which of four real starting states this is: an unconditional request
        // is proposed+active, a conditional one proposed+waiting, an
        // unconditional self-promise binding+active, a conditional one
        // binding+waiting. The fold would have no valid start.
        | { type: 'created';
            authority: 'proposed' | 'binding';
            activation: 'waiting' | 'active';
            responsible: Responsibility }
        // authority
        | { type: 'accepted' }
        | { type: 'declined'; reason?: string }
        | { type: 'countered'; replacementId: string }
        | { type: 'withdrawn'; reason?: string }   // actor is on the event record
        | { type: 'cancelled'; reason: string }
        // ownership -- moves the owner WITHOUT touching either state
        | { type: 'relinquished'; from: ResponsibleActorRef; reason?: string }
        | { type: 'assigned'; to: ResponsibleActorRef }          // from UNOWNED
        | { type: 'reassigned'; from: ResponsibleActorRef; to: ResponsibleActorRef }
        | { type: 'returned'; from: ResponsibleActorRef; to: ResponsibleActorRef }
        // activation
        | { type: 'activated'; trigger: TriggerSpec }
        | { type: 'released'; why: string }
        | { type: 'expired'; episodeId: string }
        // outcome -- `resolutionKey` names the branch a dependency keys on
        | { type: 'fulfilled'; resolutionKey?: string; evidenceMessageId?: number }
        | { type: 'violated'; evidenceMessageId?: number };
      ```

      **`withdrawn` and `relinquished` are different events and an earlier draft
      had only the first.** Withdrawing pulls an *unaccepted proposal* — the
      requester no longer wants it. Relinquishing is the *current holder
      stopping* while the work stays necessary, which is message 295 exactly:
      "I am stopping rather than trying a fourth fix" did not make the fix
      unnecessary, it made it unowned. Folding the second into the first would
      let an agent **delete required work by declining to do it** — the precise
      inverse of what durable responsibility is for. So `relinquished` leaves
      authority `binding` and activation untouched, and sets
      `currentResponsible` to `unassigned`; a following `returned` or
      `reassigned` names the next owner.

- [x] **the transition table, written before any of it is built.** An earlier
      draft had `satisfied` in the state union and `fulfilled` in the events,
      plus `expired`, `withdrawn` and `countered` as events with no state to land
      in — a fold that cannot be written:

      | event | required prior | result |
      |---|---|---|
      | `created` | — | *as declared on the event* |
      | `accepted` | proposed | binding |
      | `declined` | proposed | declined |
      | `countered` | proposed | countered |
      | `withdrawn` | **proposed** | withdrawn |
      | `cancelled` | proposed \| binding | cancelled |
      | `activated` | binding + waiting | active |
      | `fulfilled` | binding + active | fulfilled |
      | `released` | binding + **waiting** | released |
      | `violated` | binding + active | violated |
      | `expired` | binding + waiting\|active | expired |
      | `relinquished` | binding + assigned | *owner → unassigned* |
      | `assigned` | binding + **unassigned** | *owner set* |
      | `reassigned` | binding + assigned(from) | *owner → to* |
      | `returned` | binding + assigned(from) | *owner → to, "went back"* |

      The last four are the distinction worth keeping explicit: **ownership
      moves without authority or activation moving.** Handing an obligation on
      does not make it less binding or more active.

      **`assigned` exists because `reassigned` cannot start from nowhere.**
      `relinquished` leaves the obligation `unassigned`, and every other
      ownership event requires a `from` — so without this row, message 295's
      obligation becomes permanently unownable the moment its holder steps back,
      which is the same "required work disappears" failure one level down.
      Initial assignment, lateral reassignment and *giving work back* stay three
      distinct events, because the third carries a fact the other two do not.

      **`released` is for a commitment that became moot, never for one that
      succeeded.** An active refrain that reaches its release boundary without a
      breach is `fulfilled` — the agent *did* the staying-out. An earlier draft
      let `released` cover both, which would make "the promise worked" and "the
      promise stopped mattering" indistinguishable in every later count. So:

      - waiting, and the condition stops being relevant → `released`
      - active, boundary reached with no breach → **`fulfilled`**
      - active, edited anyway → `violated`

      **`violated` is load-bearing once `refrain` exists.** A no-touch promise
      whose breach the system cannot detect or record is one it can express and
      nothing more — and the breach is the entire reason such promises are worth
      making in a shared tree. (This tool notifies and coordinates; it does not
      enforce. Recording a violation is what lets a person act on it.)
      `withdrawn` is likewise distinct from `cancelled`, `relinquished`, and
      `returned`: a creator may withdraw an unaccepted proposal; a current holder
      stepping back is `relinquished`; handing it to a previous owner is
      `returned`; calling the work off is `cancelled`. Message 295 exercises the
      latter ownership distinctions, not proposal withdrawal.

- [x] dispositions **typed against their targets** — `grant`/`revoke` apply to a
      clearance, `accept`/`decline`/`counter` to a request or handoff, `return`
      to held responsibility. One untyped union permits nonsense like accepting a
      revocation
- [x] **automatic creation rule, stated once so it cannot drift:** an explicitly
      structured directed *question* and an explicitly structured *self-promise*
      become **binding** on creation — the first because the recipient is named,
      the second because the maker binds themselves and should not have to accept
      their own promise. *Requests* and *handoffs* start `proposed` and need the
      recipient's act. Binding says nothing about activation: a conditional
      commitment is binding and `waiting` until its trigger fires. An explicit
      unassigned work declaration is the exception: it starts binding and
      unassigned because there is nobody who could accept a proposal; assignment
      fills the responsibility gap without deciding whether the work is needed.
      **Inferred
      prose never creates authoritative state** — only `structured_command`
      acts may seed an obligation or clearance

      | structured input | initial authority | initial activation | responsibility |
      |---|---|---|---|
      | directed question | binding | active/waiting by condition | assigned recipient |
      | assigned request | proposed | active/waiting by condition | proposed recipient |
      | unassigned required work | binding | active/waiting by condition | unassigned |
      | promise | binding | active/waiting by condition | assigned author |
      | handoff | proposed | active/waiting by condition | proposed recipient |
      | correction/hazard/grant | no obligation | no obligation | none |

      A terminal authority state makes the combined obligation non-actionable
      without rewriting the independent activation history. Thus a declined
      proposed request may retain activation=`active` as a historical fact, but
      candidate production requires authority=`binding` (except the proposed
      recipient's accept/decline candidate).
- [x] `CommitmentMode: 'perform' | 'refrain'` — forbearance is not a negated
      action; fulfilment and violation are detected differently
- [x] **a refrain commitment requires a release boundary** — a release condition,
      an `untilRef`, or explicit clearance. "I will not touch `emit.ts`" almost
      always means *until you return it or this episode closes*; without a
      terminator it becomes a permanent stale prohibition nobody remembers to
      lift
- [x] **an `automatic` condition needs a typed trigger supplied by the structured
      command, never an anchor extracted from prose.** P1 validated condition
      handling and rejected generalized anchors. Consequently triggers name only
      identifiers already authoritative in this store or an explicit commit SHA;
      there is no `ObjectRef` escape hatch:

      ```ts
      type TriggerSpec =
        | { kind: 'commit_reachable'; commitSha: string; branch: string }
        | { kind: 'work_completed'; workId: string }
        | { kind: 'work_step_completed'; workId: string; step: number }
        | { kind: 'obligation_resolved'; obligationId: string;
            resolutionKey?: string };

      type RelatedEventSpec =
        | { kind: 'work_updated'; workId: string }
        | { kind: 'obligation_updated'; obligationId: string };

      type ObligationCondition =
        | { text: string; handling: 'automatic'; trigger: TriggerSpec }
        | { text: string; handling: 'resurface_on_related_event'; event: RelatedEventSpec }
        | { text: string; handling: 'manual' };
      ```

      The system still never evaluates natural language — `text` is what a human
      reads, `trigger` is what the machine checks, and only the automatic variant
      has one. Related-event conditions can name only an existing work or
      obligation id; arbitrary paths/files remain in text. `obligation_resolved`
      is what gives test 36 a real path: fulfilling
      the answer obligation is what fires the move-file promise
- [x] **every event is written by somebody, and the payloads do not say who.**
      `{ type: 'accepted' }` carries no actor, so nothing in the schema stops one
      agent accepting, fulfilling or cancelling another's obligation. The actor
      belongs on the record rather than in every variant:

      ```ts
      interface ObligationEventRecord {
        id: string;
        obligationId: string;
        actor: ActorRef;               // authenticated, never from `from_name`
        occurredAt: number;
        expectedVersion: number;       // optimistic concurrency, see below
        idempotencyKey: string;        // a hook retry must not double-append
        payload: ObligationEvent;
      }
      ```

      | event | who may perform it |
      |---|---|
      | `accepted` `declined` `countered` | the proposed recipient |
      | `withdrawn` | the proposal's creator |
      | `fulfilled` `relinquished` | the current responsible actor |
      | `assigned` (from unowned) | operator, or an authorized coordinator |
      | `reassigned` | current owner, or operator |
      | `returned` | current owner, to the previous or declared recipient |
      | `cancelled` | creator or operator, per an explicit policy |
      | `violated` | a named system detector, the operator, or the owner with evidence |

      This matrix is written **before** the CLI, not discovered by it. And the
      agent/operator actors must come from the authenticated session; system
      actors are accepted only from an in-process component allowlist and only
      for event types the matrix grants them. Diary 40 and 41 are why
      `from_name` cannot be the source of an authorization decision
- [x] **append is transactional and version-checked.** Several agents and
      several lifecycle hooks write this store concurrently, so: read the fold
      and its version, validate actor and transition, append **only if
      `expectedVersion` still matches**, commit. `idempotencyKey` covers the
      other direction — a hook that fires twice must not produce two `accepted`
      or two exposure rows. Both are implementation requirements, recorded here
      so they are not rediscovered mid-build
- [x] **linked obligations need an edge.** The branching tests describe one act
      activating or releasing another and nothing in the schema connected them:

      ```ts
      interface ObligationDependency {
        sourceObligationId: string;
        on: { event: 'fulfilled'; resolutionKey?: string };
        targetObligationId: string;
        effect: 'activate' | 'release';
      }
      ```

      Dependency effects are synchronous derived appends inside the same SQLite
      transaction as the source event. Before writing, load and version-check
      every affected obligation, compute the finite cascade, reject cycles or
      conflicting effects, then append source and derived events atomically.
      There is no post-commit worker and therefore no crash window in which the
      source is fulfilled but its target never activates.

      **One resolution vocabulary.** An earlier draft had `answered` in the
      trigger, `fulfilled` in the events, and an untyped `onResolution: string`
      in the dependency — three spellings for one idea, in the one place the rest
      of this schema had just been made type-safe. A question is resolved by
      *fulfilling its answer obligation*; `resolutionKey` names which branch.

      For a branch the resolving agent names it rather than the system guessing
      from prose — `cli.ts answer 146 --resolution stale-claim` versus
      `--resolution editing-file`. **Inferring which branch a sentence means is
      exactly the parsing this design refuses to do elsewhere.** The question
      declares its valid resolution keys, so the CLI rejects a typo instead of
      silently never firing the dependency
- [x] responsibility as `{ kind: 'assigned'; actor: ResponsibleActorRef } |
      { kind: 'unassigned' }` — **one owner**, since any-of versus all-of
      semantics are undesigned and nothing in the corpus needs them. An
      unassigned expected action is a **responsibility gap**; assignment or
      acceptance converts it into an obligation
- [x] **only a principal that can be held to something may own one.**
      `ResponsibleActorRef` narrows `ActorRef` to agent-or-operator, so an
      obligation owed by a `system` component or by "probably Hopper"
      (`legacy_uncertain`) is unrepresentable rather than merely discouraged
- [x] **`createdBy: ActorRef` is immutable; derived
      `ObligationSnapshot.currentResponsible` moves.** There is no mutable owner
      column. Reassignment and inheritance append events that change who the
      fold says owes it, never who made it — and `createdBy` keeps the wider type,
      because historical authorship is exactly where `legacy_uncertain` belongs
- [x] **new structured acts require trustworthy attribution.** Historical rows
      may stay `legacy_uncertain`, but an obligation authored off the defective
      `from_name` path would be a commitment attributed to the wrong agent —
      worse than no obligation. Diary 40 and 41 must be closed for new writes
      before this ships
- [x] correction carries the provisional `correctionType` and an optional
      `contradictsActId`. It is available only through `correct`; no prose
      inference or generalized evidence reference. Contradiction never implies
      supersession, which remains an explicit event
- [x] **no provenance representation in P2.** P1 found only two full-corpus
      positives and unstable holdout prevalence. Do not ship a boolean, a
      confidence field, or a partial `ReportedAct`; reconsider only with a new
      corpus gate
- [x] obligation delivery reuses P0's append-only `injection_ledger`. The
      obligation id is the candidate key, folded event version is
      `stateVersion`, and selected/omitted/suppressed outcomes are recorded by
      `recordInjectionResult`. No `feature_exposure` table is added

Acceptance tests, from the four lost obligations. Two of them **branch**, and
the branches have different consequences — which is the clearest evidence that
one message can produce *linked* obligations rather than one status:

- [x] **#36** — two linked obligations from one message. The question is
      `binding` + `active` on arrival; the sender's promise to move the file is
      `binding` + **`waiting`** from the same instant. Answering the question
      satisfies the first and emits `activated` on the second, which stays
      `active` until the move. **A test that only checks the question passes on
      half the message**
- [x] **#97** — condition text and typed trigger preserved; outcome may stay honestly
      unassessable and is **never** falsely marked fulfilled
- [x] **#146** — recipient retained; the structured command links the condition
      to an existing work/obligation id rather than extracting a file anchor.
      That related event produces a delivery. The refrain commitment is
      `binding` + `waiting`
      throughout. Then it branches: *"stale claim"* satisfies the question and
      emits `released` on the commitment; *"yes, I'm in there"* satisfies the
      question and emits `activated`, holding until cleared. **Same two events,
      opposite branches — the test must exercise both**
- [x] **#295** — stays visible despite an inactive recipient; reassignable,
      cancellable, inheritable. The current holder's step-back is
      `relinquished` (binding + unassigned); a later accepted hand-back is
      `returned`. It is never `withdrawn`, because required work did not cease
      to be wanted. **Inactivity never implies completion**

The four corpus cases are necessary but not sufficient. P2's test gate also
requires:

- [x] migration tests from the current P0 database and from every historical
      schema fixture already supported; all new tables/columns/indexes are
      additive and a second migration is a no-op
- [x] table constraints and service validation reject dangling message/act/
      obligation/dependency/clearance ids, empty actor ids, duplicate act ids,
      impossible initial states, unsupported correction subtypes, and any
      deferred field smuggled into typed input
- [x] property tests generate legal event sequences and prove fold determinism,
      immutable authorship, monotonic versioning, one current owner, separation
      of authority from activation, and terminal-state rejection; generated
      illegal transitions must fail without appending a row
- [x] authorization tests cover every event/actor cell in both directions,
      including wrong session, stale display name, operator, system detector,
      legacy-uncertain author, inactive owner, and unassigned responsibility
- [x] concurrency tests race equal `expectedVersion` appends (exactly one wins),
      repeat every idempotency key (exactly one row), and verify a failed batch
      leaves no message, act, event or dependency fragment
- [x] dependency tests cover activate/release, each resolution branch, a typoed
      resolution key, cycles, self-edges, conflicting effects and duplicate
      delivery; injected failures at every write boundary must roll back both
      source and derived events
- [x] P0 integration tests force full, compact, unchanged, duplicate and
      no-room outcomes; assert exact `obligation:<id>` keys/state versions in
      `injection_ledger`, actionable omissions in `inbox`, non-actionable waiting
      items absent from `inbox`, and reinjection after clear/compact/fork but
      suppression on resume
- [x] priority tests prove `110 > 105 > 100 > roster 90`, stable key tie-breaks,
      and no priority inversion when a larger urgent candidate fails to fit
- [x] CLI/API contract tests prove each convenience command and batch form emit
      the same canonical records/prose, reject partial or contradictory input,
      and never create semantics from `msg`/`say`
- [x] schema-shape tests assert that P2 contains no generalized constraints,
      object anchors, confidence, inferred signals, provenance records, or
      parallel exposure table. These are negative requirements from P1, not
      merely untested features
- [x] restart/replay tests rebuild every fold solely from append-only events and
      reproduce the same candidates and `stateVersion` values without relying
      on cached current-state columns

### P3 — Full exposure ledger + denominator-aware stats [x]

- [x] availability / exposure / use kept **separate**. A session can run a build
      containing a feature and never see it mentioned
- [x] `surface` distinguishes an actionable delivery from a line in `cli.ts help`
- [x] session-level denominators derived from raw events — twenty session-start
      reminders are not twenty adoption opportunities
- [x] `stats` reports observations and denominators as **fields**, so the caveat
      travels with the number instead of being a formatter line someone drops
      when quoting it

### P4 — Decisions [ ]

*Scoped 2026-08-05, against the corpus and the shipped P2 code.*

A finding records what is true; a decision records what was chosen; an obligation
records what someone agreed to do. Three different things — but only one of them
needs a new table, and it is not this one.

**No new object.** A `decision` diary kind, plus a rendering of what P2 already
stores. That is the whole phase.

#### Why this is smaller than it looks

The corpus has 19 `proposal` acts, and messages 285–291 are one live argument
with the rejected option stated out loud — *"Two ways out, your call"*,
*"you own emit.ts, I back out entirely"*, *"If seed 1 goes green on the loop fix
alone I would rather ship that"*. That is exactly the P4 target.

But an earlier draft of this section proposed folding decisions out of
`proposal` acts, and **P2 has no `proposal` act type** — it was deliberately
excluded, and the code agrees: seven types, no proposal. There was nothing to
fold.

The material is in the obligation events instead:

```ts
| { type: "declined"; reason?: string }
| { type: "countered"; replacementId: string }
```

A `countered` event *is* a decision in event form — the rejected option is the
original obligation, the chosen one is `replacementId`, and `declined.reason`
carries the why. Version-checked and durable already. So the fold reads what P2
wrote rather than asking anyone to retype an argument they just finished having.

#### The three rulings

- [ ] **`decision` as a fifth `DiaryKind`**, beside `finding · warning · error ·
      optimization`. The manual path, for a choice made without a P2 obligation
      behind it — one enum member and a validator line, not a table
- [ ] **a decision view folded from `countered` / `declined`**, so an argument
      settled through structured acts produces a decision nobody had to write
      down. Rendering only; it appends nothing
- [ ] **`revisitWhen` is prose.** `TriggerSpec` names commits, work ids and
      obligation ids; *"revisit when we have more than 3 agents"* has no trigger
      in that vocabulary, and P2's own rule is that extending it needs new
      evidence. Inert but honest — and `note-deprecate` already covers "this
      stopped being true"
- [ ] **no session-start candidate.** A decision matters when someone is about to
      redo the rejected thing, which is the scope-matched pre-edit path findings
      already use. It therefore costs nothing from the budget P0 exists to
      protect, and *"session start restores continuity, it does not preload the
      database"* stays true
- [ ] **decisions stay out of `LOUD_KINDS`.** Interrupting an edit is this tool's
      most intrusive surface and it currently costs `warning | error`. A decision
      is not an error; it rides the quiet path

#### What is deliberately not built

No `concerns` field, no `alternatives[]` array, no source-ref object. The
rejected alternative comes from the counter chain; anything else goes in the
body. This phase adds one enum value and one renderer — if it grows a schema,
it has stopped being P4 and should be argued for on its own evidence.

### P5 — Tales, domain experience [ ]

*Scoped 2026-08-05, against the live store.*

Both halves answer "who knows this code". One is fundable and one is not — and
it is not the half this section originally assumed.

```
41 diary entries, 6 topics   ·  2 superseded, 4 fixed, 39 scoped
1039 edits, 10 agent names   ·  hopper 537 (65 paths), akira 146, ambrose 94
```

#### Tales: no new kind, one nullable column

- [ ] **`note-supersede <old> <new> "<what changed>"`** — the reason becomes an
      optional third argument and a nullable column. Existing chains keep
      working; nothing is backfilled
- [ ] **`cli.ts tale <id>`** renders the supersession chain oldest-first, each
      finding beside the reason it was replaced. A tale is a VIEW, like P4's
      decisions
- [ ] **no pre-edit surfacing.** A tale is something you go and read, not an
      interrupt. The `LOUD_KINDS` budget stays where it is

The threshold in the original draft — *would a later agent misunderstand seeing
only the final finding and not how the team got there?* — is already what
`note-supersede` records. It is used twice in 41 entries: the machinery exists
and the chain is thin.

A tale as a sixth `DiaryKind` would be a new write path nobody uses, which is the
failure mode P4 avoided by folding what was already stored. The only thing a
chain genuinely cannot answer today is **why** the old finding stopped being
true, and that is one field.

**The honest caveat:** two supersessions is thin evidence that anyone wants the
chain rendered. The argument for building it is that the machinery is already
there and the increment is one column, not that the corpus is asking for it. If
`--kind decision` and this both sit unused in a month, the lesson is about write
paths, not about either feature.

#### Domain experience: deferred, because the names do not hold

- [ ] **deferred.** Reconsider when a name in the edit log resolves to a live
      session — `store.findByName(agent, now) !== null` for the top edit-log
      names, which is executable rather than a judgement call

Measured 2026-08-05, top eight edit-log names against `findByName`:

```
hopper        537 edits  — no session      akira    146  LIVE
tooling        43 edits  — no session      ambrose   94  LIVE
terrain-perf   39 edits  — no session      alder     93  LIVE
ash            22 edits  — no session      adela     41  LIVE
```

Half resolve, and **the heaviest does not**: `hopper` is this agent's own former
name, renamed two days ago. The worked example this section used to carry —
*"383 edits, 21 retained findings, last active 2h ago → extensive current
context"* — would today render for a name with nobody behind it, and "ask hopper
about `core/store`" points at no one.

This is the same defect that already deferred **relationship / trust scores** in
the table below: that entry's trigger is *"lineage holds names steady across
sessions"*, and domain experience reads the same column. Deferring it is not a
judgement about the feature's value; the input is not yet trustworthy, and
`edits.agent` is a denormalised display name captured at write time, not an
identity. `ActorRef` (P2) is what identity looks like when it is done properly.

**Domain experience, not expertise, still holds when it lands.** An edit log
proves exposure and context, never skill — this tool's own busiest agent is
partly busy from getting it wrong repeatedly. Output stays evidence plus
interpretation, never a score.

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

**A tick here is a claim about the tree, and the tree is the authority.** The
plan next to this one carried four `[x] IMPLEMENTED` markers for code that was
never written. This file has since had the opposite defect: P0 shipped as
`50aa1d3` and sat unticked for two days, which is the same failure wearing the
other sign — a status column nobody re-derives drifts in whichever direction the
last edit left it. Re-verify against the code before trusting a box either way.

**Diary 40 and 41 remain open, and that is correct.** P2 required them closed
*for new writes*, which `obligations.ts` satisfies: an act's actor is
`{ kind: 'agent', agentId: senderSessionId }` from the authenticated session, and
`senderName` comes from `displayName(self)` — never from `from_name`. The two
defective historical rows stay uncorrected on purpose, per the precedence rule
above. The findings stay open because the legacy data is still wrong, not because
work is missing.
