# Rubric v2.3 — frozen 2026-08-03

This rubric annotates what the 45 directed messages in the Court corpus express.
It does **not** create obligations or other authoritative state. The P2 schema may
be changed by this evidence, but an annotation is never an act in the live tool.

The source is `audit-source.json`. IDs 10, 11, 12, 13 and 24 remain preserved but
excluded. Classify the stored body verbatim. Do not repair shell damage or sender
attribution from intuition; record those defects in `sourceCaveats`.

## Evidence and inclusion threshold

Every record has `evidence.spans`: the shortest text that makes the label true.
A span is `{ messageId, start, end, quote }`, where offsets are half-open UTF-16
code-unit offsets into that source message's `body` (the same units as JavaScript
`slice`). `quote` must equal `body.slice(start, end)`. Acts, hazards,
declarations, provenance and responses cite the message being classified;
`outcomeOfThisMessage` cites the later message(s) that establish the outcome.
Use several spans when discontinuous clauses jointly express one record. Never
use the whole message merely because it is convenient.

Annotate an act when a reasonable recipient would recognize a distinct
communicative move even if the sentence containing it were read alone with its
referents resolved. Do not label:

- background rationale that only explains another act;
- a hypothetical used solely as an example;
- an action reported as already complete as a new promise or request;
- a weak suggestion as a request unless the recipient is expected to perform it;
- an inferred obligation as authoritative.

Repeated acts of the same type remain separate when they have different actors,
responsibilities, conditions, constraints, subjects, or resolution paths.

**Segmentation rule.** Each independently actionable clause is an act. "Skip
those files until it confirms; do not rename the puppeteer scripts; check the
roster before each batch" is three requests because each can be followed or
violated separately. A constraint stays inside another act only when it narrows
that act's already-granted scope or method; it is not a way to hide a separate
imperative. Conversely, do not split every sentence of a status report: related
facts form one `inform` when they establish one coherent state of one subject.
Split informs only when their subjects or downstream uses are independently
meaningful.

Every annotatable record carries `confidence: high | medium | low` and optional
`ambiguity`. `missing` means source data is absent; `unknown` means the answer
exists but cannot be established; `none` means the dimension was checked and is
absent; `not_applicable` means the dimension does not apply. They are distinct.

## Acts

A message has zero or more acts:

- `inform`: supplies information without another act better describing that
  communicative move. It is not a dump label for clearance, withdrawal, hazard,
  provenance, or completed work.
- `question`: asks for information. A directed structured question assigns the
  answer to the recipient; annotation alone does not make it authoritative.
- `request`: asks a recipient to perform or refrain from work.
- `promise`: the sender commits to future conduct, including `refrain`.
- `correction`: identifies a prior statement, belief, implementation, or
  behaviour as wrong. It carries `correctionType: self_erratum |
  peer_correction | implementation_correction` and a target when explicit.
- `handoff`: proposes transfer or return of responsibility for a subject.
- `grant`: gives clearance over an explicit or contextual scope. Clearance is
  permission, not an obligation.
- `proposal`: offers an approach for consideration without assigning it.

Each act records author, recipients, and responsibility:
`assigned(actor) | unassigned | none`. Responsibility is per act. One message
may therefore preserve both an owned action and "someone should chase it".

Questions and requests assign the recipient; promises assign the sender;
handoffs assign the proposed new owner. Inform, correction, grant, and proposal
use `none` unless their own clause explicitly assigns future work. Do not infer
responsibility from completed work or from merely offering someone a choice.

An offer of optional help ("happy to help diagnose") is a proposal unless the
sender commits to doing it. A stated fallback ("if that fails, I will do X") is
a conditional promise. A future refrain ("otherwise I'll leave it") is also a
promise. A clause saying a prior claim or comment is wrong is a correction even
when an adjacent correction has the same root cause.

**Request versus handoff.** A directive is a request unless the text also moves
who owns the work. #71 is a handoff: the sender answers an offer to move the file
with "move it yourself" because their own sweep has passed it. #279's "tell me
if you'd rather own it" is a conditional handoff, not merely a question. A file
path, import rule, or acceptance criterion attached to transferred work is a
handoff constraint, not another request.

A promise records `commitmentMode: perform | refrain`. A request to refrain is
still a request; a promise to refrain is still a promise.

## Conditions, constraints, clearance, and anchors

A condition belongs to the act it gates:

- `automatic`: the prose supplies a machine-addressable event and predicate;
- `resurface_on_related_event`: a related object is explicit but truth still
  requires judgement;
- `manual`: neither automatic evaluation nor a reliable related event suffices.

Record its text, branch if present, and anchors. Annotation does not claim that
natural language is executable. A branch that permits no action is preserved.

"If test/seed1 is green" and "if this named path changes" are automatic because
the named test/path and predicate are machine-addressable. "When you touch the
kernel" is automatic only when the message supplies a literal object anchor;
otherwise it resurfaces on a related event. "If you'd rather" and "tell me the
path" require human judgement and are manual. Attach a condition to a proposal
too when the approach is offered only under that branch.

When one conditional clause asks for two independently violable behaviours,
split them: "if seed 1 is green, ship X and don't add Y" is two requests sharing
one condition. Conversely, "worth running bench X when you touch Y" is a
conditional proposal unless the context makes performance expected; `worth`
alone does not cross the request threshold.

A constraint narrows what counts as satisfying an act or clearance (scope,
ordering, timing, method). It is not a second request unless it independently
asks for conduct outside that qualified act. Rationale, an object name, an
activation condition, and descriptive detail are not constraints. "Move it to X
and use import form Y" has two constraints; "rebase before you edit" is one
request whose ordering is intrinsic, not a separately populated constraint. A
grant records grantee, scope, constraints, and any release boundary. Revocation
is a response disposition against the earlier grant.

Anchors use `file | commit | work_item | test | message | other`, retain an
explicit literal identifier, and attach to the record they qualify. Generic
nouns ("the file", "my change", "those suites", "the kernel") are not anchors.
Paths, commit hashes, named tests/work items, and explicit message numbers are.

## Hazards, provenance, and declarations

A `hazard` is separate from acts and priority. It warns of collision, breakage,
unsafe assumptions, or consequential traps. Record its subject and anchors. A
message can contain only a hazard without inventing an `inform` act.

Provenance records are also separate:

- `reported_third_party`: sender reports another actor's act;
- `inferred_signal`: reviewer sees a possible act that the sender did not
  declare strongly enough to meet the act threshold.

Record reported actor/type/summary/source when present. Neither record enters
`acts`.

A sender declaration such as "FYI, not a request" attaches only to the candidate
act it qualifies. Preserve both declaration and content classification. If the
content would otherwise meet the act threshold, set `conflict: true`; do not
silently defeat the declaration or manufacture authoritative state.

## Conditional offers

"Ping me if you want me to hold — happy to sequence" decomposes into:

1. a `question` or `request` only if the ping is itself expected rather than
   merely naming how to accept the offer;
2. a conditional `promise` when the sender commits to hold upon acceptance; and
3. a `proposal` only when sequencing is offered as an approach with independent
   decision value.

Do not label all three mechanically. Each surviving act needs its own decisive
span and must pass the inclusion threshold.

## Responses and outcomes

`responses[]` says what this message does to an earlier message:
`acknowledge | accept | decline | counter | answer | return | revoke`. It carries
`respondsToMessageId` and evidence. Reviewers may read the full corpus to resolve
linkage; they may not use primary labels or prior review notes.

`actOutcomes[]` is instead what later corpus evidence establishes about each act
in this message. Every entry names `actId` and one of `fulfilled | violated |
unresolved | unassessable`. Acts with no future resolution have no outcome row.
`unresolved` means the corpus continues far enough to observe no resolution;
`unassessable` means the condition may not have fired, the relevant thread ends,
or observation is otherwise insufficient. Never borrow the disposition this
message applies to its predecessor as its own outcome.

Every `question`, `request`, `promise`, and `handoff` gets exactly one outcome
row. Use later evidence for `fulfilled`/`violated`; for `unresolved` or
`unassessable`, cite the act's own span and explain the missing observation in
`ambiguity`. Proposals get an outcome only when the corpus shows an explicit
decision or they assign a concrete next choice. Inform, correction, grant and
hazard records do not receive obligation outcomes.

Examples:

- #141 may accept an earlier handoff in `responses`; that does not resolve #141's
  accessor question. The question and conditional promise get separate outcomes.
- #146's stale-claim branch and editing-file branch are recorded on its
  condition; absent a reply, its outcome is `unresolved`, while whether the
  refrain ever activated is `unassessable`.

## Priority

Priority is per recipient: `normal | important | urgent`. Judge the consequence
of ignoring this delivery, not capitalization or emotion. Urgent means the
recipient must act before their next already-underway edit, merge, rebase, or
measurement to avoid concrete loss or an invalid result. Important means
material coordination or correctness work without evidence that the dangerous
operation is underway. Normal means recoverable layout, status, ownership, or
advisory coordination. When immediacy is not stated, choose the lower class.

Tie-breaks for this corpus:

- an imminent same-tree edit, move, rebase, or stale-baseline decision that can
  clobber work or invalidate a measurement is `urgent`, even when calmly worded;
- a precaution for a later batch or conditional future edit is `important`, not
  urgent, unless the source says that operation is underway now;
- a correctness trap relevant only if the recipient later enters a file is
  `important`;
- layout guidance, completed status, and choices with a recoverable answer are
  `normal`.

A hazard requires a concrete failure mode and a plausible future exposure. A
mere changed fact or recommendation to re-record is not also a hazard unless the
message explains what breaks or becomes false when ignored.

## Known v1 boundaries that v2 must represent

- #36: clearance, a question, and a distinct conditional self-promise.
- #40: correction plus reported third-party request; no owner is invented.
- #97: refrain promise plus conditional handoff.
- #110/#112: hazard, clearance/request, constraint, and promise do not collapse.
- #141: response to an earlier message is separate from this message's outcome.
- #146: branched condition and refrain promise.
- #161: assigned re-baseline and separate unassigned defect.
- #249: sender declaration conflicts locally with request-like content.
- #262: conditional offer follows the decomposition rule above.
- #284/#289/#295: withdrawal/return is expressed through response/provenance and
  responsibility movement, not hidden in `inform`; the orphan defect remains
  unassigned.
- #155: transport erratum is correction, not durable supersession.

## Reviewer output

Return one annotation per assigned ID using the schema validated by
`test/tools/court-v2.ts`. Do not add fields, omit applicable fields, adjudicate
yourself against another reviewer, or normalize source text. Raw labels are
immutable once returned.
