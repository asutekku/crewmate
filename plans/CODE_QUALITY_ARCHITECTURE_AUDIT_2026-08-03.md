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

## CLI refactoring status

The CLI portion of this audit has been implemented. `cli.ts` is now only the executable
boundary, while command families are importable modules composed through a declarative
registry. The obligation command path additionally enforces these invariants:

- Domain event construction is pure and separate from database mutation.
- Each store operation captures one timestamp and reuses it for lookups and events.
- Shared `Result<T>` and command-failure helpers replace ad hoc result shapes and repeated
  usage/error handling.
- Versions are accepted only when they are non-negative integers.
- Structured JSON validates every top-level field consumed by the CLI before conversion.
- Obligation display no longer performs the unused event-history query.
- Caught values remain `unknown` until converted by the shared error boundary.
- CLI argument mutation is confined to argument-consumption code; domain inputs are
  readonly values.

Architecture tests enforce the thin entry point, module size ceiling, explicit clocks,
absence of `any`, centralized usage rendering, and removal of the history query.

The roster command now follows the same extraction standard:

- Claims are indexed once by handle and path, rather than repeatedly filtering the full
  collection.
- Dirty-file state is cached per worktree for the duration of one roster operation.
- Store synchronization and snapshot reads are separate pipeline stages.
- Terminal and column layout is calculated once and passed to renderers.
- Sessions, minions, claims, background processes, and contention warnings have separate
  renderers.
- Named constants own presentation limits such as name width, age width, and background
  process count.
- The `who` handler is a short orchestration layer over synchronization, collection,
  view-model construction, and rendering.

## Hard CLI refactoring requirements

The following rules are acceptance criteria for every file under `cli/`.

### Architecture and responsibility

- Command registration stays declarative and handlers delegate immediately to named
  functions.
- Argument parsing, domain decisions, persistence, view-model construction, and rendering
  are separate stages.
- Store callbacks remain short and operate on one consistent snapshot or mutation.
- Complex reports build view models first and render independent sections with explicit
  inputs.
- Multi-step mutations belong in atomic domain/store operations, not CLI orchestration.
- Filesystem, Git, process, clock, and database access never occurs in renderers.
- Policy decisions and fallback identity/ownership rules have explicit names.

### Type safety and validation

- External strings and `unknown` values are decoded into validated domain types; a cast to
  a domain type is never validation.
- Enums use one canonical exported value list and exhaustive switches.
- IDs, versions, counts, and limits are safe integers within documented ranges.
- Missing and invalid values are distinct failures. Duplicate or unknown flags,
  unsupported trailing arguments, conflicting selectors, and ambiguous names are rejected.
- JSON decoders validate complete structures, not only their outer containers.
- Expected failures use discriminated result types. Caught values remain `unknown` and are
  normalized only at the shared boundary.

### Mutation and consistency

- Each logical operation captures one clock value. Identifier and idempotency-key ownership
  is explicit.
- Every reference is validated before the first write; related writes are atomic and
  success is reported only after all required writes complete.
- Reads, external probes, asynchronous refreshes, and writes are not mixed in one store
  transaction.
- History/query ordering is defined and tested. Replayable commands are idempotent.

### Performance and data access

- Repeated lookups use one index by path, handle, ID, or group. Expensive filesystem and
  repository probes are cached for one command.
- Full-array filtering does not occur inside loops. Terminal dimensions and shared layout
  values are calculated once.
- Potentially quadratic similarity searches use an index or domain helper.
- Unused queries, histories, parameters, and intermediate data are removed, and database
  transactions never remain open during Git or filesystem work.

### Security and output boundaries

- Database content, repository/process metadata, filenames, and agent text are untrusted.
  Terminal output strips ANSI, OSC, and unsafe controls before measurement or colouring;
  identifiers and labels are flattened unless explicitly multiline.
- Subprocesses use executable-plus-argument arrays with shell mode disabled. SQL is
  parameterized inside store methods. Paths are normalized and checked against their
  intended root before sensitive operations.
- Full session IDs, tokens, paths, and internal identifiers are hidden unless required.
  Sanitization remains separate from canonical storage and is specific to the actual sink.
- Tests cover ANSI/OSC, newlines, quotes, shell metacharacters, traversal attempts, and
  Unicode edge cases.

### CLI argument handling

- Each command parses once into a typed input object using centralized parsers for IDs,
  versions, limits, enums, selectors, and booleans; command code does not scatter
  `shift()`, `splice()`, or `indexOf()`.
- Usage metadata drives help, dispatch, documentation, and supported-verb drift tests.
- Defaults are named constants whose policy meaning is documented.

### Rendering and layout

- Measurement uses uncoloured, sanitized strings and an explicitly named metric (code
  points, graphemes, bytes, tokens, or another deliberate unit), never ANSI byte length.
- Structural blank lines are output explicitly rather than embedded at the start of log
  strings. Magic widths and history limits are named constants.
- Groups, conflicts, topics, and histories have deterministic ordering. Empty filtered
  views state that they are empty.
- Renderers are deterministic and have no database, clock, filesystem, Git, or process
  access.

### Testing and maintainability

- Parsers and event builders are unit-tested without a store. Renderers have colour-free
  snapshots. Empty, singular, ambiguous, stale, malformed, and maximum-size inputs are
  covered.
- Drift tests cover registry, dispatch, usage, documentation, and canonical domain enums.
  Transactional failure is tested at each mutation boundary, and sanitization independently
  from business logic.
- Stable domain/view-model types are exported directly. Modules are split by domain
  responsibility, never solely to satisfy a line-count target. Comments explain contracts
  and surprising policies rather than syntax.

### Current compliance audit

| Module | Status | Principal remaining work |
| --- | --- | --- |
| `main.ts`, `registry.ts`, `types.ts` | Partial | command metadata must become the single source for usage and documentation |
| `args.ts`, `structured.ts` | Non-compliant | replace mutation-based parsing with typed, duplicate-aware decoders |
| `obligations.ts` | Partial | complete nested JSON decoding and ambiguous selector/name handling |
| `work.ts` | Non-compliant | extract typed parsers, atomic domain operations, view models, and report sections |
| `diary.ts` | Non-compliant | canonical enum decoding, safe limits/IDs, indexed similarity, and report view models |
| `personal.ts` | Partial | typed selectors/flags, ambiguity policy, and renderer extraction |
| `messaging.ts`, `questions.ts` | Partial | typed inputs, safe IDs/limits, and named handlers |
| `admin.ts` | Partial | typed selectors and explicit identity/ownership policies |
| `diagnostics.ts`, `injection.ts` | Non-compliant | typed selectors, external-probe separation, and terminal report abstraction |
| `roster*.ts` | Mostly compliant | terminal sanitization and colour-free renderer snapshots |
| `result.ts`, `command.ts`, `obligation-events.ts` | Compliant foundation | extend use across every command family |
