# Release — handing a name to a successor

*Created: 2026-08-06*

`crew release <name>` — an agent gives up its name **while still alive**, so the
next session can take it.

Status: **specified, not built.**

## The defect

MEASURED 2026-08-05/06, in this repo, twice. A session named `hopper` finished
its work. `HANDOVER.md` opened with the instruction for its successor:

```sh
crew call-me hopper
```

That instruction was **unrunnable as written**, and no sequence of commands the
outgoing session could run would make it runnable. Both agents reported the same
thing independently: `quit` deregistered, and the very next read re-registered
the name.

The successor saw:

```
✗ another live agent already answers to hopper
```

### Why, in the code

Three mechanisms combine, each correct on its own:

1. `quit` → `departSession` → `SessionStore.unregister` (`core/store/sessions.ts`)
   deletes the roster row — and on the way out **writes the departing name into
   `aliases`**, which is what `restoreAlias` reads.
2. `unregister` never touches `name_owners`. The ledger row survives.
3. The next `register` for that session id finds `mine = owners.nameFor(id)`
   still set (`sessions.ts:87`) and re-claims the name.

So a live process cannot release its own name from the inside: any subsequent
activity — including the reads it does to *verify* the release — puts it back.

A ledger row is only ever dropped by `OwnershipStore.release()`
(`core/store/ownership.ts:198`), which is keyed on transcripts present on disk.
The transcript exists for exactly as long as the conversation is resumable.
**That is deliberate** — it is the fix for a real bug (session `c5ce05bc` came
back after 68 h as `akari`, mid-conversation) and it must not be weakened. The
ledger correctly answers *"is this returning conversation still hopper?"*. It
has no way to express *"hopper is finished and gives the name up."*

### What unblocked it, and why that is not the fix

Run from the **successor's** process:

```sh
crew quit hopper && crew call-me hopper
```

This works only because `setAlias`'s liveness check (`sessions.ts:196`) reads
`sessions`, which the `quit` just emptied of that row — and the outgoing
process happened not to write in between. It needs a *third party*, it races the
outgoing session's next heartbeat, and it leaves the stale `name_owners` row
behind. It is a trick, not an interface.

## The verb

```
release [<name>] [--agent <who>]    give up a name so a successor can take it
```

Bare `crew release` releases the caller's own name. Group: `identity`, beside
`call-me`. Add to `core/verbs.ts` so `--help` lists it (see `COORDINATION_PLAN`
P0 — a verb not in that table is unfindable).

`release` is **agent-facing**: an agent gives up its own name so a successor can
take it. Adding it moves the verb counts in `docs/audiences.md`, which classifies
each verb as agent- or human-facing — update that table in the same change.

### Semantics

Releasing means three writes, in one transaction:

- **`name_owners`**: delete the row. The name returns to the pool.
- **`aliases`**: delete the row, or `restoreAlias` hands it straight back on the
  next heartbeat. `unregister` writes this row *and* `register` reads it, so
  missing this leaves the exact bug the verb exists to fix.
- **`sessions`**: the releasing agent is still alive and still needs a name.
  Assign it a fresh one from the pool via `pickName(taken)` and claim that in
  the ledger, so the roster stays truthful and `msg` still reaches it.

**Refuse to re-claim.** A released name must not come back to the releasing
session on its next `register`. Deleting the ledger row and the alias row
achieves this: `nameFor` returns `""`, and the fresh assigned name is what the
ledger now holds. No tombstone or departed-flag column is needed — do not add
one without measuring that the three deletes are insufficient.

### Output

State the new name, because the agent has one and will otherwise report the old
one to its user:

```
✓ hopper released — you are now Wren
  A successor may take `hopper` with `crew call-me hopper`.
```

## Why not the alternative

The other candidate was *"`quit` marks the session departed so re-registration
does not resurrect the name."* Rejected: `quit` is documented as *"deregisters,
it does not kill"* (`docs/views.md`), and it is routinely used on rows for
sessions that are merely idle or whose terminal was closed. Making it forfeit a
name would take names away from agents that are coming back — reintroducing the
`akari` bug for a different reason. **`release` is explicit; `quit` is not.**
(User ruling, 2026-08-06: *"release is a good one, it's pretty explicit"*.)

## Phases

- **P0 — the verb.** `OwnershipStore.release(sessionId)` for a single row;
  `Store.releaseName(sessionId, nowMs)` doing the three writes in one
  `immediate()` transaction; `cli/admin.ts` handler; `core/verbs.ts` entry;
  README verb table.
- **P1 — the handover path.** `HANDOVER.md`-style succession documented in
  `docs/naming.md`: the outgoing agent runs `crew release`, the successor runs
  `crew call-me <name>`. Two commands, two sessions, no third party, no race.

## Tests

`test/names.test.ts` is the home; it already carries the measured `call-me`
cases.

- Released name is takeable by another live session **in the same tick**.
- The releasing session does **not** get the name back after a subsequent
  `register` — the regression this verb exists to prevent. Mutation-test it:
  drop the `aliases` delete, confirm red.
- The releasing session keeps a working, distinct name and stays on the roster.
- Releasing a name held by nobody, and releasing when the caller has no
  session, both fail cleanly rather than throwing.
- `release` does **not** disturb another conversation's ledger row — the
  `akari` guard in `test/audit.test.ts` must stay green.
