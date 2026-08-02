# The directed-message audit behind COURT_PLAN

*Created: 2026-08-02*

Three layers, kept separate so any aggregate in
[`../COURT_PLAN.md`](../COURT_PLAN.md) traces back to the message that produced
it. Disagree with a number and you can find the text it came from.

| file | layer | what it is |
|---|---|---|
| `audit-source.json` | **source facts** | all 50 directed `say` messages, verbatim, from the live store. Never normalised or edited before classification |
| `audit-classify.json` | **reviewed interpretation** | per-message labels from the first classifier, each with a confidence and the phrase that decided it |
| `audit-blind-review.json` | **independent interpretation** | a second classifier's labels on a stratified 15-message sample, blind to the first, against the frozen rubric |

Aggregates are not stored. They are derived from these files and reported in the
plan, so a recount is always possible and a stale total cannot outlive the data.

## Why the layers are separate

The first classifier also wrote the rubric and recorded a prediction before
running the audit — that most traffic would be FYI with no future action. The
audit contradicted it (67% expect a future action, all explicit). Keeping the
source layer verbatim is what makes that checkable rather than asserted.

The blind review then exposed a problem the first pass could not see: exact
agreement on `kinds` was **2/15**, mean labels per message 2.6 vs 4.1, and the
second reviewer named four purposes the rubric had no slot for. That is a
systematic modelling error, not label noise, and it is why `COURT_PLAN` P1
reruns the whole corpus under a rewritten rubric instead of patching totals.

**Both label sets are preserved. Neither was averaged, adjudicated away, or
overwritten.** A rubric-v2 pass adds files here; it does not replace these.

## Reading them

Message ids are stable and shared across all three files. The five excluded from
analysis are 10, 11, 12, 13 (attribution self-tests) and 24 (a channel test) —
excluded in the aggregates, retained here, because a filtered corpus that hides
what it dropped is the thing this layout exists to prevent.
