# Extracting this into its own repo

[← README](../README.md)

Crewmates lives at `.claude/hooks/presence/` inside a game repo. It has no
dependency on that repo — `install.ts` copies it to `~/.claude/agent-presence/`
and it runs from there — so moving it out is a history problem, not a code one.

## What is worth preserving

89 commits, 2026-07-30 to 2026-08-05, one author. Most carry the measurement
that motivated the change, which is the part a fresh `git init` would throw
away. Extract with history rather than starting clean.

## The command

```sh
git subtree split --prefix=.claude/hooks/presence -b crewmates-main
```

**It is slow.** Measured 2026-08-05: over two minutes on this repo without
finishing, because `subtree split` walks every commit in the whole history, not
only the ones that touched the prefix. Run it detached and let it finish, or use
`git filter-repo --subdirectory-filter .claude/hooks/presence` on a *clone*,
which is far faster but needs installing. Do not run `filter-repo` against the
working repo: it rewrites history in place.

Then:

```sh
git clone . ../crewmates -b crewmates-main   # or push the branch to a new remote
cd ../crewmates
bun install.ts                                # re-point the installed copy
bun test                                      # 1076 tests, ~25 s
```

## What must change after the move

- **`README.md` install paths.** They say `bun .claude/hooks/presence/install.ts`,
  which is correct only from inside the game repo.
- **`CLAUDE.md` in the game repo** keeps its `crew` coordination section — the
  tool is still installed user-wide and still used there. Nothing to remove.
- **The data directory stays `~/.claude/agent-presence/`.** Renaming it to match
  the project would orphan every existing database, and that store is live state
  several sessions write to. It is a deliberate mismatch, not an oversight.

## What does NOT come along

`plans/` and `ideas/` are working notes tied to this repo's development, and
`test/tools/` holds one-off generators. Decide per file; nothing in `core/`,
`cli/` or `hooks/` depends on any of them.
