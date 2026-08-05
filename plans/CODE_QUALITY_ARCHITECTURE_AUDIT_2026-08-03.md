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

The following rules are acceptance criteria for every file under `cli/`. The revision of
2026-08-03 adds the path-safety, observability, and cognitive-load clauses below; where an
older rule could be read more broadly, the revised wording controls.

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

### Revised path and filesystem requirements

- User paths resolve against an explicit trusted root and are rejected if the normalized
  result escapes it. Project roots and file paths are different types/concepts.
- Project prefixes are never removed with unrestricted string replacement. Separators are
  normalized at system boundaries and tracked paths have one canonical stored/query form.
- Sensitive targets never depend on unresolved globs or environment variables. Missing
  sidecars and transient filesystem states have explicit outcomes.
- Symlink policy is documented; operations for which logical-root containment is
  insufficient use a realpath containment check.

### Revised error and observability requirements

- Optional subsystem failure is distinguishable from a legitimate empty result and leaves
  a diagnostic path. Graceful fallback exposes degraded status in verbose/diagnostic output.
- Ambiguity errors list safe candidate choices. User input errors, environmental failures,
  conflicts, and internal defects remain distinct.
- Error-and-fail behavior is consistent across commands. Partial commits are never described
  as complete success.

### Revised parser and rendering requirements

- Central parsers include durations and paths. Duration policy explicitly permits or rejects
  fractions, preventing `now - Infinity`, negative windows, and equivalent invalid math.
- Exact identity matching is preferred; prefix matching requires uniqueness.
- Plain sanitized text is measured and truncated before colour. Calculated widths are
  clamped. Pluralization and column alignment use shared policies.
- The chosen meaning of every reported “length” is named: bytes, UTF-16 units, code points,
  graphemes, visible columns, tokens, or records.

### Revised maintainability constraints

- A refactor must lower total cognitive load rather than distribute it across more symbols.
  Cohesive sequential rendering may remain together; file length alone is not a defect.
- A one-use extraction must hide meaningful complexity, establish an architectural boundary,
  or enable focused testing. Prefer roughly three to seven substantial helpers over many
  forwarding functions.
- Shared concerns live in shared modules, while code that changes and is understood together
  retains locality. Defensive checks match real trust boundaries and established lower-layer
  contracts.
- Before/after review records line count, substantial symbol count, nesting/navigation burden,
  and justification for any replacement materially larger than its source.
- Tests additionally cover path containment (relative, absolute, sibling, traversal,
  separator, and symlink cases), narrow/wide layouts, historical prefix cardinality, optional
  subsystem failure versus zero results, and every multi-mutation failure boundary.

### Current compliance audit

| Module                 | Status               | Principal remaining work                                                           |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `main.ts`              | Compliant            | dispatch, help aliases, and feature-use policy resolve through canonical metadata  |
| `registry.ts`          | Compliant            | registered handlers carry canonical metadata and reject undocumented commands      |
| `types.ts`             | Compliant            | stable readonly command, clock, terminal-sink, and CLI context contracts            |
| `args.ts`              | Compliant            | single-pass typed parsing; legacy mutation helper removed and prohibited by test    |
| `command.ts`           | Compliant foundation | extend shared failure policy to all handlers                                       |
| `result.ts`            | Compliant foundation | use for every expected operational failure                                         |
| `terminal.ts`          | Compliant foundation | migrate every complex report and untrusted output boundary                         |
| `paths.ts`             | Compliant foundation | adopt at every user-controlled filesystem boundary                                 |
| `identity.ts`          | Compliant            | canonical exact/unique-prefix resolution with explicit not-found and ambiguity data |
| `structured.ts`        | Compliant            | pure non-mutating parser driven by one canonical shortcut list                     |
| `structured-json.ts`   | Compliant boundary   | complete nested decoder; keep aligned with canonical domain lists                  |
| `obligation-events.ts` | Compliant            | canonical domain event lists, pure construction, strict versions, exhaustive switch |
| `obligations.ts`       | Partial              | centralize ID ownership; reject ambiguous live-agent matches; isolate snapshots    |
| `work.ts`              | Mostly compliant     | make registration delegate to named handlers; isolate the remaining small reports  |
| `diary.ts`             | Partial              | build report view models and move near-topic matching behind a domain index         |
| `personal.ts`          | Partial              | explicit lineage policy, snapshot collection, and renderer extraction              |
| `messaging.ts`         | Compliant            | delegated handlers, typed inputs, ambiguity-safe routing, atomic sender registration |
| `questions.ts`         | Compliant            | atomic domain operations, typed inputs, pure deterministic sanitized report renderer |
| `admin.ts`             | Partial              | isolate external probes and make identity/ownership policies domain operations      |
| `diagnostics.ts`       | Compliant            | typed inputs, isolated probes/snapshots, named deterministic sanitized renderers    |
| `diagnostics-renderers.ts` | Compliant         | pure section renderers with display-only sanitization and degraded-state output     |
| `injection.ts`         | Compliant            | delegated handlers, typed selectors, isolated probes/snapshots, sanitized renderer  |
| `roster.ts`            | Compliant            | short orchestration with isolated sync, snapshot, summary refresh, model, rendering |
| `roster-model.ts`      | Compliant            | indexed claims, cached probes, deterministic grouping/contention, one layout value  |
| `roster-renderers.ts`  | Compliant            | independent deterministic renderers with sanitization before fitting and colouring  |

### Structural metrics checkpoint

Metrics use UTF-8 LF-delimited physical lines and count named top-level functions/classes;
they are navigation indicators, not quality scores.

| Area                    |                        Before |                                              Current | Assessment                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------: | ---------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI implementation      | 2,456 lines in one executable |                        4,390 lines across 24 modules | The increase now includes a 579-line complete structured-JSON decoder plus reusable argument, path, terminal, and ambiguity boundaries. Those are concrete safety capabilities; compatibility parsing and duplicated boundaries remain review targets rather than a net-negative-line mandate. |
| Roster implementation   |      272 lines in `roster.ts` | 556 lines across orchestration, model, and renderers | The increase bought tested indexes, per-tree probe caching, deterministic view data, and pure renderers, but still needs a locality review and renderer snapshots.                                                                                                                             |
| Roster command workflow |      About 250 embedded lines |                               43 orchestration lines | Navigation from the command to meaningful pipeline stages is materially clearer.                                                                                                                                                                                                               |
| CLI executable          |                   2,456 lines |                                             11 lines | Process startup is isolated from importable application code.                                                                                                                                                                                                                                  |

The completion gate is not “more files” or “fewer total lines.” Useful shared validation,
containment checks, view models, and tests can legitimately add code. Remaining work must
still delete the temporary mutation parser, consolidate command metadata, and avoid turning a
cohesive 250-line unit into a 1,000-line abstraction maze. Any substantial growth must name
the reusable capability, safety property, or testable boundary it purchases and compare the
resulting navigation burden.

## Store refactoring status

`core/store.ts` is now a two-line re-export of `core/store/`, split by state ownership into
`schema`, `sessions`, `messages`, `activity`, `injection`, `types`, and the `index` facade —
2,037 lines across seven modules, against 2,157 in the original single file. All ten
correctness defects recorded in `plans/store-refactor.md` are fixed and covered:

- `setAlias` / `restoreAlias` use immediate transactions and reject a peer's handle, closing
  the alias-hijack race.
- `editsBy` uses a window function, so the reported timestamp and its tool/worktree come from
  the same row.
- `pruneStale` is one immediate transaction whose three deletes resolve the dead set from
  `sessions`, deleted last. The temp-table staging the plan proposed was unnecessary: a plain
  subquery is equivalent and this runs on every `who`.
- `unregister` is atomic; migration failure now aborts `openDb` with context instead of being
  swallowed.
- `withStore` rejects an async callback rather than closing the database under it.
- `hasUnread` distinguishes a missing database from corruption via a diagnostic sink.
- `liveMinions` mutates its own accumulator instead of rebuilding the array per row.

Follow-up work landed with this pass:

- The four child stores (`work`, `diary`, `questions`, `obligations`) are constructed once in
  the facade rather than per getter access, so `store.work` is a field read.
- `core/colour.ts` imports `GIVEN_NAMES` from `core/names.ts`; the `HANDLES` re-export through
  the persistence layer is deleted.
- `Store.recordFeatureEvent` reuses the exported `FeatureEventInput` instead of restating it,
  and `setCodeVersion` no longer hides a `Date.now()` default.
- Comment blocks orphaned by the split — several documenting methods that had moved to another
  module, one describing a `using` statement the code does not contain — are removed or moved
  to the code they describe.

Two tests were added and mutation-checked: reversing the `pruneStale` delete order strands a
dead session's tasks and fails the suite, and sub-store reference stability is asserted
directly. Suite: 1,004 passing, typecheck clean.

Remaining: schema ownership is still central rather than per-domain manifests with an explicit
schema version, and the facade's compatibility methods still forward for callers that have not
moved to the owned sub-store. `Store.unregister` keeps a `Date.now()` default because twenty
test call sites depend on it; `session-end.ts` now passes the clock it already holds, so the
default has no remaining production caller.
