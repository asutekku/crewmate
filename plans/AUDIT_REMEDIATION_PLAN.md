# Audit remediation — what the verb audit turned up

*Created: 2026-08-05*

Every verb in `core/verbs.ts` was run against a live two-agent roster on
2026-08-05 and its real output captured into [docs/audiences.md](../docs/audiences.md).
The captures were then reviewed by a second model, and that review was verified
against the source here. This plan is what fell out: confirmed code defects
(P1), documentation defects (P2), a regeneration strategy (P3), absent features
(P4), and a taxonomy correction (P5) — plus one framing failure in the audit
document itself.

**No summary counts appear in this header, deliberately.** The first draft said
"4 confirmed code defects" against a P1 section listing six, and "11 absent
features" against a P4 listing twelve — reproducing the exact 33-vs-51 drift
this plan exists to remediate, inside the remediation plan, within one day of
documenting it. Hand-maintained counts in this repo have a **100% measured drift
rate** (three instances: `core/verbs.ts:7`, `docs/audiences.md`, and this file).
Count the section headings; do not trust a prose total. P4-11 proposes the
general fix.

Status: **implemented.** P0-D1 and P0-D2 were confirmed and built; P1 (all ten),
P2, P3, P4 and P5 have shipped. Typecheck clean, **1195 tests passing, 0
failing**, 55 verbs.

**The tests were written against this plan, not against the code.** Several
started red and stayed red until their feature landed —
`test/audit-remediation.test.ts`, `test/audit-p1-2.test.ts`,
`test/audit-p1-3.test.ts`, `test/audit-p2-docs.test.ts`, `test/audiences.test.ts`.
That is the discipline the D1 failure argued for: an implementation-shaped test
would have asserted "`answer` calls `fulfil`" and passed against a build where
answering was impossible.

**P4-4, P4-7, P4-8 and P4-12 have since shipped too**, verified live:

| Was | Is |
|---|---|
| `expire` an event nothing fired; `--until` opaque prose | `--until 4h\|30m\|2d` records a `deadline` trigger; `expireDue()` fires it at session start |
| no backup path; the mitigation was "copy the file `where` prints" | `crew export [path]` copies the db **and its write-ahead log** |
| `crew clear` wiped the roster with no warning | bare `clear` lists the sessions and claim counts that would go, then stops; `--force` performs it |
| `crew quit <live peer>` dropped a working agent silently | refuses and names the pid; `--force` overrides |
| `--plan-doc` documented nowhere | `docs/views.md` has the `--plan-doc` vs `link` table |

Measured on the live roster: `crew clear` reported it would drop 41 claims
across two agents rather than doing it, and `crew quit hopper` refused with
`hopper is running (pid 70668) — \`--force\` to deregister anyway`.

**Only P4-6 (rename semantics) is deliberately left.** It belongs to
`plans/RELEASE_PLAN.md`, whose `crew release` verb is the mechanism that would
answer it, and building half of it here would collide with that plan's owner.

> **A note on reading the suite while peers are working.** Consecutive full runs
> of identical code produced 0, 11, 24, 55 and 81 failures while another agent
> ran the same suite, then 1210 pass / 0 fail three times in a row once it
> stopped. Individual suites always passed alone. The tests seed sqlite stores
> under one shared tmpdir and two runs collide. **Check `crew who` and re-run
> before believing a failure count.** Filed as diary `#19`.

## The framing failure, first

`docs/audiences.md` opens with *"Every output below is real … Nothing is
illustrative."* Each block is real. **The document is not a single run** —
blocks were captured as the audit proceeded and then arranged by topic, so a
reader cross-checking blocks against each other derives a state that never
existed.

This is not cosmetic, and the measurement is the point. A reviewer applying
exactly the scrutiny the document invites derived **two defects that do not
exist**:

| Inferred defect | Reality |
|---|---|
| `crew log` filters to turn-end summaries, hiding messages | No filter exists. `cli/messaging.ts:30-45` — `--raw` only switches name rendering (`operatorNames` vs raw). The capture showed no messages because none existed *yet*. |
| `crew plans` drops linked items, or filters to `plans/` paths | Neither. `plans` now shows `docs/audiences.md closed · 1/1`. It was absent because `plans` ran *before* `link`. |

A document that makes a motivated close reader hallucinate a kind filter in
`cli/messaging.ts` will do the same to the next agent that reads it as
onboarding material. **The re-run is a retraction, not polish** — see P3.

The same reordering broke the one place a block is cited as cross-verification:
the prose claims `stats` proves the `ask`/`asks` split, but the quoted `stats`
block predates the obligations *and* its `…` truncation cut the two rows
(`questions`, `obligations`) the sentence depends on. Both rows are real and the
bug is real — the evidence as printed does not show it.

---

## P0 — decisions that block the re-run

Neither is a code change. Both must be settled before P3, because the re-run
freezes whichever answer is in place.

**Both carry a recommended branch, reached during review.** The ask is
confirm-or-override, not open-ended: the reasoning is recorded here so that
overriding is a one-line decision rather than a re-derivation.

### P0-D1 — `ask`/`answer`/`asks`: fix, or capture as a known bug?

The primary Q&A loop is dead, and this is the highest-cost defect in the audit.

- `ask` writes an **obligation** (uuid) via `structured()` — `cli/obligations.ts`
- `asks` reads `store.questions.openSnapshot()` — `cli/questions.ts:72-82`
- `answer` requires an **integer** `questions` id

Measured: 5 obligations, 0 rows in `questions`. So `crew asks` reports "No open
questions" with three outstanding, and `crew answer <uuid>` fails
`✗ question id must be an integer`. The peer answered over `msg` instead.

**It is worse than a dead verb.** `hooks/prompt-submit.ts:80` appends
`Answer with \`crew answer <id> "<text>"\`, or say why not.` — a hook that
instructs agents to run a command that **cannot succeed** against an
`ask`-created question. Until this is resolved the injection is actively
harmful: it burns an agent turn on a guaranteed failure.

The two collapse directions are **not equivalent**, and the first draft flattened
them into one bullet. Stated separately:

- **(a-i) RECOMMENDED — collapse onto obligations; let `questions` die.**
  `asks` and `answer` read the obligation ledger. The `questions` table has held
  **zero rows across the tool's entire measured life** (`stats` reports
  `questions 0 (no rows across 2 exposed session opportunities)`), so nothing is
  lost by retiring it, and obligations already carry the state machine a Q&A
  loop needs. `answer <id>` takes a git-style uuid prefix and files
  `fulfil --resolution "<text>"`, an event `core/obligations.ts:123` already
  supports. This also means one ledger rather than two, which P4-2 has to
  enumerate anyway.
- **(a-ii) Collapse onto `questions`** — `ask` writes the `questions` row.
  Cheaper in isolation, but it splits Q&A away from the obligation ledger
  permanently: `asks` would then be the one coordination surface P4-2's
  `crew obligations` cannot show, and the `fulfil`/`violate` vocabulary would
  not apply to questions.
- **(b) Document as a known bug** and suppress the `hooks/prompt-submit.ts:80`
  line until fixed. Acceptable only if (a-i) is deferred — the hook must stop
  advertising a dead path either way.

Acceptance test for either collapse: `ask` → peer's `asks` shows it → peer's
`answer <id>` succeeds → asker's `asks` shows it answered. **Today zero of the
four links hold.**

What is **not** acceptable is re-capturing the same broken exchange and
presenting it as incidental a second time.

### P0-D2 — is `who --raw` inside the agent contract?

`docs/views.md` states the conversation title and the Haiku `doing:` line
"**never enter any agent's context** … Both are for you, not for the agents."

But `docs/audiences.md` closes by telling agents that shelling out to `who`
without `--raw` "gets a view designed for a terminal window it does not have" —
which has exactly one actionable reading: *agents should use `--raw`*. And
`who --raw` prints both fields.

Pick one:

- **(a) Strip title and `doing:` from `--raw`** — the fields become genuinely
  human-only and the `views.md` claim becomes true as written. **Not
  recommended:** `--raw` exists for piping, and the title is the natural grep
  key when doing so; stripping it makes the machine-readable format strictly
  less useful than the human one. It also creates a second surface pair that can
  drift apart — precisely the `who`/`board` failure in P1-1.
- **(b) RECOMMENDED — amend `views.md`** to "never enter any agent's
  **injection**", and drop the `docs/audiences.md` sentence steering agents to
  `--raw`. The claim being defended is about the *injection budget* (those
  fields are never spent on an agent's context), not about a field an agent may
  read on request. While amending, label the `doing:` line's epistemics:
  it is **model-written from recent output, not agent-stated**, which is what a
  peer needs to know before acting on it.

The current pair is a contradiction, and it was ambiguous to a reviewer holding
the whole document — an agent has a one-line usage string.

---

## P1 — confirmed code defects

Each is verified against source, and each should land **before** the re-run so
the regenerated document does not enshrine it.

They are **not uniformly small.** P1-1, P1-4, P1-5, P1-6, P1-7 and P1-8 are
one-liners. P1-2 needs a display-format judgement. **P1-3 is a design decision**
— whether a beneficiary injects at all, at what priority, and rendered how —
and should not be scheduled as a quick fix.

> **SHIPPED 2026-08-05, verified against the live store.** All of P1
> (P1-1 … P1-10), **D1-(a-i)**, **D2-(b)**, P2-1/2/3, and P4-9. P1-9/P1-10 were
> built by `hopper` against the spec tests below. Measured after, not claimed
> from the diff:
>
> | Was | Is |
> |---|---|
> | `who` `○ at a prompt` vs `board` `○ gone` | both `◐ at a prompt`, glyphs from `STATE_GLYPHS` |
> | `JSON contains unsupported field text` | `… — JSON accepts acts, dependencies, idempotencyKey` |
> | `unknown obligation event discharge` | `… — expected one of: accept, decline, …, return` |
> | `nothing was omitted from your …` (for a peer) | `nothing was omitted from hopper's …` |
> | `withdrawn / active  v2` | `withdrawn  v2` |
> | `linked  <path> executing <path>` | `linked  <path> executing` |
> | `crew asks` → "No open questions" with 3 open | lists all three, `crew answer <prefix>` |
> | `crew answer <id> "<prose>"` → `unknown resolution key` | `fulfilled v2`, prose readable on readback |
> | `README.md` + `plans/README.md` both shown as `README.md` | colliding leaves disambiguated; contested paths stay full |
> | a promise invisible to its beneficiary after 45 min | injects at p60, `made to you; nothing owed` |
> | `crew clear --help` → `unknown flag --help` | prints usage; every one of the 51 verbs answers it |
> | `clear` blurb: "wipe the roster and message log" | "wipe the roster and claims; the message log is kept" |
> | `quit` blurb: "drop a **dead** session" | "drop a session off the roster; no liveness check" |
>
> Still pending: **P3** (the generated re-run) and **P4** minus P4-9, plus
> **P5** once P4 settles which cells are real.

#### The tests are written against the spec, not the implementation

`test/audit-remediation.test.ts`, `test/audit-p1-2.test.ts`,
`test/audit-p1-3.test.ts` and `test/audit-p2-docs.test.ts` assert what this plan
says the behaviour SHOULD be. Several were written **red** and stayed red until
their feature landed; the P4 ones are red now, on purpose.

That choice is not stylistic. An implementation-shaped test for D1 would have
asserted "`answer` calls `fulfil`" and passed against the broken build. The
spec-shaped test asserts **the answer is readable afterwards**, which is what a
user wants and what was actually broken.

It has already paid twice beyond that:

- The P1-2 spec was written expecting contested paths to be *disambiguated*.
  `layout.test.ts` already demanded something **stronger** — contested paths are
  never shortened at all, because the reader has to act on them. The existing
  spec won and the new test was corrected to match.
- The `--help` interception added a second `usageFor(` call site, which
  `cli-architecture.test.ts` forbids so that a verb's arguments are stated in
  one place. The fix was a shared `renderUsage` — a better shape than the one
  first written.

#### The collapse shipped broken, and the acceptance test is why that was caught

The first D1 landing passed links 1, 2 and 4 and **failed link 3**. It was
reported as done on the strength of link 2 alone.

The cause: `handleAnswer` passed the answer prose as `resolution`, which the
event builder routed into `resolutionKey` — a **controlled vocabulary**
validated against the obligation's `validResolutionKeys` (`core/obligations.ts`,
`fulfilled` case). `ask` writes `resolution_keys_json = []`, so *every*
`ask`-created question rejected *any* prose with `✗ unknown resolution key`.
The `fulfilled` event had no free-text field at all.

**Why the author could not catch it.** Authority is enforced: the asker does not
own the answer, so testing link 3 requires either a second agent or a
self-addressed question. The first landing did neither — it inferred the loop
from the half that was observable. hopper found it within the hour by running
the acceptance test as written.

Two lessons, both cheap:

1. **An acceptance test with a link the author structurally cannot run is not
   done until someone else runs it.** P3's fixture (a) exists for exactly this;
   this bug is the argument for it.
2. `evidenceMessageId` is **declared and never populated anywhere** — the field
   that looked like the obvious fix was itself unbuilt. Worth checking before
   any future design leans on it.

Fixed by giving `fulfilled` a free-text `resolution` beside the controlled
`resolutionKey`, adding `--resolution-key` for the latter, folding `resolution`
onto the snapshot (the CLI is barred from reading event history by
`test/cli-architecture.test.ts`, correctly), and making `readObligation`
prefix-tolerant so a copied 8-character id works everywhere it is printed.

### P1-1 — `○` means opposite things in the two flagship surfaces

| Surface | Source | `○` means |
|---|---|---|
| `who` | `cli/roster-renderers.ts:80` | **at a prompt** (live, idle) |
| `board` | `cli/work.ts:146`, legend `:419` | **gone** (no live session) |

An operator who learns `○` from `who` reads `board`'s `○` as a live idle agent —
the precise inversion of "who can I still reach". `board` additionally uses `◐`
for "at a prompt", which `who` does not use at all.

**Fix:** extract a shared legend constant consumed by both renderers, so the two
cannot diverge again. This is what makes it a one-liner rather than a recurring
bug.

### P1-2 — `who` displays basenames while contention is computed on full paths

- Display: `core/layout.ts:169` — `p.split("/").pop() ?? p`
- Contention: `cli/roster-model.ts:108-117` — keyed on the full `path`

Contention is **correct**; the display is ambiguous. `plans/README.md` and
`README.md` both render as `README.md`, so two agents in genuinely different
files appear to hold the same one.

Measured cost: this made the audit's own `breaks` narrative look
self-contradictory. `who` showed hopper holding `README.md` while `breaks`
reported "nobody else has been in your files" — reconcilable only by knowing
independently that hopper's file was `plans/README.md`. The reviewer lost a full
pass to it.

It also undermines the red-for-contested feature, which the docs describe as the
one signal that always means "look at this": red is only trustworthy if you can
tell *which* file is red.

**Fix:** full paths, or directory-disambiguated basenames when leaves collide.

### P1-3 — a promise never reaches its beneficiary

`core/obligations.ts:710-718` — `candidates()` selects only where
`mine(s.currentResponsible)`, i.e. responsibility is *assigned to the reader*.
A promise assigns responsibility to the **promisor**, so the beneficiary
structurally never matches.

Measured: `crew promise hopper "I will not edit plans/RELEASE_PLAN.md" --refrain
--until "the release lands"` created obligation `1bdb6708`. It was absent from
`crew injection --agent hopper` immediately and **still absent 45 minutes
later**, while the question, handoff and ask all injected at p105.

A promise the beneficiary never sees cannot be relied on, which is the entire
point of `promise`. Either the beneficiary gets a (non-actionable, lower
priority) candidate, or `promise` should say plainly that it records a
self-binding note and notifies nobody.

### P1-4 — `act`'s error names the wrong problem

`cli/structured-json.ts:31-38` — `allowed()` reports
`JSON contains unsupported field text`. But `text` **is** supported, inside
`acts[]`. The error is about top-level placement and does not say so.

For the one verb designed for structured atomic use, first-attempt failure is
near-certain until the error names the path (`$.text` vs `$.acts[n].text`).
Measured: the audit hit two consecutive failures on this verb —
`✗ path resolves outside the project root`, then this one — before succeeding.

### P1-5 — unknown obligation events do not list the valid ones

`✗ unknown obligation event discharge` sends the reader to
`core/obligations.ts:123` to learn the vocabulary. The list is a constant
(`accept decline counter withdraw cancel fulfil violate activate release expire
relinquish assign reassign return`) and belongs in the error.

### P1-6 — `inbox --agent <peer>` says "**your** session-start context"

`cli/injection.ts:86` — the template is not parameterised for the `--agent`
case, so inspecting a peer's inbox reports it as your own. Small, but it is the
attribution sloppiness the README's `human to traffic-c9` anecdote warns about.

### P1-7 — `withdrawn / active` is a display defect, not a state-machine bug

Checked, because the review could not tell which it was from the capture alone.
The two axes are genuinely orthogonal (`core/obligations.ts:19-22`):

```ts
export type AuthorityState =
  "proposed" | "binding" | "declined" | "countered" | "withdrawn" | "cancelled";
export type ActivationState =
  "waiting" | "active" | "fulfilled" | "released" | "violated" | "expired";
```

So `withdrawn / active` is correct-but-unreadable: authority reached a terminal
state while activation was never advanced. The model is sound; the rendering
implies a contradiction that is not there.

**Fix:** collapse the pair when authority is terminal (`withdrawn` alone), or
label the axes in output. The two-axis model should also be documented — it
appears nowhere outside the type definitions.

### P1-8 — `board --history` prints the plan path twice

`core/work.ts:563` stores the event detail as `` `executing ${path}` ``, and
`cli/work.ts:462` prefixes the path again when rendering, producing:

```
just now  linked   docs/audiences.md executing docs/audiences.md
```

One-liner: store the bare path, or render the stored detail without re-prefixing.

### P1-9 — `did`/`step` with no `--item` ticks an implicitly chosen item

Found by hopper 2026-08-05, twice, for real. `core/work.ts:492` calls
`store.work.target(agentId, "")`, which picks among open items implicitly. With
two items open it landed on the wrong one.

### P1-10 — a ticked step cannot be unticked

`tick()` sets `done_ms` (`core/work.ts:654`) and **nothing clears it**. `crew
step` writes a progress note but leaves the tick, so a correction renders
underneath a green check. The only recovery hopper found was editing `done_ms`
in sqlite directly.

**P1-9 and P1-10 compose into the plan's own failure mode**: an accidental tick
is both *silent* and *irreversible through the CLI*, so the board can assert
completed work that never happened. That is exactly the `[x] IMPLEMENTED`
problem `plans/README.md` opens with, reachable by typo rather than by
optimism. Filed as diary `#11` and `#12`.

Fix: `did`/`step` require `--item` when more than one item is open, and an
`undo`/`untick` path exists.

---

## P2 — documentation defects

### P2-1 — `clear`'s blast radius is wrong in both directions

`cli/admin.ts:88-97`. The verb table says "wipe the roster and message log".
The code deletes **sessions and claims only** and prints
`(Message log is kept; it self-prunes.)`

So the audit's Not-run rationale — "running it would have destroyed … the
message history quoted throughout this file" — is **partly false**, and the
review's inference that a `--help` probe might have been a wipe attempt is also
false: unknown flags abort at `cli/admin.ts:88` before any store work.

### P2-1a — resolved: failed `act` attempts do **not** consume message numbers

The review flagged a gap at structured message `#19` and asked whether failed
`act` invocations burn ids. Measured against the store:

```
id 17  say  CORRECTION: I said 33 verbs earlier; the table has 51
id 18  say  HAZARD: the doc index table gained a row; a stale rebase wil…
id 19  say  hopper here. Answering your question: no — RELEASE_PLAN.md d…
id 20  say  HAZARD: counts are not asserted by any test; re-derive after…
```

`#19` is **hopper's reply**, interleaved into the same sequence. Both `act`
failures aborted before insert. No defect; recorded so the question is not
re-opened. It is also a small argument for the P3 script: an audit doc that
numbered only its own messages made a peer's message look like a gap.

### P2-2 — "it self-prunes" is an undocumented retention policy

Measured: `core/store/messages.ts:78` deletes on **every insert**:

```sql
DELETE FROM messages WHERE id <= (SELECT MAX(id) - ? FROM messages)
```

with `MAX_MESSAGES = 2000` (`core/store/types.ts:50`).

It is a **2000-row ring buffer with no age component** — unlike every other
retention knob in `docs/operating.md` (`staleMs`, `claimTtlMs`, `workKeepMs`,
`editKeepMs`), all of which are time-based and documented in a table. A busy
repo silently loses a day of messages; a quiet one keeps them forever. Neither
behaviour is stated anywhere. Filed as diary `#7`.

**The consequence, which decides whether this should change.** Obligation
events are **permanent** (append-only fold, never pruned); the messages that
give them meaning are **evictable**. This plan already contains the failure
case: obligation `a2899def` was withdrawn with the reason *"answered over msg;
no action needed"* — a record whose justification lives only in a message that
will eventually be dropped, leaving a withdrawal citing evidence nobody can
retrieve.

The same holds for `correct` and `breaks`, whose whole purpose is answering
"who changed the baselines?" days later. **`log` is therefore not an audit
surface, even though the withdraw/correct/breaks flow treats it as one.**

Two coherent resolutions: make `MAX_MESSAGES` time-based like every other knob
(and document it in the `operating.md` table), or state plainly that the log is
ephemeral and stop routing durable justifications through it. The status quo —
permanent ledger citing evictable evidence — is the one option that cannot be
defended.

### P2-3 — `quit`'s description promises a liveness check it does not have

Verb table: "drop a **dead** session off the roster." There is no liveness check
— `crew quit hopper` deregisters a working peer mid-task. `docs/views.md` is
honest about this ("deregisters, it does not kill", and it explains at length
why liveness cannot be detected); the one-line blurb is not. See P4-8 for the
feature side.

---

## P3 — regenerate the audit document, as a script

> **SHIPPED.** Two generators, both idempotent — a second run is byte-identical,
> verified:
>
> - `test/tools/regen-audiences.ts` derives the audience tables from
>   `core/verbs.ts`. `test/audiences.test.ts` fails on drift — confirmed by
>   corrupting a count and watching it go red, because a guard that cannot fail
>   is not a guard.
> - `test/tools/capture-audiences.ts` runs 22 commands against a throwaway store
>   and writes the output. **Block order is execution order by construction**,
>   so F1 is now impossible rather than fixed-once.
>
> All four fixtures from the list above are seeded: a second registered session,
> a departed session with an open item (so `board` prints its resume handle —
> previously an unevidenced prose claim), a genuine `README.md` /
> `plans/README.md` collision, and work plus diary rows so the populated forms
> render. Temp paths normalise to `/tmp/project` so a regeneration diffs
> cleanly. Uncaptured verbs are **named** in the document — 34 of them mutate
> shared state or need a second live session — rather than silently skipped.
>
> **One thing went wrong, and the rule it produced is worth more than the
> incident.** While splicing in the markers, a rewrite by computed line ranges
> dropped ~800 lines of hand-captured output. The file was untracked, so there
> was no diff to recover from and `install.ts` does not deploy `docs/`. The
> captures are back, better, and generated — but the two rules stand:
>
> 1. **Check `git status` before a destructive edit.** An untracked file has no
>    undo.
> 2. **Never rewrite by computed line ranges without reading the slice being
>    discarded.** The arithmetic is exactly the kind of thing that looks right.
>
> Filed as diary `#16`, closed by `#17`.

**Not a manual re-run.** The re-run must be a Bun script that executes the
sequence and emits the captures.

Rationale: block order becomes execution order *by construction*, so the framing
failure above becomes **impossible rather than fixed-once**. A hand-collated
document can drift again the next time a verb is added; a generated one cannot.
It is also the only path to asserting the document's counts — see P4-11.

Requirements:

1. Executes every verb in `core/verbs.ts` in a defined order, emitting each
   capture with a **timestamp**, so even a partial regeneration stays self-dating.
2. Runs against a **scratch project with scripted fixtures**, not a live shared
   roster — the audit's destructive verbs (`clear`, `quit`) went uncaptured only
   because a real peer was working in the tree. See the fixture list below;
   without it this requirement trades the framing failure for a coverage
   failure.
3. Captures P1-3 deliberately as evidence: `promise` landing, then
   `injection --agent <beneficiary>` showing its absence. It is confirmed
   behaviour and belongs in the document as a demonstration, not as a finding
   about the document.
4. Whichever P0-D1 branch was chosen: either the working Q&A loop end to end, or
   an explicit known-bug section.
5. Runs claim-recording demonstrations (`--fixes`, and anything else that
   records an unverified assertion) **only against the scratch store**, labelled
   inline as demonstrations. The original prohibition — "does not re-file the
   `--fixes` demonstration" — contradicted this plan's own generalisation three
   paragraphs later; on a scratch store the demonstration is harmless and is
   exactly how `--fixes` gets captured. What must never happen is running one
   against the real store, which is what poisoned diary `#3`.

### Fixtures the script must create

The original document's credibility came from a **live roster**: hopper's
concurrent work is what made `who`, `board`, `files`, `blame`, `breaks` and
`injection --agent` show anything at all. A scratch project with one scripted
session regenerates a document where half the human surfaces are empty — a
different failure, not a fix.

| # | Fixture | Without it |
|---|---|---|
| a | A **second registered session** that edits files and sends messages | `who`, `board`, `files`, `blame`, `log`, `msg`, and every obligation verb render empty or single-agent |
| b | A **departed session with an open work item** | `quit`'s background-process report and `board`'s `claude --resume <uuid>` line stay **unevidenced** — both were flagged as unsupported prose in the review and would survive the retraction unproven |
| c | A **genuine full-path collision** (`README.md` + `plans/README.md`, two agents) | P1-2's fix cannot be shown working, and contested-red — the one signal docs say always means "look at this" — goes uncaptured |
| d | An **injection that actually exceeds budget** | In the entire original audit `inbox` never once showed a length omission. The interesting branch of that verb has **never been captured**, and P4-5's cap has nothing to demonstrate against |

Fixture (b) is the one most likely to be skipped and the most costly to skip:
it is the only way two claims the review called unevidenced become evidenced.

### The `--fixes` demonstration, and what it cost

During the audit `crew note "…corrected to 51" --fixes 1` was run to demonstrate
`--fixes`. **The fix was never made** — the audit ran under a no-code-changes
instruction, and `core/verbs.ts:7` still says 33.

The store had no way to distinguish the demonstration from a real fix, so note
`#3` asserted a correction that never happened, and would have surfaced as truth
to any agent editing `core/` via `hooks/pre-edit.ts`. It has since been
deprecated and the real bug refiled as `#6` (scope `core/` intact).

The generalisable finding: **`--fixes` records a claim, and nothing verifies it.**
A future `--fixes` could require the fixing commit, or the verb could stay
advisory and say so.

The procedural rule that follows is in P3 requirement 5: claim-recording
demonstrations run against the **scratch** store and are labelled inline. The
store cannot distinguish a demonstration from an assertion, so the isolation has
to come from where it is run, not from how it is captioned.

---

## P4 — absent features

Ranked by how often the gap is hit. Names are suggestions; the shapes are the
point.

### Operator read surfaces — the largest cluster

The pattern: **agent-write stores with no human read path.**

**P4-1 — `crew memories [--agent <name>] [--all-projects]`**

Every memory every agent holds about the operator. Today `about-me` is keyed to
the *calling* session's agent, so the only evidence a peer holds a memory about
you is a side effect of `inherit` refusing:

```
still held — ask them instead of inheriting
  hopper 1 memory
```

You are the subject of this data and cannot enumerate it. Pair with
`crew forget --agent <name> <id>`, so erasure is not gated on the agent being
alive — currently a dead agent's wrong memory about you is reachable only via
`inherit`, which *transfers* it rather than deleting it.

**MEASURED 2026-08-06, and the shape is narrower than the above.** Three
corrections, each run against the live store:

1. **The enumeration already exists and is unreachable.** `cli/personal.ts:132`
   lists every lineage holding memories about you — but only on the
   `!resolved` branch, which requires `context.sessionId` to be empty. Every
   live agent has one, so the branch never fires from a session. `crew about-me`
   as an agent prints `hopper has recorded nothing about you here.` and stops.
   The operator view is written, reachable only from a context that does not
   occur.
2. **`--agent <name>` works today**, including for departed lineages
   (`memorySubjectPolicy`, `cli/personal.ts:37-53`). `crew about-me --agent akari`
   returned akari's memory correctly. The gap is **discovery, not access**: you
   must already know the name. So P4-1 is largely a *routing* fix — expose the
   existing lineage list under a verb an agent can reach — not new machinery.
3. **`forget <id>` is ungated across agents, and this cost a real row.** No
   `--agent` flag is needed and none is offered: `crew forget 3` from hopper
   deleted *akari's* memory about the operator, unconfirmed, on a bare integer
   id shown by `about-me --agent`. Filed as diary `#9`.

That third point inverts the pairing above. The plan asks for
`forget --agent <name> <id>` so erasure is *not* gated on liveness. It already
is not gated — on anything. The verb needs a **gate before it needs a flag**:
ids are global, small, and printed beside another agent's memories, so the
natural next command after reading a peer's memory deletes it. Minimum:
`forget` requires the id to belong to the calling agent's lineage unless
`--agent <name>` names the holder explicitly.

**Revised P4-1 scope:** (a) reachable enumeration — `crew memories`, or make
`about-me` fall through to the lineage list when the caller holds none; (b) the
`forget` ownership gate; (c) `--agent` on `forget` as the explicit override.
Only (a) is a new surface; (b) is a correctness fix.

**P4-2 — `crew obligations [--agent <name>] [--open|--all]`, and `crew clearances`**

There is no way to enumerate the ledger. The only handles are by-uuid
`obligation` inspect (requires already having the uuid), `injection --agent`
(top-priority ones only), and `stats` (a bare row count). Neither operator nor
agent can answer "what is outstanding between these two."

**Unenumerable state is unusable state** — this blocks the whole obligations
feature, which is otherwise the most-built cluster in the tool.

**MEASURED 2026-08-06: the data layer is already done.**
`ObligationStore.all()` (`core/obligations.ts:661`) returns every obligation
folded to `{definition, snapshot}` — the exact shape a list view needs, already
used internally by `candidates()` at `:703`. `crew obligations` is therefore a
**renderer plus a verb row**, not a query. That moves it from "blocks the
cluster" to one of the cheapest items in P4, and it should be reordered
accordingly: the suggested order puts it at step 7, but nothing else in the
plan depends on it *and* it costs less than several one-liners above it.

**P4-3 — an audit-framed diary view**

`docs/audiences.md` says "You would read this only to audit" and then files the
diary under agent audience. Either add an operator view or state that
`recall`/`bugs`/`topics` are shared. The verbs exist; the surface statement does
not.

### Lifecycle rules the state machines imply but nothing fires

**P4-4 — obligation expiry**

`--until "the release lands"` is **opaque text**. `expire` exists as an event
(`core/obligations.ts:123`) and nothing ever fires it. Minimum viable: `--until`
optionally accepts a duration (`--until 4h`), and a sweep fires `expire` — on
any verb invocation, or an explicit `crew gc`.

**P4-5 — a cap on p105 injection**

`core/sessionBlock.ts:225` adds **every** candidate from
`store.obligations.candidates()`, and `core/obligations.ts:715-760` applies no
cap and no age term: each non-terminal obligation becomes a p105 candidate,
**above the roster (p90)**, indefinitely.

Measured: three obligations sat above hopper's roster 45 minutes after creation,
with no expiry path. A sloppy or adversarial peer can occupy a target's entire
injection budget.

Fix: top N by age, remainder folded into one `crew obligations for M more` line.
**This is the `inbox` pattern already built** — unapplied to the one priority
class that can crowd out everything else.

**P4-5a — state the trust model**

`msg`, `say`, obligation text and hazard text are **arbitrary strings written by
one agent and delivered into another's context** — at p105, *above* the roster
(`core/sessionBlock.ts:225`). The docs describe delivery mechanics in detail and
say nothing about trust.

P4-5 caps the **volume**; nothing addresses the **content**. For a tool whose
whole purpose is putting one agent's words into another's context window, and
which is otherwise explicit about advisory-versus-enforced, one paragraph
belongs in the docs: *peer messages and obligation text are untrusted input;
hooks label their origin (`requiresPeerFraming`, `origin: "peer"`) and nothing
sanitises their content.* The framing machinery already exists in
`core/obligations.ts:760` — it is the statement that is missing.

**P4-6 — rename semantics are unstated**

`call-me akari-audit` ran with 5 live obligations and in-flight messages
authored as `akari`. `stats` shows `aliases 2` and `name_owners 2`. Nothing
states: do obligations follow the session or the name? Does `msg akari` reach
`akari-audit`? Does `obligation` authority match on session id or name?

Given the Hopper→Akari rename bug that motivated `RELEASE_PLAN.md`, this is the
most consequential silence in the docs. Minimum: `call-me` prints the alias it
created. Better: `crew aliases` inspects the `aliases`/`name_owners` rows.

### Safety pairs for the destructive verbs

**P4-7 — `crew export [path]`, and `clear` confirmation**

An unconfirmed multi-agent wipe with no backup verb is the worst pairing in the
tool. Export is nearly free — copy the `.db` that `where` already prints.
`clear` should require `--force` or a confirmation.

Note the correction from P2-1: `clear` is **less** destructive than documented
(sessions and claims only), and unknown flags already abort. The confirmation is
still worth adding; the panic is not.

**P4-8 — `quit` liveness**

Either check the session pid before deregistering a *named* agent
(`crew quit hopper` on a live session → `hopper is running (pid N); --force to
deregister anyway`) or fix the description (P2-3). `docs/views.md` explains why
liveness cannot be reliably detected — which argues for the description fix, and
for surfacing the pid the way `who` already does for background processes.

**P4-9 — `--help` on every verb**

Measured across `who`, `log`, `board`, `note`, `doing`: **all** return
`✗ unknown flag --help`. Unknown flags do abort (`cli/admin.ts:88`), so probing
is safe *in fact* — but that safety is invisible at the prompt.

**The safest possible probe of a destructive verb is indistinguishable from a
trigger until after you have typed it.** The audit could not determine `clear`
was safe to probe without reading `cli/admin.ts`; an operator at a terminal has
neither the source nor the patience.

Fix: recognise `--help` on every verb and print `usageFor(verb)`, which
`core/verbs.ts` already generates. Filed as diary `#8`.

### Repairs that are really features

**P4-10 — the working Q&A loop** — see P0-D1. It is a feature, not a bugfix,
because today zero of the four links hold.

**P4-11 — tests for the generated document**

`test/verbs.test.ts` keeps `core/verbs.ts` honest against `cli.ts`. Nothing
keeps `docs/audiences.md` honest against `core/verbs.ts`. The `bun -e`
one-liner re-derives `51`; it **cannot** re-derive the audience split (38/10/3)
unless `core/verbs.ts` carries an `audience` field — it does not.

Proposal: add `audience: "agent" | "human" | "shared"` to the `Verb` interface,
generate the audience tables the way `usage()` is generated, and assert them in
`test/verbs.test.ts`. While there:

- a test that `crew log`'s default returns messages (guards against the
  hallucinated defect above becoming real)
- the shared glyph legend constant from P1-1

**P4-12 — `--plan-doc` is undocumented**

`help` shows `doing "<subject>" [--plan "a; b; c"] [--plan-doc <path>]`. The flag
appears nowhere else — not in `docs/`, not in the `link` discussion it overlaps
with. When does `--plan-doc` apply versus `link`?

---

## P5 — the taxonomy itself

> **RESOLVED via (b), and it is now type-enforced.** `VerbAudience` in
> `core/verbs.ts` declares four values and `audience` is a **required** field, so
> a new verb cannot be added without answering the question. The misfiled verbs
> moved: `about-me`, `forget`, `injection`, `inbox`, `obligation`, `clearance`
> and `diary` are `oversight`.
>
> Current split — derived, not counted by hand: **agent 32, human 10,
> oversight 7, shared 3**.
>
> The `oversight` row did the work argued for below: it made the missing
> operator surfaces show up as *absent cells* rather than as an unstated gap,
> which is what put `crew memories`, `crew obligations` and `crew clearances`
> (P4-1, P4-2) on the board as concrete verbs with a home to go to.
>
> `test/audiences.test.ts` additionally asserts `oversight` has more than two
> verbs — if everything oversight-shaped drifts back into `human`, the
> distinction stops earning its place and the gap becomes invisible again.

`docs/audiences.md` defines its split descriptively: "who is told a verb exists,
and who has a reason to run it." **By that definition the original table was
wrong on its own evidence.**

- **`about-me` / `forget`** — filed agent-only, but the operator is the *subject*
  of the data and has the strongest possible reason to read it. The document
  itself concedes the operator is told these exist. At minimum: **shared**.
- **`injection --agent` / `inbox --agent`** — the audit used
  `injection --agent hopper` as an *operator* verification tool. An agent
  inspecting a peer's context budget is the exotic case; the operator debugging
  "why did my agent not see X" is the common one. The `--agent` forms are
  operator-facing.
- **`obligation` / `clearance` bare inspectors, `asks`** — operator governance,
  currently reachable only by reading `docs/`.

There is also a **third exposure channel the taxonomy ignores**: verb output.
`doing` prints "*Peers see it with `crew board`*", advertising a human-audience
verb to agents in the most-used agent verb's output. `about-me` advertises
`--all-projects`; `remember` advertises `--global`. Both flags are absent from
the document entirely.

### Two resolutions

**(a) Move the misfiled verbs to `shared`.** Costs one row-count change and no
code. `shared` exists for exactly this.

**(b) Add an "oversight" audience.** The stronger argument. `shared` currently
means *symmetric* use — `msg`, `say`, `log`, where both parties do the same
thing. The memory/diary/ledger cluster is **asymmetric**: agent-write,
operator-audit. Collapsing it into `shared` hides the real gap, which is that
the operator has **no aggregate read surface** anywhere: no `crew memories`, no
obligations list, no audit-framed diary view.

An oversight row makes each missing verb visible as an **empty cell** — a
forcing function on the design rather than a documentation nicety. P4-1, P4-2
and P4-3 are exactly the cells it would leave blank.

**Not recommended: a permission model.** The "no `--agent-only` flag" stance is
right. Enforcement would break the property that a session can be impersonated
deliberately with `--from` when things go wrong, and every gap above is a *read
surface* or a *lifecycle rule*, not access control.

---

## Suggested order

1. **P0-D1, P0-D2** — confirm or override the recommended branches.
2. **P1-1, P1-4, P1-5, P1-6, P1-7, P1-8** — one-liners. Cheaper than
   documenting the defects they cause.
3. **P1-2, P1-3** — judgement calls: display format, and whether beneficiaries
   inject at all. P1-3 is a design decision, not a fix.
4. **P4-10 / P0-D1's chosen branch** — must land **here**, before P3. P3
   requirement 4 says the re-run captures either a working Q&A loop or an
   explicit known-bug section; if D1-(a-i) was confirmed, the rebuild is a
   prerequisite of the capture, not a follow-on feature. The first draft of this
   plan listed P4-10 at step 6 and contradicted its own P3.
5. **P2-1, P2-2, P2-3** — doc corrections, foldable into P3.
6. **P3** — the generated re-run, with fixtures. Everything above lands in it
   for free.
7. **P4 (remainder)** — features. If only three: **`memories`** (your data),
   **`obligations` list** (unblocks the whole cluster), **`export` +
   `clear --force`** (prevents an unrecoverable afternoon).
8. **P5** — taxonomy, once P4 has settled which cells are real.

**Ordering stops mattering after step 6, and that is the point of P3.** Once the
document is generated by a script, regeneration is cheap: every remaining P4
item can land in any order and the document re-derives itself, with block order
equal to execution order by construction. The sequencing above is load-bearing
only for steps 1–6 — everything before the script exists. That is the payoff the
first draft did not claim.

## Provenance

- Audit run and captures: 2026-08-05, `docs/audiences.md`
- Review: `docs/audiences-review.md`
- Diary findings opened by this work: `#6` (verbs.ts count, scope `core/`),
  `#7` (message ring buffer), `#8` (`--help` rejected everywhere).
  `#3` deprecated as a false fix record.
- Every code claim above cites a file and line and was verified against source,
  not against the audit captures. Where the review's inference was wrong, the
  source is cited and the inference marked false.

Second review round (same day) added P1-7, P1-8, P2-1a, P4-5a and the P3 fixture
list, corrected the P4-10 sequencing contradiction, recorded recommended
branches under both P0 decisions, and deleted the header's drifted counts. Three
questions the review raised were settled by measurement rather than argument:

| Question | Answer | Evidence |
|---|---|---|
| Do failed `act` attempts consume message ids? | **No** — `#19` is a peer's reply | store query, P2-1a |
| Is `withdrawn / active` a state-machine bug? | **No** — orthogonal axes, display defect | `core/obligations.ts:19-22` |
| Is `board --history`'s doubled path a render bug? | **Yes** | `core/work.ts:563` + `cli/work.ts:462` |
