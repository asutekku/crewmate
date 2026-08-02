# Rubric v1 — frozen 2026-08-02

The rubric both reviewers applied. Reproduced as the blind reviewer received it,
**including its defects**, because the labels in `audit-classify.json` and
`audit-blind-review.json` only mean something against the definitions that
produced them.

**Superseded by v2 (COURT_PLAN P1). Kept for provenance, not for reuse.**

---

## Dimensions

**1. `kinds`** — an array, zero or more. A message often serves several purposes
at once; label every purpose genuinely present, not just the dominant one.

- `fyi` — reports something; expects no action
- `question` — asks something; expects an answer
- `request` — asks the recipient to DO something
- `promise` — the SENDER commits to a future action of their own
- `proposal` — suggests an approach for consideration
- `correction` — states that something previously said or believed is wrong
- `warning` — alerts to a hazard, collision, or trap
- `handoff` — transfers ownership or responsibility for work

**2. `priority`** — one of `normal | important | urgent`. Judge by consequence of
ignoring it, **not by tone or capitalisation**.

**3. `futureActionExpected`** — boolean. Does the message expect an action after
it is read, by either party? A pure status report does not. A promise does.

**4. `namedResponsibleParty`** — boolean. Is it clear who is responsible?

**5. `explicitCondition`** — boolean. Does the expected action have a stated
trigger ("when X lands", "if Y", "before you Z")?

**6. `explicitness`** — `explicit | strongly_implied | ambiguous`.

**7. `outcome`** — what is observable about what happened next:
`no_response_observed | acknowledged | accepted | declined | countered |
answered | apparently_fulfilled | unknown`. Distinguish response from
fulfilment — "got it" is `acknowledged`, not fulfilled. `unknown` is a
legitimate answer.

**8. `confidence`** — `high | medium | low`.

**9. `reason`** — one or two sentences; quote the phrase that decided it.

---

## Known defects, found by the blind review

Recorded here so nobody re-derives v1 by accident.

**No stated labelling threshold.** "Label every purpose genuinely present" gave
no floor, and the two reviewers averaged 2.6 vs 4.1 kinds per message. Every
prevalence figure computed from `kinds` is threshold-dependent.

**A flat bag of kinds is the wrong abstraction.** Four purposes present in the
corpus had no slot and were all squashed into `fyi`, the de facto dump bucket —
and they are four *different dimensions*, not four more kinds: **clearance** (a
disposition), **constraint** (a modifier on consent), **withdrawal** (a state
transition about the sender), **reported third-party act** (provenance).

**`namedResponsibleParty` as one boolean hides orphans.** A message with an
owned action *and* an unowned one ("they're real and someone should chase them")
scores `true` and the orphan disappears.

**`outcome` conflates two questions.** In a stratified sample the visible outcome
is usually of the *previous* message. Needs splitting into
`outcomeOfThisMessage` and `thisMessageIsResponseTo`. `unknown` versus
`no_response_observed` was also never defined; the blind reviewer invented a
sensible distinction the rubric had not specified.

**`correction` conflates three things** — self-erratum, self-correction of
shipped code, and telling a peer they are wrong. Very different weights. Nor does
it say whether beliefs embodied in *code or behaviour* count.

**`promise` does not say whether forbearance counts.** "I will NOT move your
water files" is a commitment to inaction. **Ruled in** for v2.

**Conditional offers are a three-way tie.** "Ping me if you want me to hold —
happy to sequence" is simultaneously request, proposal and promise, with no rule
to pick.

**Sender self-labels versus content.** A message opening "FYI, not a request"
that then asks for something has no defined resolution. The blind reviewer
honoured the text and downgraded `explicitness` to record the softening —
overloading a field with a job it was not given.

**Branched obligations are unrepresentable.** "If you're back in `waterSim.ts`,
tell me and I'll stay out. If it was a stale claim, ignore this." Whether an
action is expected depends on an unobservable, and the message explicitly
licenses doing nothing.
