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
  /** Stable identifier for this producer, e.g. `roster`, `diary`, `memories`. */
  readonly key: string;
  /** Higher wins. Ties break on `key`, so the order never depends on Map order. */
  readonly priority: number;
  readonly text: string;
  /** True when the agent is expected to DO something about it. */
  readonly actionable: boolean;
  /**
   * What "the same item" means for suppression. Two candidates sharing this are
   * the same news; only the first survives deduplication.
   */
  readonly dedupeKey: string;
  /**
   * A fingerprint of the CONTENT, never a timestamp. "Do not show this again
   * unless it changed" is a content question, and a clock cannot tell a changed
   * item from a repeated one.
   */
  readonly stateVersion: string;
  readonly origin: CandidateOrigin;
  /**
   * Whether showing this text obliges us to also show the trust framing.
   *
   * Declared by the producer rather than inferred from `origin`, because the two
   * genuinely differ: a system-authored line that QUOTES a peer needs the
   * framing, and a peer-origin line that has been fully reworded by us may not.
   * The allocator cannot read English and must not guess.
   */
  readonly requiresPeerFraming: boolean;
  /**
   * A bounded rendering used when the full text will not fit.
   *
   * IT MUST STAND ON ITS OWN OR NAME ITS OWN SOURCE: a compact form counts as
   * DELIVERED, so it never reaches the inbox and must not point at one. A
   * producer that cannot cite its own command should omit `compact`.
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
   * What candidates are allocated against — NOT a hard ceiling on output.
   *
   * The mandatory header may exceed it (and the result says so), and the
   * aggregate fallback sits outside it. Naming it `budgetChars` implied a total
   * that nothing enforces.
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
 * What appending this text to a block of `blocks` existing entries costs.
 *
 * SEPARATORS GO BETWEEN, NOT AFTER. Charging every block a separator
 * overcounts by one and drops a candidate that fits.
 */
function appended(blocks: number, text: string): number {
  return text.length + (blocks > 0 ? JOIN.length : 0);
}

/**
 * The one way a packed block becomes text.
 *
 * Exported because the length accounting above and the string a session
 * actually receives must be the same operation — a caller joining these lines
 * its own way would make `renderedChars` a number about a different string.
 */
export function renderBlock(lines: readonly string[]): string {
  return lines.filter((l) => l !== "").join(JOIN);
}

/**
 * Deterministic order: priority first, then key.
 *
 * The tie-break is not decoration. Insertion order varies with which store
 * queries returned rows, which would make `crew injection` unreproducible.
 */
export function ordered(candidates: readonly InjectionCandidate[]): InjectionCandidate[] {
  return [...candidates].sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
}

/**
 * Drops candidates that are the same news, or news already delivered unchanged.
 *
 * `seen` maps `dedupeKey` to the `stateVersion` last shown to this recipient.
 * A key absent from it is new; a key present with a DIFFERENT version has
 * changed and is shown again; a key present with the same version is suppressed.
 * That is the whole of "do not repeat yourself unless something moved".
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
  // Exactly what `renderBlock` will produce for these, rather than a per-line
  // approximation of it — the two must be the same number or the budget is
  // about a different string than the one the session receives.
  const headerChars = renderBlock(header).length;
  // Charged as an APPEND: the framing follows the header, so it pays one
  // separator to join it, and its own lines pay separators between themselves.
  const framingChars = framing.length === 0 ? 0 : JOIN.length + renderBlock(framing).length;

  // OVERFLOW RENDERS ANYWAY. A block that silently truncates identity fails at
  // the one job the injection has, so a budget smaller than the header is
  // reported as a misconfiguration rather than enforced against the header.
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
      // A senior peer candidate already tried and could not afford it. Letting
      // this one retry is exactly the inversion above.
      omitted.push({ candidate: c, reason: "no room" });
      continue;
    }
    const overhead = wantsFraming ? framingChars : 0;
    const room = env.targetChars - used - overhead;
    // `blocks` counts what is already rendered, so the first block in an empty
    // envelope pays no separator and every later one pays exactly one.
    const blocks = header.length + (framingTaken || wantsFraming ? framing.length : 0) + selected.length;

    if (appended(blocks, c.text) <= room) {
      selected.push({ candidate: c, form: "full", text: c.text });
      used += appended(blocks, c.text) + overhead;
      if (wantsFraming) framingTaken = true;
      continue;
    }
    // Candidates are ATOMIC — never cut mid-line. A half-rendered obligation is
    // worse than an omitted one, because it reads as complete.
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

  // THE LINE THAT ALWAYS SURVIVES, and deliberately outside the budget. An
  // overloaded envelope must not be able to make actionable work disappear in
  // silence: the agent may not get the item, but it always gets told there is
  // one and how to read it.
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
