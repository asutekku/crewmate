# P3 implementation audit — 2026-08-03

P3 was initially marked complete after its four checklist lines passed focused
tests. A subsequent architecture audit found that the vocabulary was right but
the implementation was not yet a reliable, extensible measurement system.

## Findings to close

1. Availability was emitted from a second hardcoded catalog rather than the
   installed manifest's authoritative feature set. Names already disagreed and
   the manifest omitted the new P2 capabilities.
2. `use.opportunities` was derived from use events, making the denominator
   tautological and excluding every exposed non-user.
3. Use instrumentation covered only P2 structured batches; legacy features had
   row counts but no use observations.
4. Injection exposure was duplicated into an anonymous second ledger with no
   delivery reference, permitting the two histories to drift.
5. Availability and use evidence was pruned on the context-suppression horizon,
   although those records have a different lifecycle.
6. Feature identity was repeated across the install manifest, store catalog,
   candidate mapper, stats rows, help recorder and structured-act mapper.
7. `help` claimed exposure to every catalog entry rather than only features the
   rendered command surface actually exposes.
8. The observation API and table accepted unchecked stage/surface/identifier
   values, while structured acts bypassed the API with separate SQL and
   idempotency behavior.
9. Stats ran roughly six queries per feature instead of one grouped scan.
10. Availability timestamps ignored the session-start timestamp already in
    hand, weakening deterministic replay.

## Required shape

- One canonical typed feature registry generates manifest claims, display
  labels, candidate mapping, help mapping and stats enumeration.
- One validated observation API writes availability, help exposure and use.
- Injection exposure observations carry the originating delivery ID and are
  committed with the injection ledger row.
- Raw observations remain distinct from session opportunities. Use is divided
  by exposed opportunities, never by the set of sessions that already used it.
- Durable measurement evidence has its own lifecycle, independent of live
  context suppression state.
- Aggregation scans the observation ledger once and returns observations,
  sessions, opportunities and surfaces as fields.

## Resolution

All ten findings are closed in the implementation:

| Finding | Resolution | Evidence |
|---|---|---|
| competing catalogs | `core/features.ts` is the typed registry used by install, CLI, injection, structured acts and stats | `features.test.ts` |
| tautological use denominator | use opportunities come from exposure opportunities, including exposed non-users | `p3-stats.test.ts` |
| P2-only use data | successful CLI operations and structured API/CLI batches record use | `features.test.ts`, `p3-stats.test.ts` |
| anonymous duplicate exposure | injection exposure carries and validates the originating delivery ID | `p3-stats.test.ts` |
| wrong retention lifecycle | feature evidence is not touched by injection-state pruning | `p3-stats.test.ts` |
| repeated feature identity | mappings and manifest IDs derive from the canonical registry | `features.test.ts` |
| overclaimed help exposure | help records only features owning a rendered verb | `features.test.ts` |
| unchecked/bypassed writes | one validated store API owns all writes; structured writes share its transaction | `p3-stats.test.ts` |
| per-feature query fan-out | one grouped CTE aggregates every feature, stage and surface | `core/stats.ts` |
| nondeterministic availability time | session start passes its captured timestamp and manifest metadata | `p3-stats.test.ts` |

Final verification on 2026-08-03: 947 presence tests pass and the presence
TypeScript project type-checks cleanly.
