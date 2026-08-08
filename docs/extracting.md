# How this repo was extracted

[← README](../README.md)

Crewmates was developed inside a game repo at `.claude/hooks/presence/` and moved out on 2026-08-05 with its history:

```sh
git subtree split --prefix=.claude/hooks/presence -b crewmate-export
git clone --branch crewmate-export --single-branch <game-repo> crewmate
```

90 commits came across, back to the first. `subtree split` is slow — several minutes here, because it walks every commit in the host history rather than only those touching the prefix. `git filter-repo --subdirectory-filter` is much faster but must be run against a *clone*: it rewrites history in place.

## What the host repo had been providing

Three dependencies were invisible until the tool stood alone. They are recorded because each would bite anyone vendoring this back into another repo.

- **Types.** `tsconfig.json` declares `"types": ["bun"]` and had been resolving it from the host's `node_modules`. Now a real devDependency.
- **Line endings.** `test/court-v2.test.ts` verifies a frozen SHA-256 over `plans/court-audit/rubric-v2.md`. The stored blob is LF; with `core.autocrlf=true` checkout rewrote 242 lines to CRLF and the hash moved. `.gitattributes` now pins `eol=lf`. Any frozen-content check has this exposure.
- **`node_modules` in the deploy.** `install.ts` walked every directory except `test`, so the first standalone install copied 236 files instead of 74.

## What was left behind, on purpose

The pre-extraction copy still exists at `I:\Projects\Traffic\.claude\hooks\presence\`. It is a stale duplicate and it should eventually go.

It was left in place because `plans/CODE_QUALITY_AUDIT_ROUND2_2026-08-05.md` *inside it* is another agent's untracked, in-flight audit of this tool. Deleting the folder would destroy that work mid-review. Removing it is the user's call once the audit lands — check that file is finished or copied across before anyone deletes the directory.

Two findings from the extraction did not come across either: see `plans/DIARY_PLAN.md` on the 54 diary entries still keyed to the host project.

## What did not change

The store stays at `~/.claude/agent-presence/`. `dbPath` derives from the *project's* git-common-dir and that base directory — never from where this source lives — so every existing database survived the move untouched. Renaming the directory to match the project would orphan them all, which is why the mismatch is deliberate.

Hooks in `~/.claude/settings.json` point at `~/.claude/agent-presence/bin/`, so running agents were never affected either. Only `install.ts` cares where the source is.
