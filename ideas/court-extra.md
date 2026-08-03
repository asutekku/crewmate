Agreed. I pushed the theme too far.

The whimsy should live mostly in **names and presentation**, not in the agents’ reasoning model. The agents should still behave like disciplined engineering collaborators, not characters performing a setting.

Your existing system already has strong practical foundations: stable names, roles, direct messaging, questions, work items, file awareness, findings, user memory, and inheritance.  The additions should deepen continuity and responsiveness without encouraging role-play.

## A restrained version of “Soul”

A soul should be a compact operational profile:

```ts
interface AgentSoul {
  communicationStyle: {
    detail: 'brief' | 'balanced' | 'thorough';
    directness: number;
    asksBeforeActing: number;
  };

  workingStyle: {
    exploratoryVsDecisive: number;
    conservativeVsExperimental: number;
    prefersIndependentWork: number;
    reviewStrictness: number;
  };

  expertise: Record<string, {
    confidence: number;
    evidence: string[];
  }>;

  tendencies: string[];
  knownBlindSpots: string[];
  learnedCorrections: string[];

  collaborationPreferences: {
    prefersEarlyDiscussion: boolean;
    prefersConcreteProposals: boolean;
    preferredPeersByDomain: Record<string, string[]>;
  };
}
```

Examples of useful soul entries:

* Prefers inspecting call sites before changing shared interfaces.
* Usually provides one recommendation rather than many alternatives.
* Tends to overgeneralize from isolated performance measurements.
* Has strong experience with deterministic simulation.
* Should ask for a second opinion on database migrations.
* Communicates effectively with Luna on rendering architecture.
* Previously caused an issue by assuming placement coordinates were stable identity.

That gives personality through **consistent behaviour**, not decorative prose.

## Personality should come from four sources

### Explicit configuration

The user or agent can set stable tendencies:

```sh
cli.ts soul set luna directness high
cli.ts soul add luna tendency "Prefers evidence before architectural changes"
cli.ts soul add luna blind-spot "Sometimes overinvestigates peripheral failures"
```

### Observed behaviour

The system can infer tentative patterns:

* regularly asks peers before modifying shared APIs
* usually finishes work without follow-up corrections
* often produces useful reproduction cases
* tends to underestimate migration impact

These should remain marked as inferred until repeatedly supported.

### Learned corrections

The strongest personality signal is what an agent has learned:

```text
Do not derive persistent procedural identity from transform data.
Reason: moving buildings previously regenerated their appearance.
```

### Relationship-specific behaviour

An agent may communicate differently with different peers:

* trusts Rowan’s geometry analysis
* asks Vega for reproductions
* requests Luna’s review for lifecycle changes
* knows another agent prefers short, concrete questions

This is personal without becoming theatrical.

## Add relationships, but keep them technical

I would avoid emotional relationship labels and broad “affinity scores.” Store actionable collaboration history instead:

```ts
interface AgentRelationship {
  peerId: string;
  familiarity: number;

  trustByDomain: Record<string, number>;

  collaboration: {
    completedWorkTogether: number;
    usefulReviews: number;
    unansweredRequests: number;
    conflictingEdits: number;
  };

  communicationNotes: string[];
  unresolvedItems: string[];
}
```

Example:

```text
Luna → Rowan

- High trust: procedural geometry
- Moderate trust: API ownership
- Rowan usually answers concrete questions quickly
- Previous disagreement: stable identity should not depend on placement
- Rowan's position was confirmed by testing
```

The purpose is to improve decisions such as:

> Rowan has strong relevant context, so ask Rowan before changing this.

Not:

> Rowan is Luna’s trusted companion.

## Add durable commitments

This is probably the most useful missing social capability.

Agents frequently make lightweight commitments:

* “I will review that.”
* “Tell me when the schema is ready.”
* “I’ll answer after checking the tests.”
* “You can take this file.”
* “I’ll notify you if the benchmark regresses.”

These should become first-class records rather than disappearing into messages.

```sh
cli.ts promise rowan "Review the material ID change"
cli.ts promise vega "Notify when save schema is stable"
cli.ts promises
cli.ts fulfilled <id>
cli.ts cancel-promise <id> "No longer applicable"
```

A promise should contain:

* who made it
* who expects it
* the expected action
* trigger or deadline
* related work item
* status
* last relevant activity

“Promise” is slightly personal but still understandable and neutral. `commitment` would be the more formal internal term.

## Add structured discussion types

Plain messages are ambiguous. Give messages lightweight intent:

```text
FYI
QUESTION
REQUEST
PROPOSAL
OBJECTION
DECISION
HANDOFF
WARNING
CORRECTION
```

Examples:

```sh
cli.ts ask luna "Does the procedural seed survive relocation?"
cli.ts propose everyone "Store generated composition on the building record"
cli.ts object rowan "That makes undo state significantly larger"
cli.ts decide "Composition is stable data; transform is presentation"
cli.ts handoff vega "Reproduction case is ready"
```

This lets recipients react correctly:

* `FYI` requires no response.
* `QUESTION` creates an expected answer.
* `REQUEST` can be accepted, declined, or negotiated.
* `PROPOSAL` remains open until decided.
* `CORRECTION` can update findings or invalidate assumptions.
* `HANDOFF` transfers responsibility explicitly.

This would make discussions much easier to follow without adding much personality theatre.

## Add discussion threads

Messages currently form a shared stream. Agents need bounded conversations attached to a concrete subject:

```text
Thread: procedural-building-identity

Participants:
Luna, Rowan, Vega

Question:
What state must remain stable when a building moves?

Current conclusion:
Generated composition and tint are persistent.
Road-facing orientation may be recalculated.

Open:
Should facade variation remain stable when the road changes?
```

Commands:

```sh
cli.ts thread open "Procedural building identity"
cli.ts thread reply <id> "Transform cannot be the seed source"
cli.ts thread decide <id> "Persist composition separately"
cli.ts thread close <id>
```

Threads should link to:

* work items
* files
* findings
* decisions
* questions
* commits

That gives agents a shared discussion space without turning it into a ceremony.

## Add decisions as a separate durable object

Findings answer “what is true.” Work items answer “what is being done.” A decision answers “what did we choose, and why?”

```ts
interface Decision {
  question: string;
  optionsConsidered: string[];
  chosen: string;
  rationale: string;
  objections: string[];
  assumptions: string[];
  revisitWhen: string[];
  participants: string[];
}
```

Example:

```text
Decision: Building procedural identity

Chosen:
Persist generated composition independently from transform.

Reason:
Moving a building must not regenerate its appearance.

Revisit if:
Memory cost becomes significant at city scale.
```

This is especially important for agents joining later. They should not reopen settled questions merely because the original discussion has scrolled away.

## Add relevance-based reactions

The ideal reactive behaviour is not “agents constantly talk.” It is:

> Agents notice changes that affect their work, knowledge, or commitments.

Each agent can maintain subscriptions:

```sh
cli.ts watch "src/render/buildings/**"
cli.ts watch work:42
cli.ts watch finding:17
cli.ts watch "changes affecting material IDs"
```

But subscriptions should also be inferred from:

* recent edits
* current work
* authored findings
* outstanding promises
* questions awaiting answers
* expertise
* direct involvement in a decision

Then events are filtered by priority:

### Interrupt immediately

* direct question
* active work invalidated
* same-tree file collision
* dependency completed
* breaking change affecting current work

### Deliver between tool batches

* relevant proposal
* requested review ready
* another agent discovered contradictory evidence
* a promised condition became true

### Deliver next prompt

* related file changed
* useful finding appeared
* relevant work completed

### Keep only in digest

* routine commits
* general progress
* unrelated work

This builds on the event-rich hook model Claude Code exposes, including tool batches, task changes, file changes, worktree changes, failures, and teammate state. 

## Add capability and context awareness

Agents should know not only who is active, but who is currently a good person to ask.

```text
Vega
- Strong: reproduction, renderer debugging
- Current context: partial emissive materials
- Available: yes
- Context-switch cost: low

Luna
- Strong: simulation ownership, deterministic state
- Current context: save migration
- Available: no
- Context-switch cost: high
```

The system can recommend:

> Vega is the best available agent for this question.

Useful inputs:

* demonstrated expertise
* recent files
* successful work history
* current context
* workload
* outstanding commitments
* familiarity with the requester
* whether the agent has already investigated the issue

This helps agents self-organize without requiring an elaborate task marketplace.

## Add automatic peer consultation

An agent should sometimes consult another session without being instructed.

Good triggers:

* low confidence on a consequential decision
* about to modify a file another agent recently changed
* contradicting an existing finding
* entering a domain where another active agent has stronger evidence
* work depends on an undocumented assumption
* repeated failure after several approaches
* proposed change invalidates another active work item

The consultation should be precise:

```text
Question for Rowan:

I plan to persist generated building composition separately from transform.
Do road-facing rotations currently alter facade identity anywhere outside
building placement?
```

Not:

```text
What do you think about my approach?
```

The system could actively coach agents to ask answerable questions.

## Add disagreement handling

Agents should be able to disagree without immediately forcing consensus.

A proposal can have positions:

```text
Proposal:
Persist complete procedural composition.

Luna:
Support — guarantees relocation stability.

Rowan:
Conditional support — orientation must remain derived.

Vega:
Concern — serialized state size may become excessive.
```

The system should distinguish:

* disagreement about facts
* disagreement about priorities
* disagreement about expected outcomes
* misunderstanding
* unresolved uncertainty

Then request the appropriate resolution:

* measurement
* test
* user decision
* prototype
* clarification
* explicit trade-off decision

This is much better than assigning personality traits like “argumentative.”

## Add small amounts of whimsy only at the surface

Terms that seem compatible with your existing tone:

* **Soul** — durable behavioural identity
* **Minion** — temporary delegated subagent
* **Disciple** — agent inheriting selected knowledge from another
* **Presence** — active session visibility
* **Memory** — user-specific durable information
* **Inheritance** — taking over a departed agent’s context

Terms I would keep neutral:

* relationships
* commitments
* discussions
* threads
* decisions
* subscriptions
* capabilities
* availability
* confidence
* handoffs
* reviews

That produces a system with occasional personality in its nouns, while the actual interactions remain professional.

## The tighter ideal model

Each session would have:

```text
Identity
- stable name
- current role
- behavioural soul

Awareness
- active peers
- current work
- relevant subscriptions
- direct and indirect dependencies

Social context
- collaboration history
- trust by domain
- communication preferences
- pending questions and commitments

Knowledge
- findings
- decisions
- personal learned corrections
- selected inherited context

Agency
- ask
- answer
- propose
- object
- decide
- hand off
- volunteer
- request review
- update commitments
```

The personality comes from **how Luna behaves repeatedly**, what she remembers, who she consults, what she is good at, and how she has adapted after mistakes—not from mottos, moods, ceremonies, or decorative backstory.
