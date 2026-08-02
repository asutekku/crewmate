# Worktree base staleness: say it at the start, not after the confusion

*Created: 2026-08-02*

An agent in a worktree planned against code its checkout did not have, caught it
itself after five tool calls, and only then synced. The presence tool already
knows which worktree every session is in. It should say something.

Status legend: **[ ]** not started · **[~]** partial · **[x]** shipped and
verified against the code, not against this document.

---

## What actually happened

akira (the old-core-retirement agent) opened a turn to plan pad ownership,
read the log, and found presence-tool commits where its own road-core commits
should have been. Its own words:

> My work is not on this branch. `9cecfd3` is not an ancestor of HEAD — the two
> merges from master moved this worktree onto a line that doesn't contain the
> seam commits.

Then: *"this worktree's branch is 47 commits behind it with nothing of its own"*,
and it synced before planning further.

**Read the reflog before believing that diagnosis.** `git reflog` in that
worktree shows 14 real commits — `ebc2135 feat(net): one alignment per stroke
CHAIN`, `3e36ff9 refactor(city): delete buildGraph`, and the rest — followed by
`e99bf3d merge master: Merge made by the 'ort' strategy` and `0d3ddba merge
master: Fast-forward`. And `git merge-base --is-ancestor 9cecfd3 master` says
**YES**.

So the work was never lost. It landed on master, and the worktree then
fast-forwarded onto master's tip, which is why `git log` showed presence commits
at the top: master's most recent commits are mine, not akira's. The worktree
today reads `behind=0 ahead=0`.

**This matters for the design.** The bug being solved is not "work disappears".
It is that **a checkout's relationship to master is invisible until an agent goes
looking**, and the natural way to look — `git log` — shows the newest commits,
which after a merge are somebody else's. akira spent five tool calls
(`git log`, `git log --oneline`, a merge-base check, two more) reconstructing a
fact that costs 123 ms to compute. It reached the right answer by a
correct-but-alarming route, and the alarm is the cost.

## The measurement

All 42 worktrees, `2026-08-02`:

| Band | Count |
|---|---|
| `behind=0` (in sync) | 15 |
| behind 1–99 | 2 |
| behind 100–399 | 9 |
| behind 400+ | 16 |

Worst: `ground-refactor` at **845 behind**. Five carry unmerged work:
`incremental-render` (+51), `industry-demand` (+4), `net-driving-behaviours`
(+2), `hopeful-wilson` (+1), `render-owner-scopes` (+1).

**Most stale worktrees are abandoned, and that is the trap.** Warning on all 27
would be 27 notices about checkouts nobody is in. The signal is only worth
printing to **the session that is actually sitting in that worktree**, which is
the one thing the presence db knows and `git` does not.

`git rev-list --count HEAD..master` from inside a worktree: **123 ms**, and
`master` resolves fine from any worktree (verified — no `--git-dir` juggling).

---

## P0 — tell a session where its checkout stands, at SessionStart  **[x]**

*Shipped 2026-08-02. Verified by driving the installed hook in three real
worktrees (845-behind, 298-behind-with-51-of-its-own, and the main tree), not
against this document.*

`session-start.ts` already resolves `worktreeRoot(cwd)` and `currentBranch(cwd)`
and registers both. It has the cwd in hand and pays a `git rev-parse` there
already. One more `rev-list --count` is 123 ms on a hook that runs once.

The line only appears when there is something to say:

```
This worktree is 47 commits behind master (nothing of its own yet).
  `git merge master` before planning — master moved under you.
```

and for a worktree with work on it:

```
This worktree is 298 behind master, with 51 commits of its own.
  Plan against what is HERE, not what master has.
```

**The second phrasing is the load-bearing one.** With unmerged commits, "just
merge" is wrong advice — merging is a decision with conflict cost, and CLAUDE.md
already forbids the dangerous ways out of it. The hook states the fact and stops.

### Rules that keep it quiet

- **Silent in the main tree.** The main tree IS master; a count there is noise.
  Gate on `worktreeRoot(cwd) !== mainTree`, which `resolveProject` already knows.
- **Silent at `behind=0`.** 15 of 42 today. A hook that speaks when there is
  nothing wrong is one that gets scrolled past — the same reasoning that keeps
  `planLinkLine` quiet on an already-linked item.
- **Never suggests a command that could eat another agent's work.** `merge` only,
  and only when `ahead=0`. Never `rebase`, never `reset`, never `checkout` —
  CLAUDE.md rule 5 rules those out and a hook that prints one is worse than a hook
  that prints nothing.
- **A threshold, not a trickle.** Below ~10 behind, a worktree taken this morning
  is normally fine. Ship at a constant (`STALE_COMMITS = 10`) so it is one edit to
  move.

- [x] `baseDistance(cwd, base)` in `core/repo.ts`, returning `{behind, ahead}` or null
- [x] a line at SessionStart, gated on worktree ≠ main tree and `behind >= 10`
- [x] phrasing splits on `ahead > 0` — states the fact, suggests nothing
- [x] test: main tree is silent; `behind=0` is silent; `ahead>0` gets no merge advice

**Two things the plan did not anticipate.**

`baseBranch` had to be discovered rather than assumed. The hook is installed
user-wide, so `master` is not a given — and `origin/HEAD`, the obvious source,
is **unset in this very repo**. The fallback probe (`master`/`main`/`trunk`)
turned out to be the load-bearing path, not the safety net.

A null distance is not zero. `baseDistance` returns null for an unresolvable
base or a git that refuses, because `behind = 0` is the value that means *"you
are fine"* and an unmeasured checkout must never claim it. Same reason the
cached column defaults to -1 rather than 0.

---

## P1 — `cli.ts where` reports it too  **[x]**

*Shipped 2026-08-02.*

`where` already prints repo, worktree and branch. It is the verb an agent reaches
for when it is confused about its checkout — which is exactly akira's situation —
and it currently answers three quarters of the question.

Same numbers, no new machinery:

```
repo:     Traffic
worktree: .claude/worktrees/old-core-retirement
branch:   worktree-old-core-retirement
base:     47 behind master, 0 of its own
```

**No threshold here.** `where` was asked a direct question, and a verb that
withholds a fact because it judged it small is a verb that has to be
double-checked. The threshold exists to protect *unsolicited* output.

- [x] `where` prints the base line, unconditionally
- [x] test: the numbers match `git rev-list --count`, not a re-derivation

**One narrowing, found by looking at the output.** In the main tree on `master`,
`base: up to date with master` sits under `branch: master` and compares the base
against itself — a line that says nothing. It is now suppressed when the checkout
IS the base. A main tree on some *other* branch still gets a real answer, so the
gate is "is this comparison trivial", not "am I in a worktree".

---

## P2 — the roster names a stale peer's checkout  **[x]**

*Shipped 2026-08-02. The cached column earned its place — see below.*

`formatRoster` already flags a peer in a different worktree
(`[worktree old-core-retirement] on worktree-…`). What it cannot say is whether
that checkout is *current*, which changes how much a peer's finding is worth: a
claim about `src/net/` from a checkout 845 commits behind is about code that no
longer exists.

Cost is the problem, not value. Roster formatting runs on the per-turn path and
this is one subprocess **per peer** — the exact shape `worktreeRoot` was cached
to avoid (157 ms → 106 ms on pre-edit, recorded in `repo.ts`).

So: **cache it on the session row**, written by the hooks that already run
git — SessionStart and CwdChanged — and read by the roster for free. It goes
stale between writes, which is acceptable for a hint and not acceptable for
`where` (hence P1 computing live).

- [x] `behind_base` + `base_branch` on `sessions`, via `addColumnIfMissing`
- [x] written at SessionStart and CwdChanged; read by `formatRoster`
- [x] shown only past the same threshold, and only for a peer elsewhere
- [x] test: a legacy db without the columns still opens, and its row survives

**-1, never 0.** The column defaults to -1 for "not measured", because 0 means
*in sync* and an unmeasured checkout reading as current is the one wrong answer
this column can give. The roster renders nothing at -1.

**The last checkbox changed.** "Assert the roster spawns nothing" would have
tested the absence of a call, which passes just as well when the feature is not
wired at all. The legacy-db test is the one that catches a real, already-shipped
failure: a fresh db builds `sessions` WITH the columns, so every test passes
while every live db throws `no such column`. Verified to fail with the migration
removed.

---

## Deliberately rejected

**Auto-merging.** The obvious automation and the wrong one. A merge can conflict,
and a hook that resolves conflicts unattended in a tree three other agents are
working in is a way to lose work silently. CLAUDE.md's commit rules exist because
this has nearly happened. The tool reports; the agent decides.

**Warning on every stale worktree.** 27 of 42 are stale and most are abandoned.
The value comes from scoping the warning to the session actually in that
checkout — the one join a bare `git` command cannot make.

**A "sync your worktree" nudge on the idle path.** The stale-item nudge earns its
place because a forgotten work item is invisible. Base staleness is not: it is one
command away, and P0 puts it in front of the agent at the moment it matters.

**Comparing against `origin/master`.** `.claude/settings.json` sets
`worktree.baseRef: "head"`, so worktrees branch from local HEAD and local master
is the honest base. Fetching in a hook also puts the network on the session-start
path.

---

## Order

P0 alone would have saved akira its five tool calls, and it is the only one that
reaches an agent that has not thought to ask. P1 is small and independent. P2 is
the one with a real cost question, so it goes last — and if the cached column
looks like drift-in-waiting when it comes to be written, that is a reason to drop
it rather than to build it carefully.
