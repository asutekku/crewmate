# INIT_PLAN — `crew init` and the repo config it writes

*Created: 2026-08-06. Re-measured against code the same day; every "exists
today" claim below was verified in source, not quoted from another document.
Future tense throughout; nothing here is built.*

## What exists today, and why init is missing

There are two setup surfaces, and both ignore the repo:

- **`install.ts` is user-wide.** It copies scripts to
  `~/.claude/agent-presence/bin/`, registers hooks in `~/.claude/settings.json`
  and writes the `crew` shim. It never touches a repo. Modules are discovered
  by walking the source tree, so new directories deploy without installer
  changes.
- **Config is one global file of lifetimes.** `core/config.ts` reads
  `~/.claude/agent-presence/config.json` only — eleven TTL/size knobs, each
  degrading per field. Its cache is process-global with no notion of which
  repo is asking (`loadConfig()` takes no arguments). Nothing anywhere records
  what a repo IS: where its ownership boundaries run, which files always
  conflict, what is generated, how its tests are run.

So every coordination decision crew makes today is shape-blind. The pre-edit
hook treats a lockfile like any source file. Overlap warnings fire for two
agents in unrelated workspace packages and stay silent on two agents both about
to add `migrations/0043_*.sql`. The "never run the full suite" rule exists only
as shouting in this repo's hand-written CLAUDE.md, invisible to every hook.

## What init is, in one line

`crew init` reads the repo's own manifests, derives a description of the repo's
shape into `<root>/.claude/crew.json`, confirms it with the operator, and
writes the three repo files. Hooks then read that shape on every edit.

The split with `install.ts` stays: install = user-wide code and hooks; init =
one repo's shape and guidance. Init checks the install and points at it; it
never edits `~/.claude/settings.json`.

**The honesty rule: no WRITTEN key without a reader.** Init only writes keys
whose consumer has shipped — a config field nothing reads is documentation
that lies about being configuration. But the SCHEMA is allowed to run ahead of
the code: it documents every intended key, current and future, so hand-written
keys cannot collide with names a later phase will claim, and so this plan is
the one place the whole shape is designed. The two halves are kept honest by
the consumer-status column below and by `--check`, which reports any key in a
real crew.json that nothing yet reads.

## `<root>/.claude/crew.json` — the schema

```jsonc
{
  // Schema version. Init writes it; a reader ignores keys it does not know,
  // so old code reads new files and only migrations need the number.
  "v": 1,

  // Ownership boundaries. Two agents in different units are parallel work;
  // two in the same unit are an overlap worth announcing.
  "units": ["apps/*", "packages/*"],

  // Build outputs and codegen results. Never claimed, never blamed,
  // never a conflict.
  "generated": ["dist/**", "**/__generated__/**", "target/**"],

  // Files where simultaneous edits ALWAYS conflict, live claim or not.
  "hot": ["package.json", "**/*.lock", "prisma/schema.prisma"],

  // Directories with ordered filenames, where two agents creating
  // "the next file" collide by construction.
  "sequenced": ["prisma/migrations", "db/migrate"],

  // How this repo is checked, and the cheapest honest scope of it.
  "checks": {
    "test": "bun test",
    "testScoped": "bun test {path}",
    "lint": "eslint --fix {path}"
  },

  // "scoped-only": running the full suite gets a pre-bash warning that
  // names the scoped command instead.
  "testPolicy": "scoped-only",

  // Source → artifact pairs with the command that reconciles them.
  "codegen": [
    { "edits": "prisma/schema.prisma", "stales": "src/generated/**",
      "run": "bunx prisma generate" }
  ],

  // The existing global lifetimes, overridable per repo. Same per-field
  // degradation as core/config.ts today; merge order below.
  "tunables": { "workStaleMs": 10800000 }
}
```

### Key by key: derived from what, read by what

| Key | Derived from | Consumer | Consumer status |
|---|---|---|---|
| `units` | package.json `workspaces`, pnpm-workspace.yaml, Cargo `[workspace] members`, go.work, settings.gradle, *.sln, CODEOWNERS paths | pre-edit overlap logic (same-unit = warn, cross-unit = quiet); roster grouping; diary scope suggestions | new logic in existing surfaces (P4) |
| `generated` | .gitignore + conventional names (dist, build, target, .next, coverage, __generated__), codegen outputs below | pre-edit skips the claim; `blame`/`files` filter the noise; edit history stays smaller | hook exists, add filter (P2) |
| `hot` | lockfiles present (bun.lock, pnpm-lock.yaml, Cargo.lock, poetry.lock, uv.lock, go.sum), root manifests, schema files, CODEOWNERS-protected paths | pre-edit escalates: warns even with no live claim, names who touched it last (`blame` data already exists) | hook exists, add tier (P2) |
| `sequenced` | prisma/migrations, alembic, rails db/migrate, django */migrations, flyway | pre-edit on file CREATE: "akari added a file here 20 min ago — renumber before you commit" | new check in existing hook (P4) |
| `checks` | package.json scripts, Makefile / justfile / Taskfile targets, Cargo (`cargo test`), pyproject (`pytest`), go.mod (`go test ./...`) | session-start block and `breaks`/`needs` advice can name the real commands; `testScoped` is what the testPolicy warning offers | new, small (P2) |
| `testPolicy` | asked (Q3), default scoped-only when a scoped form exists | pre-bash: full-suite command → warning naming `checks.testScoped`. Same detection shape as the existing poll-loop guard, but WARN where that one denies | hook exists, add pattern (P2) |
| `codegen` | prisma/, *.proto + buf.gen, openapi.{yml,json} + generator configs, graphql codegen.yml | `where` and turn-end: source newer than artifact → "schema edited, client not regenerated — run X". Mirrors `driftFromInstalled`, which is this exact check for crew's own code | new, pattern exists (P4) |
| `tunables` | asked (Q1/Q2), repo activity | `core/crewfile.ts` merge (see design note) | P0 |

Detection is per format, not per ecosystem hardcode: each detector is a small
pure function `(files at root) → partial config`, and unknown ecosystems
simply yield less. A monorepo detector that finds nothing writes no `units`
key — absence of a key means "no boundary known", never "no boundary".

### Reserved keys — future functionality, named now

These are documented so a hand-written key cannot collide with a name a later
plan will claim. Init NEVER writes them until their consumer ships; `--check`
lists them as "reserved, unread" when found in a real file.

| Key | Intended meaning | Would ship with |
|---|---|---|
| `topics` | Seed taxonomy for diary topics, so eight agents do not invent eight spellings of `db-migrations` | diary: `note` suggests from it, `topic merge` folds strays in |
| `roles` | Roles this repo usually needs ("Schema Warden", "Test Runner"), offered at session start when unclaimed | identity/session-start |
| `protected` | Paths agents must not edit without an explicit operator grant — stronger than `hot`, which only warns | pre-edit + the clearance ledger that already exists |
| `injection` | Per-repo session-start emphasis: blocks to always include or always drop | `core/injection.ts` budgeting |

The rule for adding to this table: a reserved key needs a named consumer and a
plan (or phase) that would build it. A name with neither is brainstorming, and
belongs in `ideas/`, not in a schema.

## The other two files init writes

**The CLAUDE.md block**, between `<!-- crew:init:begin/end -->` markers,
generated from one template: the "you are one of N agents" headline; the three
git rules verbatim (never stash / stage explicit paths / `EnterWorktree` with
its authorization line, git repos only); the two crew habits (`board` before
large work, `note --scope`); the peer-naming rule; and — new value from the
schema — the repo's own commands: "test one file: `bun test {path}`". This
repo's hand-written section becomes a generated block too, so template and
practice cannot drift. MATCH THE FILENAME CASE-INSENSITIVELY and edit the file
found: this very repo's file is literally `claude.md`, and an init that writes
`CLAUDE.md` beside it would create a second file on Linux and silently shadow
one of the two everywhere else.

**`<root>/.claude/settings.json`** — one key, `worktree.baseRef`, from Q4.
Merged like `install.ts` merges user settings: other keys untouched, invalid
JSON aborts with a message.

## The questions

Init asks little, because the manifests answer most of it. Questions confirm;
they do not gather.

| # | Question | Default | Feeds |
|---|---|---|---|
| Q1 | How many agents at once? (2–3 / 4–8 / more) | 4–8 | headline N, `tunables.injectionTargetChars` |
| Q2 | Typical task length? (under an hour / longer) | under an hour | `tunables.claimTtlMs`, `tunables.workStaleMs` |
| Q3 | Full test suite: fine, or scoped-only? | scoped-only if `testScoped` detected | `testPolicy` |
| Q4 | Cut worktrees from head, or from `<base>`? | head | `worktree.baseRef` |
| — | Show derived crew.json, confirm/edit | write as shown | everything detected |
| — | Write the CLAUDE.md block? | yes | the block |

Interactive only at a TTY; every question has a flag (`--crew-size`,
`--task-length`, `--test-policy`, `--base-ref`, `--claude-md/--no-claude-md`,
`--yes`); agents and scripts get deterministic defaults. NOTHING IN `cli/`
PROMPTS TODAY — this is the first interactive flow, so it stays line-based
stdin with no dependency, and the TTY gate is what keeps every existing caller
(hooks, tests, agents) on the flag path.

## Design decisions

**Why `<root>/.claude/crew.json`, committed.** `<root>` is the MAIN working
tree (`RepoContext.root` is derived from the git common dir, so every worktree
of one repo resolves the same root) — one file governs all of them even when a
worktree is pinned to a commit that lacks it. Committed, because the shape of
the repo is team knowledge, not personal preference.

**Read on hook paths, so it must degrade.** Same contract as `core/config.ts`:
missing, unreadable or malformed → that key's absence, per field, never a
throw. A typo in `hot` must not take an edit down with it.

**The tunables merge lives in the new layer, not in `loadConfig`.**
`loadConfig()` takes no root and its cache is one process-global value; giving
it a root parameter would touch every caller for a repo most of them do not
know. Instead `core/crewfile.ts` exports `repoConfig(root)`: DEFAULTS ← global
← repo, per field, cached per root, with a `clearCrewfileCache()` test seam
mirroring `clearConfigCache()`. Callers that coordinate (hooks, injection)
migrate to it; callers with no repo in hand keep `loadConfig()` and lose
nothing.

**Warnings, not walls.** Every new consumer warns and names the alternative.
The poll-loop guard denies because the denied thing is strictly wasteful; a
full-suite run or a hot-file edit is sometimes right, so those surface a
warning the agent can override by proceeding.

**Idempotent by markers and by keys.** Re-running init re-derives, shows a
diff against the existing crew.json, and replaces the CLAUDE.md marker block
in place. Hand-added keys survive — including reserved and unknown ones; a
markerless hand-written CLAUDE.md section is reported, never edited.

## Phases

P0–P3 shipped 2026-08-06, with three deviations from the text below, each
deliberate:

1. **No questions at all.** The user asked for a bare `crew init` that works
   without prompting anywhere. The TTY question flow was dropped; flags are
   the only override surface, and defaults apply otherwise. "The questions"
   section above describes flags now, not prompts.
2. **`core/detect.ts` is one module, not a `core/detect/` directory** — the
   detectors are small pure functions and a directory bought nothing.
3. **Init owns a feature id** (`init` in `core/features.ts`) rather than
   `trackUse: false`: `features.test.ts` requires every non-help verb to have
   a feature owner, which is stricter than this plan assumed.

### P0 — config layer
- [x] `core/crewfile.ts`: schema, parse, per-field validation, `repoConfig(root)`
      merge (DEFAULTS ← global ← repo), cache keyed by root, clear seam.
- [x] Tests: `test/crewfile.test.ts` — malformed file → empty shape; one bad
      key does not drop the rest; merge order; unknown and reserved keys.

### P1 — the verb, read-only
- [x] Row in `core/verbs.ts`; feature owner in `core/features.ts`.
- [x] New family `cli/init.ts` in `COMMAND_FAMILIES`; detectors in
      `core/detect.ts` as pure functions over a `FileAccess`.
- [x] `crew init --check`: prints the derived crew.json, the install state
      (`installedVersion`, shim on PATH), which of the three files exist, and
      keys nothing reads. Exit 1 when something is missing. CI NEEDS A
      NARROWER GATE: install state is per MACHINE, so `--check --repo` limits
      the check and the exit code to the repo files; that is the CI gate.

### P2 — cheap consumers, existing hooks
- [x] pre-edit: skips claims on `generated`; warns on `hot` (pointing at
      `crew blame` rather than embedding last-touch — one query cheaper).
- [x] pre-bash: `testPolicy` warning naming `checks.testScoped`.
- [x] Tests: `test/testpolicy.test.ts` (pure), `test/crewfile-hook.test.ts`
      (the real subprocess with a payload on stdin).

### P3 — init writes
- [x] crew.json (only keys with shipped consumers), CLAUDE.md block from the
      template (case-insensitive filename match), settings.json
      `worktree.baseRef`. `test/init-block.test.ts` pins the block;
      `test/init-cli.test.ts` pins re-run stability and hand-edit survival.
- [x] This repo ran `crew init` on itself; the hand-written CLAUDE.md section
      is replaced by the generated block.

### P4 — structural consumers
- [ ] `units` in overlap logic and roster grouping.
- [ ] `sequenced` create-collision warning.
- [ ] `codegen` drift in `where` and turn-end.

### P5 — reserved keys graduate (each is its own decision, not a batch)
- [ ] `topics` seeding in diary suggestions.
- [ ] `roles` offer at session start.
- [ ] `protected` + clearance integration.
- [ ] Each graduation moves the key from the reserved table into the main
      schema table with a real consumer-status entry.

### P6 — docs
- [ ] README "Init a repo" section; operating.md config table gains the repo
      file and merge order; plans/README.md row re-measured against code.

## Open questions

- **`.claude/settings.json` — measured 2026-08-06: the directory `.claude/`
  does not exist in this tree at all**, yet CLAUDE.md's shared-tree section
  states the file sets `worktree.baseRef: "head"`. CLAUDE.md documents a file
  that is not there. Init writing it (P3) makes the claim true; decide whether
  CLAUDE.md gets corrected before that or by it.
- A committed `tunables` means the repo overrides every operator's personal
  `config.json` (repo wins in the merge above). Right for coordination knobs
  like `workStaleMs`; arguable for taste knobs like `injectionTargetChars`.
  Decide per key when P0 lands, not wholesale.
- CODEOWNERS as a `units`/`hot` source is listed but unranked: it encodes
  human review boundaries, which are usually — not always — the right
  coordination boundaries. Decide with a real CODEOWNERS in front of us.
- Whether `checks` should also feed a `crew check <path>` verb (crew running
  the scoped test itself) is deliberately out of scope: crew observes and
  advises; it does not become a task runner.
