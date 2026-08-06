/**
 * What actually reaches a session's context, and what gets left out.
 *
 * Identity is ENVELOPE: subtracted from the budget first and never weighed, so
 * `pack` cannot drop it. NOTHING VANISHES SILENTLY — an item that will not fit
 * degrades to its compact form, then to a counted line, then to `crew inbox`.
 */

/** Where a candidate's text came from. Peer text is what needs the trust note. */
export type CandidateOrigin = "operator" | "peer" | "system";

/**
 * Whether the session's CONTEXT survived, which is not whether the session did.
 *
 * `resume` is the ONLY continuation. `clear`, `compact` and `fork` re-fire
 * SessionStart under the same id with the context wiped, so anything keyed on
 * the id alone suppresses text the agent can no longer see.
 */
export function isContinuation(source: string | undefined): boolean {
  return source === "resume";
}

export interface InjectionCandidate {
  readonly key: string;
  /** Higher wins; ties break on `key`, never on Map order. */
  readonly priority: number;
  readonly text: string;
  readonly actionable: boolean;
  /** Two candidates sharing this are the same news; only the first survives. */
  readonly dedupeKey: string;
  /** A fingerprint of the CONTENT, never a timestamp. */
  readonly stateVersion: string;
  readonly origin: CandidateOrigin;
  /**
   * Declared by the producer, not inferred from `origin`: a system line quoting
   * a peer needs the framing, a reworded peer line may not. The allocator
   * cannot read English and must not guess.
   */
  readonly requiresPeerFraming: boolean;
  /**
   * A bounded rendering used when the full text will not fit.
   *
   * IT MUST NAME ITS OWN SOURCE: a compact form counts as DELIVERED, so it
   * never reaches the inbox and must not point at one.
   */
  readonly compact?: string;
}

export interface Envelope {
  /** Identity, role, project. Never eligible for eviction, never sorted. */
  readonly mandatoryHeader: readonly string[];
  /** Added iff a selected candidate has `requiresPeerFraming`. */
  readonly peerFraming: readonly string[];
  readonly candidates: readonly InjectionCandidate[];
  /**
   * What candidates are allocated against — NOT a ceiling on output. The header
   * may exceed it and the aggregate fallback sits outside it.
   */
  readonly targetChars: number;
}

/** Why a candidate is not in the block, in the words the report uses. */
export type OmitReason = "duplicate" | "unchanged" | "no room";

export interface Selected {
  readonly candidate: InjectionCandidate;
  /** Which rendering was used; `compact` is the producer's bounded form. */
  readonly form: "full" | "compact";
  readonly text: string;
}

export interface Omitted {
  readonly candidate: InjectionCandidate;
  readonly reason: OmitReason;
}

export interface PackResult {
  readonly lines: readonly string[];
  readonly selected: readonly Selected[];
  readonly omitted: readonly Omitted[];
  /** True when the header alone is bigger than `targetChars`. */
  readonly mandatoryOverflow: boolean;
  /** Rendered length of everything, header included. */
  readonly renderedChars: number;
  /** Chars the header and framing consumed before candidates were considered. */
  readonly reservedChars: number;
}

/** Blank line between blocks, so a length check matches what is emitted. */
const JOIN = "\n\n";

/**
 * SEPARATORS GO BETWEEN, NOT AFTER. Charging every block a separator overcounts
 * by one and drops a candidate that fits.
 */
function appended(blocks: number, text: string): number {
  return text.length + (blocks > 0 ? JOIN.length : 0);
}

/** The one way a packed block becomes text; length accounting must use it too. */
export function renderBlock(lines: readonly string[]): string {
  return lines.filter((l) => l !== "").join(JOIN);
}

/**
 * Deterministic order: priority first, then key. The tie-break is not
 * decoration — insertion order varies with which store queries returned rows,
 * which would make `crew injection` unreproducible.
 */
export function ordered(candidates: readonly InjectionCandidate[]): InjectionCandidate[] {
  return [...candidates].sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
}

/**
 * Drops candidates that are the same news, or news already delivered unchanged.
 * `seen` maps `dedupeKey` to the `stateVersion` last shown: absent is new, a
 * different version has changed, the same version is suppressed.
 */
export function dedupe(
  candidates: readonly InjectionCandidate[],
  seen: ReadonlyMap<string, string>,
): { kept: InjectionCandidate[]; dropped: Omitted[] } {
  const kept: InjectionCandidate[] = [];
  const dropped: Omitted[] = [];
  const within = new Set<string>();
  for (const c of candidates) {
    if (within.has(c.dedupeKey)) {
      dropped.push({ candidate: c, reason: "duplicate" });
      continue;
    }
    if (seen.get(c.dedupeKey) === c.stateVersion) {
      dropped.push({ candidate: c, reason: "unchanged" });
      continue;
    }
    within.add(c.dedupeKey);
    kept.push(c);
  }
  return { kept, dropped };
}

/**
 * Selects what fits, reserving the mandatory envelope first.
 *
 * The FIRST candidate needing peer framing pays for its own text AND the
 * framing, atomically — both fit or neither is taken. A peer line admitted
 * without its framing is the one combination that must never render.
 */
export function pack(env: Envelope, seen: ReadonlyMap<string, string> = new Map()): PackResult {
  const header = env.mandatoryHeader.filter((l) => l !== "");
  const framing = env.peerFraming.filter((l) => l !== "");
  // Measured through `renderBlock`, or the budget describes a different string
  // than the session receives. Framing is charged as an append after the header.
  const headerChars = renderBlock(header).length;
  const framingChars = framing.length === 0 ? 0 : JOIN.length + renderBlock(framing).length;

  // OVERFLOW RENDERS ANYWAY: a budget under the header is reported as a
  // misconfiguration rather than enforced by truncating identity.
  const mandatoryOverflow = headerChars > env.targetChars;

  const { kept, dropped } = dedupe(ordered(env.candidates), seen);

  const selected: Selected[] = [];
  const omitted: Omitted[] = [...dropped];
  let used = headerChars;
  let framingTaken = false;
  // THE FRAMING IS SETTLED BY THE FIRST PEER CANDIDATE, WIN OR LOSE. Letting a
  // later, smaller candidate retry the charge its senior could not afford is a
  // priority inversion. See docs/design-notes.md, "Packing the block".
  let framingSettled = false;

  for (const c of kept) {
    const wantsFraming = c.requiresPeerFraming && !framingTaken;
    if (wantsFraming && framingSettled) {
      omitted.push({ candidate: c, reason: "no room" });
      continue;
    }
    const overhead = wantsFraming ? framingChars : 0;
    const room = env.targetChars - used - overhead;
    const blocks = header.length + (framingTaken || wantsFraming ? framing.length : 0) + selected.length;

    if (appended(blocks, c.text) <= room) {
      selected.push({ candidate: c, form: "full", text: c.text });
      used += appended(blocks, c.text) + overhead;
      if (wantsFraming) framingTaken = true;
      continue;
    }
    // Candidates are ATOMIC — never cut mid-line. A half-rendered item is worse
    // than an omitted one, because it reads as complete.
    if (c.compact !== undefined && appended(blocks, c.compact) <= room) {
      selected.push({ candidate: c, form: "compact", text: c.compact });
      used += appended(blocks, c.compact) + overhead;
      if (wantsFraming) framingTaken = true;
      continue;
    }
    if (wantsFraming) framingSettled = true;
    omitted.push({ candidate: c, reason: "no room" });
  }

  const lines = [...header];
  if (framingTaken) lines.push(...env.peerFraming);
  for (const s of selected) lines.push(s.text);

  // THE LINE THAT ALWAYS SURVIVES, deliberately outside the budget. An agent
  // may not get the item, but always learns there is one and how to read it.
  const lostActionable = omitted.filter(
    (o) => o.reason === "no room" && o.candidate.actionable,
  ).length;
  if (lostActionable > 0) {
    lines.push(
      `${lostActionable} actionable item(s) omitted for length — run \`crew inbox\`.`,
    );
  }

  return {
    lines,
    selected,
    omitted,
    mandatoryOverflow,
    renderedChars: renderBlock(lines).length,
    reservedChars: headerChars + (framingTaken ? framingChars : 0),
  };
}
