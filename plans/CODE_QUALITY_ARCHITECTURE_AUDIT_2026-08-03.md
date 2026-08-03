# Presence code quality and architecture audit

Date: 2026-08-03

Scope: `.claude/hooks/presence`

## Summary

The presence tool is functionally strong and has good coverage of concurrency, identity,
migration, and delivery invariants. Its strict TypeScript configuration and domain-oriented
modules provide a sound base. The main maintainability risk is that new features continue
to accumulate in two central files: `cli.ts` and `core/store.ts`.

The recommended direction is incremental extraction, not a rewrite. Preserve tested
behavior while making command handling, persistence, schema ownership, and hook execution
independently reusable and testable.

## Findings

### High: `cli.ts` is a god-file

At audit time, `cli.ts` is 2,456 lines and combines argument parsing, command dispatch,
validation, database orchestration, identity resolution, terminal presentation, help
telemetry, and process exit behavior. Work-board, diary, personal-memory, messaging, and
obligation commands all change the same file.

Consequences include high merge-conflict probability, difficult focused review, commands
that cannot be imported without executing process dispatch, and tight coupling between
parsing, application behavior, and presentation.

Target organization:

```text
cli/
  main.ts
  context.ts
  args.ts
  output.ts
  commands/
    roster.ts
    messaging.ts
    work.ts
    diary.ts
    identity.ts
    obligations.ts
```

Each command should receive explicit dependencies such as the store, clock, UUID source,
environment, and output sink. Keep the executable entry point thin.

### High: `core/store.ts` is a god-object

At audit time, `core/store.ts` is 2,157 lines. `Store` covers sessions, aliases, messages,
delivery cursors, tasks, claims, edit history, minions, injection state, telemetry, pruning,
and access to four child stores.

The `WorkStore`, `DiaryStore`, `QuestionStore`, and `ObligationStore` extractions are the
right pattern but have not been applied consistently. Continue with session, message,
claim, task, minion, injection, and telemetry stores around one shared SQLite connection.

### High: schema ownership is fragmented

`openDb()` combines connection configuration, base schema creation, indexes, domain schema
initialization, and incremental migrations. It also migrates tables owned by the work and
diary modules. A developer changing a domain module must know to edit `core/store.ts` too.

Move each domain's creation and migrations into one schema manifest. A central runner
should invoke those manifests in order and record an explicit schema version. Preserve
tests that upgrade old database shapes.

### Medium: CLI tests inspect source text instead of behavior

`test/p2-cli.test.ts` reads `cli.ts` as text and searches case bodies for strings such as
`structured(`. These checks can fail after harmless formatting changes and can pass while
arguments or behavior are wrong. Extract importable handlers, test them through injected
dependencies, and retain a few process-level assembly tests.

### Medium: hook lifecycle boilerplate is repeated

Many hooks repeat payload reading, required-field checks, project resolution, store
opening, and the same fail-open error wrapper. Centralize invariant process policy in a
small hook runner while leaving event-specific validation in each hook.

### Medium: dependency direction leaks persistence into presentation

`core/colour.ts` imports `HANDLES` from `core/store.ts`, although `HANDLES` aliases the
canonical list in `core/names.ts`. Import names directly from their owning module and
remove the persistence re-export when compatibility permits.

### Medium: child stores are recreated on every getter access

`Store.work`, `Store.diary`, `Store.questions`, and `Store.obligations` construct new wrapper
objects for every access. Construct them once, or make factory semantics explicit.

### Medium: type safety weakens at external JSON boundaries

Structured CLI commands accept dependency data through `any[]`, and parsed JSON reaches
typed services without a clear `unknown`-to-domain decoding boundary. Export concrete
input types and validate external data before invoking application services.

## Strengths to preserve

- Dedicated strict TypeScript configuration.
- Parameterized SQL in inspected paths.
- Reliable connection cleanup through `withStore()`.
- Explicit WAL and concurrency handling.
- Fail-open hooks that still report programmer errors.
- Comments that capture invariants and measured failure modes.
- Strong identity, delivery, claim, concurrency, and migration tests.
- Existing domain stores demonstrate a viable extraction pattern.

## Refactoring sequence

1. Centralize hook execution and migrate a small proving set of hooks.
2. Make CLI command handlers importable without process-level dispatch.
3. Move structured-message and obligation commands into a command module.
4. Replace source-text CLI tests with behavioral handler tests.
5. Extract schema initialization and ordered migrations from `store.ts`.
6. Split message, claim/edit, task, minion, injection, and telemetry persistence.
7. Clean dependency direction and remove unsafe external-input types.

Each extraction should be behavior-preserving, covered by focused tests, and small enough
to review independently.
