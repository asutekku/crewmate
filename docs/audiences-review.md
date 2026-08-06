Here's the audit, ranked within each section by how badly a trusting reader gets misled. Where I'm inferring beyond the captures, I say so.

---

## 1. The document's central claim is false as stated, and `stats` is the proof

**F1 — The "single run" is a collage of non-contemporaneous captures, and the doc's cross-references fail against its own evidence.** This is the highest-severity finding because "Every output below is real … Nothing is illustrative" invites the reader to cross-check blocks against each other — and every cross-check fails:

- The prose claims: *"`stats` is also what proved the `ask`/`asks` split above: it reports `obligations` and `questions` as separate row counts, and after this audit they read `5` and `0`."* The captured `stats` block contains **neither row**. It's truncated with `…` after `hazard_notices 0`. The one block cited as proof of the doc's flagship bug doesn't contain the evidence.
- Worse, the same block shows `clearance_events 0`, `clearances 0`, `diary 0`, `messages 9`. But `grant` (clearance created), `clearance … revoke` (event created), diary `#1`, and "~20 messages" all precede or are claimed by the doc. So this `stats` capture is from **early** in the session — it cannot simultaneously be "after this audit." The block disproves the sentence attached to it.
- `edits 7` vs. `files Akari` (4 edits: `README.md`, `docs/audiences.md ×3`) + `files hopper --hours 1` (6 edits) = 10. `work_steps 4` vs. akari's 1 step + hopper's 4 = 5.

Recommendation: either timestamp each capture block, or re-run the whole doc in one pass and state the capture order explicitly. Right now the honesty framing ("left in deliberately as the honest record") coexists with silently reordered evidence.

**F2 — The diary section's chronology is inverted inside a single paragraph.** Under "The same reads, now with content": `crew recall verbs --scope core/` shows `#3 finding now verbs.ts header comment corrected to 51` — but `#3` is created **two blocks later** (`--fixes 1`). Then `crew bugs` in the same group shows `● #1 … just now` still **open**, i.e. pre-fix. So within one "moment" the doc shows post-fix recall and pre-fix bugs. A reader trying to learn the state machine from these outputs will learn a state that never existed.

**F3 — Ghost diary entries #2 and #5, and two topics with no visible origin.** "What this run left behind" claims **"diary `#1`–`#5`"**. Shown creations: `#1`, `#3`, `#4`. `#2` is accounted for only by one buried sentence ("Filed as diary `#2`") with no capture. `#5` appears nowhere. `crew topics` shows `documentation 1` and `obligations 1` — no shown `note` used either topic. So at least two `note` invocations ran off-camera. Compounding it: `topics` says `docs 2` but the immediately following `crew topic docs` prints **one** entry (`#1`), while `#4` (`--topic docs`) should also be there. Either `topic` truncates, or the two blocks are from different times — the doc doesn't say which.

**F4 — Structured message `#19` is missing.** Sequence runs #12–#18, then `act` fails twice (`✗`, presumably not consuming numbers), then succeeds as **#20**. Either failed `act` attempts consume message numbers (a real defect worth documenting), or an unshown message occurred. The doc claims completeness of the capture; the gap is unexplained.

**F5 — Unevidenced prose claims presented alongside "captured" output.** Three behaviors are asserted with zero captured output: (a) `quit` "also reports **background processes** … The pid it prints"; (b) "`board` prints a `claude --resume <uuid>` line for an open item whose session is gone"; (c) the opening "A verb an agent is never told about is a verb agents never use — **measured**" — measured how? No `feature_events` breakdown is shown. All three may be true; none is evidenced, in a doc whose thesis is evidence.

**F6 — The intro's own arithmetic on non-run verbs doesn't match the Not-run section.** Intro: "Two verbs are quoted from their usage line only and one was not run at all." The section lists three verbs: `clear` (nothing quoted at all — not even a usage line), `quit` (usage line, ✓), `answer` (**failure output**, i.e. it *was* run). So the accounting is: one usage-only, one run-and-failed, one with nothing. Neither "two usage-only" nor "each verb … run" (opening paragraph) survives.

---

## 2. Internal contradictions in the captured surfaces

**C1 — `○` means opposite things in `who` and `board`.** `who` legend: `● running ⏸ needs you ○ at a prompt`. `board` legend: `● running ⏸ needs you ◐ at a prompt ○ gone`. Same glyph, "at a prompt" vs. "gone", in the two surfaces the doc calls the most heavily tuned. An operator who learns `○` from `who` will read `board`'s `○` as a live idle agent. This is a code fix (`cli/roster.ts` vs `cli/work.ts`), not a doc fix.

**C2 — `who` displays basenames, which makes the doc's own `breaks` narrative unverifiable and the "contested file" feature ambiguous.** Colourised `who` shows Hopper `✎ RELEASE_PLAN.md README.md`. `log` shows hopper "stopped after editing **plans/**RELEASE_PLAN.md, **plans/**README.md". So `who` stripped the directory. Consequence one: the doc's claim under `breaks` — "*a live peer existed, but had not been in the same files*" — appears **contradicted** by `who` (hopper holds `README.md`) unless you independently know it's `plans/README.md`. Consequence two: red-for-contested — is contention computed on full paths (correct, invisible) while display is basename (so two agents on `plans/README.md` and `README.md` *look* contested)? Inference beyond the capture, but the display defect itself is captured. This one actively misled me for a full pass; it will mislead operators daily.

**C3 — `injection` says "omitted", `inbox` says nothing was omitted — the resolution is buried and the naming is wrong.** `injection` prints an `omitted` section (`how-to-* p10 unchanged`); `inbox` prints "nothing was omitted from your session-start context." The budget block resolves it: `target 6000, rendered 1337` — there was ~4k of headroom, so nothing was dropped *for length*; the three blocks were deduplicated as `unchanged` (delivered 19m prior). So `injection`'s section header `omitted` conflates two mechanisms (budget eviction vs. unchanged-dedup), and only `inbox`'s one-line description ("items omitted from your context **for length**") disambiguates. Rename the section (e.g. `omitted (unchanged)` vs `omitted (budget)`) or the two surfaces will keep "contradicting" each other.

**C4 — `inbox --agent hopper` says "**your** session-start context".** The message template isn't parameterized for the `--agent` case. Small, but it's the exact kind of attribution sloppiness the README's `human to traffic-c9` anecdote warns about.

**C5 — Default `log` shows zero messages despite being described as "recent messages from every agent".** `crew log 8` output is eight `done:` turn-end summaries and not one of the ~20 actual messages the session produced — including none of #12–#18 sent (per doc order) before it. Either (a) `log`'s default view filters to turn-end events, contradicting its `core/verbs.ts` description, or (b) this capture predates every message, contradicting the doc's ordering. The `log 3 --raw` timestamps (2m/1m ago) vs `log 8`'s newest (10m ago) prove the two `log` captures are 8+ minutes apart. Either way, an operator running `crew log` to see what agents said to each other gets nothing — for a coordination tool, that makes the default of the flagship shared verb useless for its stated purpose.

**C6 — `who --raw` delivers the two fields documented as never reaching agents.** views.md (quoted): the conversation title and Haiku `doing:` line "**never enter any agent's context**… Both are for you, not for the agents." But `--raw` — motivated in the doc by token cost ("escape codes cost tokens in a context window"), i.e. positioned as the agent-safe format, and the closing section says an agent shelling out without `--raw` "gets a view designed for a terminal window it does not have" — prints both: `● hopper now Review Crewmate handover documentation / Writing a plan for the \`release\` mechanism to hand over sessi…`. Strictly, "never enter any agent's context" may mean only the *injection*; but then the sentence is misleading, because the doc simultaneously steers agents to `who --raw`, which hands them exactly those fields. Pick one: either the fields are human-only (strip them from `--raw`) or the claim is about injection only (say so).

**C7 — `obligation … withdraw` prints `withdrawn / active v2`.** Compare `3177d957… binding / active v1`. If the format is `<proposal-state> / <activation-state>` (two axes), that's defensible but unexplained anywhere; on its face, "withdrawn / active" reads as a state-machine bug. The valid-events list (`accept decline counter withdraw cancel fulfil violate activate release expire relinquish assign reassign return`, `core/obligations.ts:123`) suggests the two-axis model — inference; either explain the pair in output or collapse it.

**C8 — `board --history` prints `linked docs/audiences.md executing docs/audiences.md`.** "X executing X" — the fold renders the plan path twice (item's link target + event argument?). Garbled line, captured verbatim, unremarked.

**C9 — `plans` omits `docs/audiences.md` despite akari's `crew link docs/audiences.md` succeeding.** Output: only `plans/RELEASE_PLAN.md`. The prose explains omissions as "only plans with work linked against them" — but akari's item *was* linked. Either `plans` drops closed items (then hopper's "open · 1/4" annotation implies closed ones would show as `closed`, and akari's should appear), or it filters to `plans/`-directory paths (then `link` accepting arbitrary paths is a trap). Undetermined from the capture; determinable from `cli/work.ts`. Also note the semantic drift: `link` is "say which plan document this item executes," and the doc's own showcase links the **deliverable**, not a plan.

**C10 — The doc's audience thesis is contradicted by its own captured output.** "A verb an agent is never told about is a verb agents never use." But `doing`'s captured output tells the agent: "*Peers see it with `crew board`.*" — advertising a **human**-audience verb to agents in the most-used agent verb's output. Similarly `about-me` advertises `--all-projects` and `remember` advertises `--global`, flags absent from the doc entirely. The exposure channel isn't just sessionBlock + hooks; verb *output* is a third channel the taxonomy ignores.

**C11 — `injection --agent hopper` shows 3 obligations; 5 were created against hopper, and the absences aren't all explained.** `a2899def` (request) absent — withdrawn, fine. But `1bdb6708` (akari's promise-to-refrain, hopper as beneficiary) is also absent. If a promise made *to* you never enters your context, the beneficiary can't rely on it — which guts the point of `promise`. Inference from one capture; verify whether promises inject to beneficiaries at all.

---

## 3. Defects recorded but under-weighted

Ordered by real-world cost:

1. **`ask`/`answer`/`asks` non-interop is not "a bug", it's the primary Q&A loop being dead.** The doc's own hook (`hooks/prompt-submit.ts`) appends "*Answer with `crew answer <id> "<text>"`*" — a hook that **instructs agents to run a command that cannot succeed** against `ask`-created questions (`✗ question id must be an integer` vs uuid). Measured: 5 obligations, 0 `questions` rows. Every asked question in the system is unanswerable by the advertised path. This deserves top billing in the doc, not a subsection; and until fixed, the prompt-submit injection is actively harmful (burns an agent turn on a guaranteed failure).
2. **`--fixes` records an unverified claim, and the doc demonstrates the failure live.** Diary now asserts `verbs.ts header comment corrected to 51`; `core/verbs.ts:7` still says 33. The doc frames this as an honest demonstration — but the *store* has no marker distinguishing the demonstration from a real fix. Any future agent's `pre-edit` injection on `core/` will surface #3 as truth. The honest move was `note-deprecate 3` after the demonstration; the doc left the poisoned record in.
3. **`act`'s error `✗ JSON contains unsupported field text` is wrong, not just terse.** `text` **is** supported — inside `acts[]`. The error is about top-level placement and doesn't say so. First-attempt failure rate for the one verb designed for structured atomic use will be near 100% until the error names the path (`$.text` vs `$.acts[n].text`).
4. **`clear` is a no-confirmation multi-agent wipe, and the doc's parenthetical raises a worse question:** "*(`crew clear --help` is not even a recognised flag)*" — how was that established? If by running it, and unrecognized flags don't abort, that invocation **was** a wipe attempt on a live roster. If from reading `cli.ts`, say so. Either way: `clear` needs a confirmation or a `--force`, and unknown flags must be errors, before this doc ships.
5. **`quit`'s human-table description contradicts its behavior.** Table: "drop a **dead** session off the roster." Not-run section: "`crew quit hopper` would have dropped a **working peer** off the roster mid-task." So `quit` has no liveness check; the description promises one. Rename the description or add the check.
6. **Unknown obligation events don't list valid ones.** `✗ unknown obligation event discharge` — the author needed `core/obligations.ts:123` to learn the vocabulary. Print it in the error.

---

## 4. The taxonomy

The split is defined as descriptive ("who is told a verb exists, and who has a reason to run it") — and by that definition it's already wrong on its own evidence, before asking whether a third audience is needed:

- **`about-me` / `forget`**: the doc concedes the operator is told these exist ("the session-start block tells the *agent* the operator can read these") and the operator has the strongest possible reason to run them — agents are keeping cross-session memories **about them** (`inherit` shows hopper holding a memory about you, created off-camera, with no shown surface for you to read it). By the doc's own definition, these are at minimum **shared**.
- **`injection --agent` / `inbox --agent`**: the audit itself used `injection --agent hopper` as an *operator* verification tool. An agent inspecting a peer's context budget is the exotic case; the operator debugging "why didn't my agent see X" is the common one. Agent-audience placement is backwards for the `--agent` forms.
- **`obligation` / `clearance` bare inspectors, `asks`**: the operator auditing what agents have committed to each other is a governance need; these are currently reachable only if you read docs/, and `asks` is broken anyway.

**Against a third audience:** the doc's own framing kills it — there's no permission model, so a third row would be pure documentation taxonomy, and `shared` already exists for exactly this. Moving `about-me`, `forget`, `obligation`, `clearance` (bare) to shared, and documenting `--agent` forms as operator-facing, costs one row-count change and no code.

**For a third audience (the stronger argument, in my view):** "shared" currently means *symmetric* use (`msg`, `say`, `log` — both parties do the same thing). The memory/diary/ledger cluster is *asymmetric*: agent-write, operator-audit. Collapsing that into "shared" hides the actual gap, which is that **the operator has no aggregate read surface**: no `crew memories` (all agents' memories about me, across the store), no obligations *list* (only by-uuid inspect — how does anyone enumerate open obligations? `stats` gives a row count, `injection --agent` gives per-agent top-priority ones, nothing gives the ledger), no diary view framed for audit. An "oversight" audience row would make each missing verb visible as an empty cell. That's the argument: not permissions, but a forcing function on the design. Either resolution beats the current table, which is falsified by `doing`'s own output line (C10).

---

## 5. Absences

- **Rename lifecycle is completely unstated.** `call-me akari-audit` happened with 5 live obligations and in-flight messages authored as `akari`. `stats` shows `aliases 2` and `name_owners 2` — so a rename plausibly leaves an alias row and old names keep routing (inference from row names only). Nothing states: do obligations follow the session or the name? Does `msg akari` reach akari-audit? Does `obligation` authority match on session id or name? Given your known Hopper→Akari rename bug, this is the doc's most consequential silence.
- **Obligation TTL/expiry: none.** `--until "the release lands"` is opaque text; `expire` exists as an event but nothing fires it. Consequence shown in the capture: three obligations "still sitting in that agent's session-start context at p105" — **above the roster** — indefinitely. Two more absences follow: no stated cap on how many p105 items can stack (an adversarial or sloppy peer can occupy a target's entire injection budget with obligations), and no obligations-list verb to triage them.
- **Enforcement is advisory everywhere and stated nowhere.** Clearances are "opaque scope text"; promises don't block edits (akari could edit `RELEASE_PLAN.md` the moment after `promise --refrain`); `hazard` doesn't gate anything; `--fixes` is "a claim, which nothing verifies" (this one *is* stated — the only one). One paragraph — "everything in this ledger is advisory; hooks surface it, nothing enforces it" — belongs in the doc's header.
- **Inter-agent prompt injection is unaddressed.** `msg`, `say`, obligation text, and hazard text are arbitrary strings delivered into peers' context (p105, i.e. *before* the roster). The doc documents delivery mechanics in detail and says nothing about the trust model. Even a sentence ("peer messages are untrusted input; hooks label their origin") matters, since your agents act on this text.
- **`--plan-doc`.** `help`'s captured output shows `doing "<subject>" [--plan "a; b; c"] [--plan-doc <path>]` — a flag that appears nowhere else in the doc, including in the `link` discussion it overlaps with. When does `--plan-doc` vs `link` apply? Undocumented.
- **Test coverage for the doc itself:** stated missing, but the fix is understated. The `bun -e` one-liner re-derives 51; it cannot re-derive **38/10/3** unless `core/verbs.ts` carries an `audience` field — the doc never says whether it does (inference: probably not, or the table would be generated like `help` is). Add the field, generate this table's counts, and assert them in `test/verbs.test.ts` alongside the existing cli↔verbs check. While there: a test that `crew log`'s default actually returns messages (C5), and a glyph-legend constant shared by `cli/roster.ts` and `cli/work.ts` (C1).
- **`stats` unit ambiguity:** `window 1 active hours over 6m` — minutes or months? Given the store shows a day's work, presumably minutes-ish, but the line is unreadable as captured.
- **No export/backup verb** to pair with an unconfirmed `clear`; the mitigation (copy the `.db` shown by `where`) exists but is unstated.

---

## Verdict

The doc's individual captures are credible; the **frame** is not. "Nothing is illustrative" is true of each block and false of the document, because the blocks are reordered and non-contemporaneous, and the one place a block is cited as cross-verification (`stats` → obligations/questions) the block doesn't contain the cited rows. Fix the frame first (timestamps per capture, or one clean re-run), then the four code defects that the captures prove outright: `ask`/`answer` id-type mismatch + the hook that instructs the dead path, `○` glyph divergence, `who` basename display, and default `log` showing no messages.


# Missing features

Working from what the captures prove is missing, ranked by how often you'd hit the gap. Names are suggestions; the shapes are the point.

**Operator read surfaces (the biggest cluster — agent-write stores with no human read path)**

1. `crew memories [--agent <name>] [--all-projects]` — every memory every agent holds about you, across the store. Right now the only evidence hopper holds one is a side effect of `inherit` refusing ("still held — ask them instead of inheriting / hopper 1 memory"), and `about-me` is keyed to the *calling* session's agent. You're the subject of this data and can't enumerate it. Pair it with `crew forget --agent <name> <id>` so erasure isn't gated on the agent being alive — currently a dead agent's wrong memory about you is only reachable via `inherit`, which transfers it rather than deleting it.
2. `crew obligations [--agent <name>] [--open|--all]` — a ledger list. Today the only handles are by-uuid `obligation` inspect (you must already have the uuid), `injection --agent` (top-priority ones only), and `stats` (a bare row count). Neither you nor an agent can answer "what's outstanding between these two." Same for `crew clearances`.
3. `crew diary [--topic] [--scope]` as an operator view, or just document that `recall`/`bugs`/`topics` are shared — the doc says "You would read this only to audit" and then files auditing under agent-audience. The verbs exist; the surface statement doesn't.

**Lifecycle verbs the state machines imply but nothing fires**

4. Obligation expiry: `--until` accepts opaque text and `expire` exists as an event with no trigger. Minimum viable: `--until` optionally accepts a duration (`--until 4h`), and a sweep (on any verb invocation, or `crew gc`) fires `expire`. Without it, p105 items stack in a peer's injection forever — the capture already shows three, above the roster, with no cap.
5. A p105 cap in `core/sessionBlock.ts` — say, top N obligations by age, rest folded into one "`crew obligations` for M more" line. This is the `inbox` pattern you already built, unapplied to the one priority class that can crowd everything else out.
6. Rename semantics: either `call-me` output states what happens to in-flight names ("obligations and messages follow your session; `akari` remains an alias") or you need `crew aliases` to inspect the `aliases`/`name_owners` rows `stats` proves exist. Given the Hopper→Akari bug, I'd make `call-me` print the alias it created.

**Safety pairs for the destructive verbs**

7. `crew export [path]` / `crew clear --force` — an unconfirmed multi-agent wipe with no backup verb is the worst pairing in the tool. Export is nearly free (copy the `.db` that `where` already prints); requiring `--force` on `clear` is one conditional. Also make unknown flags hard errors first, or `--force` semantics are moot.
8. `quit` liveness: either check the session pid before deregistering a *named* agent (`crew quit hopper` on a live session → "hopper is running (pid N); `--force` to deregister anyway") or rename the description to match reality.

**Repairs that are really features**

9. The Q&A loop: rather than patching `answer` to accept uuids, I'd collapse the split — `ask` should write the `questions` row (or `asks`/`answer` should read obligations). Whichever way, the acceptance test is: `ask` → peer's `asks` shows it → peer's `answer <id>` succeeds → your `asks` shows the reply owed→answered. That's a feature (a working loop), not a bugfix, because today zero of the four links hold.
10. `who` full paths, or at minimum directory-disambiguated basenames (`plans/README.md` vs `README.md`) — this is display, but it gates a real feature: contested-file red is only trustworthy if you can tell *which* file is contested.
11. `log` default should include messages. If turn-end summaries are worth a view, make that `crew log --turns`; the flagship shared verb returning zero of ~20 messages by default means the operator's only ambient view of inter-agent traffic is `--raw`.

**One I'd argue against building:** a permission model (real agent/human gating). The doc's "no `--agent-only` flag" stance is right — the split is documentation, and enforcement would break the property that you can impersonate a session deliberately with `--from` when things go wrong. The gaps above are all *read* surfaces and lifecycle rules, not access control.

If you only build three: `memories` (+ cross-agent `forget`), `obligations` list, `export`/`clear --force`. The first is about your data, the second unblocks the whole obligations feature (unenumerable state is unusable state), the third is the one that prevents an unrecoverable afternoon.