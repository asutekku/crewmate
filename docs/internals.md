# Internals — files, tests, failure modes

[← README](../README.md)

## Files

Four folders by role: `hooks/` is the event surface, `core/` is shared domain
code and persistence, `cli/` owns the command application, and `test/` never
ships. Only `cli.ts` and `install.ts` sit at the top because they are the two
things you run by hand; `cli.ts` is deliberately only an executable boundary.

**`bin/` mirrors this layout**, so the relative imports that ship resolve exactly
as they do here — `install.ts` walks the tree rather than flattening it, and
replaces `bin/` wholesale so a module that moves cannot leave a stale twin.

### `hooks/` — one file per event, each fails open

| File                | Event                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| `session-start.ts`  | **SessionStart** — register; inject the roster.                           |
| `prompt-submit.ts`  | **UserPromptSubmit** — heartbeat; deliver unread; record the stated task. |
| `pre-edit.ts`       | **PreToolUse**(Edit) — claim the path; warn on peer overlap.              |
| `pre-bash.ts`       | **PreToolUse**(Bash) — deny a loop polling a background task's output.    |
| `tool-batch.ts`     | **PostToolBatch** — mid-turn delivery.                                    |
| `turn-end.ts`       | **Stop** — publish the turn's files; deliver directed mail.               |
| `turn-failed.ts`    | **StopFailure** — a dead turn stops reading as "still working".           |
| `notify.ts`         | **Notification** — records "waiting for permission".                      |
| `subagent-start.ts` | **SubagentStart** — tells a subagent what peers hold.                     |
| `subagent-stop.ts`  | **SubagentStop** — closes the minion out, so the count is live.           |
| `commit-landed.ts`  | **PostToolUse(Bash)** — reads git's own output; records the sha.          |
| `compacted.ts`      | **PostCompact** — refreshes intent from the compaction summary.           |
| `cwd-changed.ts`    | **CwdChanged** — keeps worktree/branch true after a `cd`.                 |
| `task-changed.ts`   | **TaskCreated/Completed** — mirrors per-session tasks to a shared board.  |
| `session-end.ts`    | **SessionEnd** — deregister on clean exit.                                |

### `core/` — shared by every hook and the CLI

| File                  | Role                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `store.ts`            | A re-export of `store/`. The split kept the import path so callers did not move.                                                          |
| `store/types.ts`      | Row shapes and the staleness horizons (`STALE_MS`, `MINION_STALE_MS`).                                                                     |
| `store/schema.ts`     | Tables, indexes, pragmas. Every migration lands here.                                                                                     |
| `store/sessions.ts`   | Register, heartbeat, prune, and the name-ownership guard.                                                                                 |
| `store/ownership.ts`  | Which session owns a name, and what `findByName` resolves.                                                                                |
| `store/activity.ts`   | Claims, the edit log, tasks, and subagent rows.                                                                                           |
| `store/messages.ts`   | Message rows and the per-session delivery cursor.                                                                                        |
| `store/injection.ts`  | Exposure ledger, feature events, code versions — what a session has already been shown.                                                   |
| `store/index.ts`      | The facade the rest of the tool calls. The only file that knows SQL is its neighbours.                                                    |
| `repo.ts`             | Project identity, worktree, db path (cached — a `git rev-parse` costs 31 ms).                                                             |
| `shared.ts`           | Payload reading, report formatting, `emit`.                                                                                               |
| `topic.ts`            | Lossy, credential-rejecting text → one-line roster label.                                                                                 |
| `colour.ts`           | ANSI for the CLI only. Never reaches an agent's context.                                                                                  |
| `agents.ts`           | Reads `claude agents --json` for real names + idle/busy.                                                                                  |
| `transcript.ts`       | Bounded tail read of a session's own JSONL — conversation title, recent prose.                                                            |
| `summary.ts`          | Prompts Haiku for a "what is it doing now" line; spawns, never waits.                                                                     |
| `summarize-worker.ts` | The detached process that call runs in, so no hook ever blocks on it.                                                                     |
| `layout.ts`           | Roster layout arithmetic — widths, file summarising, background processes.                                                                |
| `work.ts`             | The work board's tables, agent key, and the event fold. Its own lifetime rule.                                                            |
| `board.ts`            | Rendering the board — takes a paint callback, so it is testable without a terminal.                                                       |
| `diary.ts`            | Findings that outlive a session: topics, tags, scopes, FTS5 search.                                                                       |
| `questions.ts`        | Questions between agents — state, delivery, and expiry against a dead target.                                                             |
| `obligations.ts`      | Explicit acts, append-only folds, authorization, dependencies, and P0 candidates.                                                         |
| `features.ts`         | Canonical feature ids, labels, candidate mappings, act mappings, and CLI surfaces.                                                        |
| `hook.ts`             | Shared hook input and output helpers.                                                                                                     |
| `personal.ts`         | Per-agent memories, in one db outside any project. `forget` deletes.                                                                      |
| `verbs.ts`            | Every CLI verb in one table; `usage()` and per-verb argument errors render from it.                                                       |
| `names.ts`            | The given-name pool, and the two casers (prose role vs typeable name).                                                                    |
| `dirty.ts`            | Uncommitted files, for the roster's "what is in flight" line.                                                                             |
| `config.ts`           | Tunables — staleness windows, how much of the board to show.                                                                              |
| `crewfile.ts`         | The repo's shape from `.claude/crew.json` — hot/generated globs, checks, per-repo tunables. Degrades per field.                           |
| `detect.ts`           | Manifests in, partial crew.json out — pure detectors per format, for `crew init`.                                                         |
| `initBlock.ts`        | The generated CLAUDE.md coordination block: template, markers, case-insensitive file match.                                               |
| `stats.ts`            | Aggregates rows plus separate feature availability/exposure/use observations, session opportunities, and surfaces.                        |
| `injection.ts`        | What reaches a session's context: identity as an un-evictable envelope, everything else ranked against a budget.                          |
| `sessionBlock.ts`     | The session-start candidates themselves — roster, recent activity, diary, memories — built once for both the hook and `crew injection`. |

`feature_events` is the raw P3 evidence ledger. Availability means a session
loaded a build containing a feature, exposure means a named surface actually
showed it, and use means an operation occurred. These are never inferred from
one another. Every aggregate includes observation, distinct-session, and
session-opportunity counts; repeated session starts therefore increase the raw
observation count without inflating the adoption denominator. Availability is
read from the installed manifest generated by `features.ts`; use opportunities
come from exposed sessions, including those that did not use the feature.
Injection observations retain the originating delivery id, while measurement
history has its own lifetime independent of live suppression state.

### `cli/` — one command family per module

| File                   | Role                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `main.ts`              | Builds the command registry, dispatches one command, and records CLI-use telemetry. |
| `types.ts`             | Explicit command context and handler contracts.                                     |
| `registry.ts`          | Duplicate-safe composition of independently owned command families.                 |
| `args.ts`              | Typed parsing for flags, selectors, enums, IDs, and limits.                         |
| `command.ts`           | Centralized usage and command-failure presentation.                                 |
| `result.ts`            | Explicit success/failure values and safe caught-error normalization.                |
| `terminal.ts`          | Sanitized terminal text, visible-width policy, and structured reports.              |
| `paths.ts`             | Trusted-root path resolution and canonical tracked-path conversion.                 |
| `roster.ts`            | Short orchestration pipeline for the live roster command.                           |
| `roster-model.ts`      | Store synchronization, snapshot indexing, contention analysis, and layout.          |
| `roster-renderers.ts`  | Independent session, minion, claim, background-process, and warning renderers.      |
| `messaging.ts`         | Log, directed messages, and broadcasts.                                             |
| `work.ts`              | Work-item mutations, board/history rendering, and break/need signaling.             |
| `diary.ts`             | Findings, bugs, search, topics, tags, and retirement.                               |
| `personal.ts`          | Operator memories and lineage inheritance.                                          |
| `questions.ts`         | Answering and inspecting questions.                                                 |
| `obligations.ts`       | Structured acts and obligation/clearance lifecycle commands.                        |
| `obligation-events.ts` | Pure version validation and obligation/clearance event construction.                |
| `structured.ts`        | Pure parser for single-act structured-message shortcuts.                            |
| `structured-json.ts`   | Complete unknown-to-domain decoder for structured JSON batches.                     |
| `admin.ts`             | Naming, roles, project location, roster clearing, and deregistration.               |
| `diagnostics.ts`       | Edit history and store statistics.                                                  |
| `diagnostics-renderers.ts` | Pure sanitized section renderers for diagnostic reports.                      |
| `injection.ts`         | Session-start envelope and omission inspection.                                     |

### Top level

| File                      | Role                                                      |
| ------------------------- | --------------------------------------------------------- |
| `cli.ts`                  | Eleven-line executable boundary that calls `cli/main.ts`. |
| `install.ts`              | Copy to `~/.claude/agent-presence/bin/`, register hooks.  |
| `test/store.test.ts`      | Delivery + identity, against a real throwaway db.         |
| `test/topic.test.ts`      | What may become a roster label, and what may not.         |
| `test/roster.test.ts`     | Roster layout, asserted with colour codes stripped.       |
| `test/layout.test.ts`     | Width arithmetic and path classification.                 |
| `test/transcript.test.ts` | Tail reads of real transcript shapes.                     |
| `test/work.test.ts`       | The timeline property, and several items open at once.    |
| `test/board.test.ts`      | Board rendering — widths measured on UNPAINTED text.      |

## Tests

```sh
bun test                                          # the whole suite
bun run typecheck                                 # the other gate
PRESENCE_TEST_DB=/tmp/x.db bun pre-edit.ts < payload.json   # run a hook safely
```

**Typecheck as well as test.** The repo root's tsconfig covers `src/` and does
not include `.claude/`, so this tool had no type gate at all until it got its
own — which is how a missing import once shipped, failed open, and left a hook
exiting 0 having done nothing. The scoped config caught a real error the first
time it ran.

**`PRESENCE_TEST_DB` redirects every hook to a throwaway db, and anything that
runs a hook must set it.** Testing a hook means _running_ it, and running it
writes to whatever db it resolves — so a test payload lands in the live roster
as a real session with real claims and real log lines. That happened on
2026-07-31: probe sessions left 26 junk messages and a false contested-file
warning naming a session on a file it never edited, which the user had to read
past and which made a fake collision look real.

**The path must be explicit.** `bun test` skips dot-directories, so these files
are invisible to the repo-wide sweep and a bare `bun test .claude/...` matches
nothing — it reports "0 files searched" rather than failing, which reads exactly
like a pass. Run them by hand after touching anything in `core/`.

Every rejection case in it is a string that actually reached the roster and
described nothing. The acceptance cases are there because the first version of
each filter was too greedy and blanked the field it was meant to protect: an
intent that says nothing and an intent that says the wrong thing are both
failures, and a filter is only finished when it is tested from both sides.

## Fail open, but not silently

Every hook ends in `catch { … }` so a locked db or a bad payload can never break
a session. That guarantee has a trap: **a programmer error looks identical to
"nothing to report"** — the hook exits 0, prints nothing, and does not do its
job. A missing import shipped exactly this way on 2026-07-31, and the symptom
was a correction that simply never happened.

So the catch reports to stderr before returning. The exit code is still 0 and
nothing is blocked, but the failure is findable. Two consequences worth knowing:

- **Typecheck before `install.ts --force`, every time.** `tsc` catches this
  class as `TS2304: Cannot find name 'X'`; the install step does not typecheck,
  and it is what makes the bug live.
- **A hook exiting 0 is not evidence it worked.** Neither is replaying its logic
  in-process — that exercises different imports and can pass while the hook
  fails. Run the deployed script against a real payload and read stderr.

Only the hook entry points in `hooks/` report. `agents.ts`, `store.ts` and
`install.ts` catch _expected_ failures on constantly-running paths (a missing
settings file, a locked db) where reporting would be noise, not signal.

