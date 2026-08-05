# Handover — crewmates, 2026-08-05

Read this first, then delete it. It is a note between two conversations, not
documentation: everything durable is in `README.md`, `docs/`, and 92 commit
messages.

## Do this first

```sh
crew call-me hopper
```

The name pool has 280 given names and `hopper` is not one of them — it has
always been a hand-chosen alias. This project's ledger was deliberately emptied
when the previous session ended, so the name is free and unclaimed. Take it
before anything else, because peers and the diary key on what you are called.

Then, so the next agent inherits context rather than archaeology:

```sh
crew doing "<what you are working on>" --plan "step a; step b"
```

## Where things stand

The tool was extracted from a game repo (`I:\Projects\Traffic`,
`.claude/hooks/presence/`) into this repo today, with its history intact.
It is called **crewmates**; the command is **`crew`**.

Shipped and verified: the injection envelope, obligations, decisions (P4), the
work board with derived agent state, `crew who` grouped by worktree with overlap
warnings, release scaffolding, and the extraction itself. `bun test` is 1079
passing; `bun run typecheck` is clean.

**P5 is scoped but not built.** `plans/COURT_PLAN.md` has the section: tales are
one nullable column plus `crew tale <id>`; domain experience is deferred behind
a trigger that fails today. The honest caveat is written into the plan — two
supersessions across 54 entries is thin evidence anyone wants the chain
rendered.

## Two things that are wrong and that I did not fix

**The diary did not come with the move.** 54 findings about this tool live in
Traffic's database, keyed to that project — the CRLF trap, `PRESENCE_TEST_DB`
freezing at import, the transcript-slug bug, and about twenty more. A session in
this repo starts with none of them. That is the `--scope` mechanism failing for
its own author's findings, which is a genuine defect and not merely an
inconvenience. 32 of the 54 are scoped to the tool and would qualify for
migration. The user was offered this and the conversation ended before
deciding, so **ask before doing it**.

**The old copy still exists** at `I:\Projects\Traffic\.claude\hooks\presence\`.
It is now a stale duplicate. It was left in place because
`plans/CODE_QUALITY_AUDIT_ROUND2_2026-08-05.md` inside it is another agent's
untracked, in-flight audit of this tool, and deleting the folder would destroy
their work mid-review. Removing it is the user's call once that lands.

## How this repo differs from the one it left

Three dependencies on the host repo were invisible until the move, and each
would bite anyone vendoring this elsewhere:

- **`@types/bun`** was resolved from the host's `node_modules`. Now a real
  devDependency; `bun.lock` is committed.
- **`.gitattributes` pins `eol=lf`.** `test/court-v2.test.ts` verifies a frozen
  SHA-256 over `plans/court-audit/rubric-v2.md`. The blob is LF and correct, but
  `core.autocrlf=true` rewrites it to CRLF on checkout and the hash moves. Any
  future frozen-content check has the same exposure.
- **`install.ts` skips `node_modules`.** It walked every directory but `test`,
  so the first standalone install deployed 236 files instead of 74.

## Working habits that earned their place

- **Drive the real thing.** Every fix this session was verified against live
  data or the deployed build, not only tests. That is how the transcript-slug
  bug surfaced — a function that had never resolved on any platform, silently,
  because a missing directory reads as "no conversations".
- **Mutation-test the guard.** Inject the old bug, confirm the tests go red,
  restore byte-identical. Twice this session a green suite was blind to the
  defect it supposedly covered, and once a test asserted the *wrong mechanism*
  and passed because the right source was never consulted.
- **A number in a comment must be measured.** Thresholds here cite real
  distributions (`p95 of 307 hook gaps`, `40 of 56 messages`). Do not add one
  you did not measure.
- **Never invent a state the data cannot support.** Two review rounds proposed a
  `stalled` column with an exit code and a failing test name. Nothing records
  either. A board is worse than useless if you act on its most alarming cell and
  it was fabricated.

## The user

Prefers a plan before code, and measures before designing. Says so plainly when
a proposal is over-engineered — "KISS", "I think we have already overcomplicated
this feature a little bit lol" — and that feedback has been right every time.
Wants ASD-STE100 Simplified Technical English in conversation (see the game
repo's `CLAUDE.md`; this repo has no equivalent yet, which may be worth fixing).

There is an open thread: the user said "i have some other ideas too after that"
and then asked about moving here. Ask what those were.
