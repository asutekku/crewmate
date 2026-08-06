# Plans

*Created: 2026-08-01*

Phased specs for presence work. A plan is **future tense** — what should be
built. Once something ships, the truth moves to the tool's
[README](../README.md) and the plan's checkbox is re-measured **against the
code**, never against the last thing the plan said about itself.

That last rule is not decoration. `WORK_RECORDS_PLAN.md` carried four
`[x] IMPLEMENTED` markers for phases that had never been written, and the board
dangled for months because `asked_turn_ms` shipped with no caller under a
describe block claiming it was read. **A plan that grades its own homework is
the least trustworthy file in the repo.**

| Plan | Covers | Status |
|---|---|---|
| [DIARY_PLAN.md](DIARY_PLAN.md) | shared findings, topics, tags, scopes, FTS | shipped |
| [WORK_RECORDS_PLAN.md](WORK_RECORDS_PLAN.md) | the work board: items, steps, landed commits, breaks/needs | shipped |
| [COORDINATION_PLAN.md](COORDINATION_PLAN.md) | generated `--help`, questions, bug state, plan links | P0–P2 shipped; P3 shipped bar two deferred items |
| [LINEAGE_PLAN.md](LINEAGE_PLAN.md) | memory that outlives a uuid, disciple naming, handoff | P0–P4 pending |
| [AFFINITY_PLAN.md](AFFINITY_PLAN.md) | which agents work well together | **deferred — measured, no data** |
| [COURT_PLAN.md](COURT_PLAN.md) | obligations, message semantics, the session-start injection budget | P0–P5 pending |
| [RELEASE_PLAN.md](RELEASE_PLAN.md) | `crew release` — giving a name to a successor while still alive | P0–P1 pending |
| [AUDIT_REMEDIATION_PLAN.md](AUDIT_REMEDIATION_PLAN.md) | defects and absences found by running all 51 verbs: dead Q&A loop, glyph divergence, operator read surfaces | P0–P5 pending |
| [INIT_PLAN.md](INIT_PLAN.md) | `crew init` — per-repo config layer, generated CLAUDE.md block, first-run checks | P0–P4 pending |

## Reading order

`COORDINATION_PLAN` P0 first: 33 verbs exist and `--help` lists 13, so every
other feature here is unfindable until that is fixed.

`LINEAGE_PLAN` is the one with a real bug behind it — personal memories are
keyed on `session_id`, so a new conversation about roads starts empty even when
a roads agent's knowledge is sitting in the db.

`RELEASE_PLAN` is the other one with a real bug behind it, and the bug was hit
twice on 2026-08-05/06: a `HANDOVER.md` whose first instruction — take the
outgoing agent's name — could not be run by the agent it was written for.

`AFFINITY_PLAN` is a good idea deferred on evidence rather than dropped; read it
for the measurement if the question comes up again.
