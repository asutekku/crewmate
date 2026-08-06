# INIT_PLAN — `crew init` and the repo config it writes

*Created: 2026-08-06. Future tense throughout; nothing here is built.*

## What exists today, and why init is missing

There are two setup surfaces, and both ignore the repo:

- **`install.ts` is user-wide.** It copies scripts to
  `~/.claude/agent-presence/bin/`, registers hooks in `~/.claude/settings.json`
  and writes the `crew` shim. It never touches a repo.
- **Config is one global file of lifetimes.** `core/config.ts` reads
  `~/.claude/agent-presence/config.json` only — eleven TTL/size knobs. Nothing
  anywhere records what a repo IS: where its ownership boundaries run, which
  files always conflict, what is generated, how its tests are run.

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

**The honesty rule for the schema: no key without a reader.** Every key below
names the hook or verb that consumes it, and init only writes keys whose
consumer has shipped. A config field nothing reads is documentation that lies
about being configuration.

## `<root>/.claude/crew.json` — the schema

```jsonc
{
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

  // The existing global lifetimes, overridable per repo. Same merge,
  // same per-field degradation as core/config.ts today.
  "tunables": { "workStaleMs": 10800000 }
}
```

### Key by key: derived from what, read by what

| Key | Derived from | Consumer | Consumer status |
|---|---|---|---|
| `units` | package.json `workspaces`, pnpm-workspace.yaml, Cargo `[workspace] members`, go.work, settings.gradle, *.sln, CODEOWNERS paths | pre-edit overlap logic (same-unit = warn, cross-unit = quiet); roster grouping; diary scope suggestions | new logic in existing surfaces |
| `generated` | .gitignore + conventional names (dist, build, target, .next, coverage, __generated__), codegen outputs below | pre-edit skips the claim; `blame`/`files` filter the noise; edit history stays smaller | hook exists, add filter |
| `hot` | lockfiles present (bun.lock, pnpm-lock.yaml, Cargo.lock, poetry.lock, uv.lock, go.sum), root manifests, schema files, CODEOWNERS-protected paths | pre-edit escalates: warns even with no live claim, names who touched it last (`blame` data already exists) | hook exists, add tier |
| `sequenced` | prisma/migrations, alembic, rails db/migrate, django */migrations, flyway | pre-edit on file CREATE: "akari added a file here 20 min ago — renumber before you commit" | new check in existing hook |
| `checks` | package.json scripts, Makefile / justfile / Taskfile targets, Cargo (`cargo test`), pyproject (`pytest`), go.mod (`go test ./...`) | session-start block and `breaks`/`needs` advice can name the real commands; `testScoped` is what the testPolicy warning offers | new, small |
| `testPolicy` | asked (Q3), default scoped-only when a scoped form exists | pre-bash: full-suite command → warning naming `checks.testScoped`. Same shape as the existing poll-loop guard, warn not deny | hook exists, add pattern |
| `codegen` | prisma/, *.proto + buf.gen, openapi.{yml,json} + generator configs, graphql codegen.yml | `where` and turn-end: source newer than artifact → "schema edited, client not regenerated — run X". Mirrors `driftFromInstalled`, which is this exact check for crew's own code | new, pattern exists |
| `tunables` | asked (Q1/Q2), repo activity | `core/config.ts` merge | P0 |

Detection is per format, not per ecosystem hardcode: each detector is a small
pure function `(files at root) → partial config`, and unknown ecosystems
simply yield less. A monorepo detector that finds nothing writes no `units`
key — absence of a key means "no boundary known", never "no boundary".

## The other two files init writes

**The CLAUDE.md block**, between `<!-- crew:init:begin/end -->` markers,
generated from one template: the "you are one of N agents" headline; the three
git rules verbatim (never stash / stage explicit paths / `EnterWorktree` with
its authorization line, git repos only); the two crew habits (`board` before
large work, `note --scope`); the peer-naming rule; and — new value from the
schema — the repo's own commands: "test one file: `bun test {path}`". This
repo's hand-written section becomes a generated block too, so template and
practice cannot drift.

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
`--yes`); agents and scripts get deterministic defaults.

## Design decisions

**Why `<root>/.claude/crew.json`, committed.** `<root>` is the MAIN working
tree (`RepoContext.root`), shared by every worktree — one file governs all of
them even when a worktree is pinned to a commit that lacks it. Committed,
because the shape of the repo is team knowledge, not personal preference.

**Read on hook paths, so it must degrade.** Same contract as `core/config.ts`:
missing, unreadable or malformed → that key's absence, per field, never a
throw. A typo in `hot` must not take an edit down with it.

**Warnings, not walls.** Every new consumer warns and names the alternative.
The poll-loop guard denies because the denied thing is strictly wasteful; a
full-suite run or a hot-file edit is sometimes right, so those surface a
warning the agent can override by proceeding.

**Idempotent by markers and by keys.** Re-running init re-derives, shows a
diff against the existing crew.json, and replaces the CLAUDE.md marker block
in place. Hand-added keys survive; a markerless hand-written CLAUDE.md
section is reported, never edited.

## Phases

### P0 — config layer
- [ ] `core/crewfile.ts`: schema, parse, per-field validation, cache keyed by
      root. `tunables` merges into `loadConfig` (DEFAULTS ← global ← repo).
- [ ] Tests: malformed file → empty shape; one bad key does not drop the rest;
      tunables merge order.

### P1 — the verb, read-only
- [ ] Row in `core/verbs.ts` (enforced by verbs.test.ts): audience `human`,
      group `presence`.
- [ ] New family `cli/init.ts` in `COMMAND_FAMILIES`; detectors in
      `core/detect/` as pure functions over the file list.
- [ ] `crew init --check`: prints the derived crew.json, the install state
      (`installedVersion`, `driftFromInstalled`, shim on PATH), and which of
      the three files exist. Exit 1 when something is missing, so it gates CI.

### P2 — cheap consumers, existing hooks
- [ ] pre-edit: skip claims on `generated`; escalate on `hot` with last-touch
      from existing edit history.
- [ ] pre-bash: `testPolicy` warning naming `checks.testScoped`.
- [ ] Tests beside the hooks' existing suites.

### P3 — init writes
- [ ] crew.json (only keys with shipped consumers), CLAUDE.md block from the
      template, settings.json `worktree.baseRef`. Golden test pins the block;
      idempotency test pins re-run behaviour.
- [ ] This repo runs `crew init` on itself; the hand-written CLAUDE.md section
      is replaced by the generated block.

### P4 — structural consumers
- [ ] `units` in overlap logic and roster grouping.
- [ ] `sequenced` create-collision warning.
- [ ] `codegen` drift in `where` and turn-end.

### P5 — docs
- [ ] README "Init a repo" section; operating.md config table gains the repo
      file and merge order; plans/README.md row re-measured against code.

## Open questions

- This repo's CLAUDE.md names `.claude/settings.json` with
  `worktree.baseRef: "head"`, but no such file exists in the tree. Resolve
  what is true before init claims to check or write it.
- CODEOWNERS as a `units`/`hot` source is listed but unranked: it encodes
  human review boundaries, which are usually — not always — the right
  coordination boundaries. Decide with a real CODEOWNERS in front of us.
- Whether `checks` should also feed a `crew check <path>` verb (crew running
  the scoped test itself) is deliberately out of scope: crew observes and
  advises; it does not become a task runner.
