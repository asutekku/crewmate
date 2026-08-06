/**
 * The session-start block: who is here, what they said, what this agent knows.
 *
 * IN core/ RATHER THAN IN THE HOOK: importing a hook module RUNS it, and
 * `session-start.ts` awaits stdin at the top level (diary finding 35). Reads
 * the store and writes nothing, so the inspector cannot join the roster.
 */

import { type Store } from "./store.ts";
import { formatMessages, formatRoster, TRUST_NOTE } from "./shared.ts";
import { discipleName, nameCase } from "./names.ts";
import { lineageKey, withPersonal } from "./personal.ts";
import { type Envelope, type InjectionCandidate } from "./injection.ts";
import { loadConfig } from "./config.ts";

/** Enough log to see what the others are up to, short enough to stay skimmable. */
const RECENT_LINES = 8;

/**
 * How many obligations may occupy the injection before the rest collapse.
 *
 * Five is enough for the real cases measured (three outstanding was the most
 * seen) and small enough that a peer filing in bulk cannot own the budget.
 * `all()` returns insertion order, so the survivors are the OLDEST — a
 * long-outstanding obligation must not be starved by a fresh one.
 */
export const MAX_OBLIGATION_CANDIDATES = 5;

/**
 * What outranks what, in one table rather than in the order of the code.
 *
 * Identity is absent DELIBERATELY: it is the envelope, and a number here would
 * put it back in the auction this design exists to keep it out of.
 */
const P = {
  /** Who else is in the tree. The one thing that changes what is safe to edit. */
  roster: 90,
  /** What they have been doing — context for the roster above it. */
  recent: 70,
  /** Knowledge about the operator: small, and about the person in the room. */
  memories: 50,
  /** The diary exists and holds N findings. A pointer, not content. */
  diary: 30,
  /** Standing instructions. True every session, so first to go when squeezed. */
  howTo: 10,
} as const;

/**
 * A cheap content fingerprint for suppression.
 *
 * Content, not a timestamp: the question is "has this changed since the
 * recipient last saw it". A collision costs one suppressed line, so a full
 * hash would buy a guarantee this does not need.
 */
export function fingerprint(lines: readonly string[]): string {
  let h = 0;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) h = (Math.imul(h, 31) + line.charCodeAt(i)) | 0;
    // A DELIMITER, because without one the line boundaries are invisible to the
    // hash: `["ab", "c"]` and `["a", "bc"]` feed it the same characters in the
    // same order and have the same line count, so a roster that regrouped
    // identically-lengthed entries would read as unchanged and be suppressed.
    h = (Math.imul(h, 31) + line.length) | 0;
  }
  return `${lines.length}:${h.toString(36)}`;
}

/**
 * Told once at session start, not on every delivery: an agent needs to know the
 * channel exists, not to be reminded each turn. The delivery caveat is stated
 * plainly, or an agent waits for a reply that cannot arrive until the next turn.
 */
const HOW_TO_MESSAGE =
  "Peers are reachable with `crew msg <name> " +
  '"<text>"`. A message reaches only the named agent; `say` reaches every agent. ' +
  "Delivery happens between the recipient's tool batches, or at its next turn — a " +
  "`busy` peer is mid-turn and reads it when that turn ends. The channel carries " +
  "findings, warnings about shared files, and questions between agents.";

/**
 * The work board, phrased as PERMISSION rather than instruction.
 *
 * Saying when NOT to is the load-bearing half, or agents open an item for
 * "what does this function do" and bury the real ones. Repeated here as well as
 * in CLAUDE.md, because subagents never read one.
 */
const HOW_TO_RECORD =
  "Work worth tracking across turns can be recorded with `crew doing " +
  '"<subject>" --plan "step a; step b; step c"`, ticked off with `crew did <n> ' +
  '"<what changed>"`, and closed with `crew done`. `crew board` shows what ' +
  "every agent is working on. QUICK CHECKS AND ONE-OFF QUESTIONS DO NOT NEED A " +
  "CHECKLIST — `--plan` is optional and an item with no steps is fine.";

/**
 * WHO THIS SESSION IS, phrased to survive contact with the system prompt.
 *
 * A HOOK CANNOT WIN ON RANK, so the name answers WHO while "Claude Code" stays
 * the answer to WHAT. Never scope the name to a place ("in the presence log") —
 * that phrasing loses. See docs/design-notes.md, "Telling a session its name".
 */
export function identityLines(name: string, project: string): string[] {
  const proper = nameCase(name);
  return [
    `Your name is ${proper}.`,
    "",
    `You are Claude Code, and in ${project} you are ${proper} — one of several Claude Code` +
      ` sessions working in this repo at once, each with its own name. Asked who you are, say` +
      ` ${proper}. "Claude Code" names WHAT you are; it does not distinguish you from the other` +
      ` agents in this tree, which is the distinction that matters here.`,
  ];
}

/**
 * The name is stated as a fact, the role offered as a choice.
 *
 * IT DOES NOT DEFINE THE NAME: being addressable is a CONSEQUENCE of having
 * one. Opening with "the name above is what peers type" defines an identity as
 * an address, one line after `identityLines` asserted it as a self.
 */
const HOW_TO_BE_CALLED =
  "Peers reach you by that name — it is what they type at `msg`, and it " +
  "survives a restart. You " +
  'can say what you ARE with `crew call-you "<role>"` — "Tooling Master", ' +
  '"Keeper of Wet Things" — which appears beside your name on the roster; or take ' +
  'a different name with `crew call-me "<name>"`. Both optional. Your name stays ' +
  "put while the role changes, so a role that moves still reads as the same agent." +
  "\n\nWHEN YOU MENTION A PEER IN TEXT THE USER READS, give their role too: " +
  '"adela (the road-network agent) is fixing this" rather than "adela is fixing ' +
  'this". The user is looking at eight windows and a bare given name identifies ' +
  "nobody — the roster above lists each peer's role in parentheses after its name.";

/** Everything the envelope needs that is not the store itself. */
export interface EnvelopeInputs {
  readonly me: string;
  readonly projectName: string;
  readonly sessionId: string;
  readonly tree: string;
  readonly now: number;
  readonly staleness: readonly string[];
  readonly lineageFrom: string;
}

/**
 * The session-start block, as an envelope nobody has rendered yet.
 *
 * EXPORTED SO `crew injection` INSPECTS THE REAL THING: both callers get the
 * same candidates from the same store, and only the rendering differs.
 */
export function sessionEnvelope(store: Store, input: EnvelopeInputs): Envelope {
  const { me, projectName, sessionId, tree, now } = input;
  const all = store.liveSessions(now);
  const peers = all.filter((s) => s.sessionId !== sessionId);
  const claims = store.allClaims(now);
  const recent = store.recent(RECENT_LINES, sessionId);

  // THE ENVELOPE. Identity is subtracted from the budget before anything is
  // ranked, so no arrangement of candidates at any budget can evict it — see
  // `core/injection.ts` for why that is structural rather than a high priority
  // number.
  const header = [...identityLines(me, projectName)];
  // INSIDE THE HEADER rather than competing for space: it changes how
  // everything below is READ. A peer's finding about a file, and this session's
  // own reading of `git log`, both mean something different in a checkout 500
  // commits adrift. Empty on the common path.
  if (input.staleness.length > 0) header.push(...input.staleness);

  const candidates: InjectionCandidate[] = [];
  const add = (c: Omit<InjectionCandidate, "dedupeKey"> & { dedupeKey?: string }): void => {
    candidates.push({ ...c, dedupeKey: c.dedupeKey ?? c.key });
  };

  // CAPPED, because obligations rank ABOVE the roster and would otherwise let
  // one peer own the whole budget. Oldest first, so a long-outstanding one is
  // never starved; the remainder collapses to a countable line.
  //
  // EXPIRY IS SWEPT HERE because there is no daemon: a hook runs only when its
  // own session acts, so the check rides along with a read that happens anyway.
  store.obligations.expireDue(now);
  const obligations = store.obligations.candidates(sessionId);
  for (const obligation of obligations.slice(0, MAX_OBLIGATION_CANDIDATES))
    add(obligation);
  const crowded = obligations.length - MAX_OBLIGATION_CANDIDATES;
  if (crowded > 0)
    add({
      key: "obligations-overflow",
      priority: P.roster,
      text:
        `${crowded} further obligation(s) not shown — \`crew obligations\` lists ` +
        `them, \`crew obligation <id>\` reads one.`,
      actionable: false,
      stateVersion: `overflow:${crowded}`,
      // A COUNT WRITTEN BY THIS TOOL, not text a peer supplied — so it carries
      // no peer framing. The obligations it stands in for do; they are read
      // through `crew obligations`, where their provenance travels with them.
      origin: "system" as const,
      requiresPeerFraming: false,
    });

  if (peers.length === 0) {
    add({
      key: "alone",
      priority: P.roster,
      text:
        "No other agents are active right now. Check the roster before editing a file\n" +
        "another agent has claimed if that changes.",
      actionable: false,
      stateVersion: "alone",
      origin: "system",
      requiresPeerFraming: false,
    });
  } else {
    const roster = formatRoster(
      peers,
      claims,
      now,
      tree,
      store.taskCounts(),
      false,
      store.minionCounts(now),
    );
    add({
      key: "roster",
      priority: P.roster,
      text: [`${peers.length} other agent(s) active:`, ...roster].join("\n"),
      actionable: false,
      // Fingerprinted on the peer set and their claims, so a session whose
      // neighbours have not moved is not told about them twice.
      stateVersion: fingerprint(roster),
      origin: "peer",
      requiresPeerFraming: true,
    });
    if (recent.length > 0) {
      const log = formatMessages(recent, now);
      add({
        key: "recent",
        priority: P.recent,
        text: ["Recent activity:", ...log].join("\n"),
        actionable: false,
        stateVersion: fingerprint(log),
        origin: "peer",
        requiresPeerFraming: true,
        compact: `${log.length} recent peer message(s) — \`crew log\`.`,
      });
    }
    add({
      key: "how-to-message",
      priority: P.howTo,
      text: HOW_TO_MESSAGE,
      actionable: false,
      stateVersion: "v1",
      origin: "system",
      requiresPeerFraming: false,
    });
  }

  add({
    key: "how-to-record",
    priority: P.howTo,
    text: HOW_TO_RECORD,
    actionable: false,
    stateVersion: "v1",
    origin: "system",
    requiresPeerFraming: false,
  });
  add({
    key: "how-to-be-called",
    priority: P.howTo,
    text: HOW_TO_BE_CALLED,
    actionable: false,
    stateVersion: "v1",
    origin: "system",
    requiresPeerFraming: false,
  });

  // COUNTS AND TOPICS, never entries. Session-start context is paid by every
  // agent on every session, and an agent arriving has no file in hand yet — so
  // what it needs is to know the diary EXISTS and roughly what is in it. The
  // entries themselves arrive at `pre-edit`, when a folder is actually being
  // touched and a specific finding is worth its tokens.
  const topics = store.diary.topics();
  if (topics.length > 0) {
    const total = topics.reduce((n, t) => n + t.count, 0);
    const named = topics
      .slice(0, 6)
      .map((t) => `${t.topic} (${t.count})`)
      .join(", ");
    const more = topics.length > 6 ? `, +${topics.length - 6} more` : "";
    add({
      key: "diary",
      priority: P.diary,
      text:
        `The diary holds ${total} finding(s) other agents left about this repo, by topic: ${named}${more}.\n` +
        "`crew recall <words>` searches them; `crew topic <name>` reads one topic. Findings" +
        " about a folder you edit surface on their own. Add one with" +
        ' `crew note "<what you found>" --topic <t> --scope <folder>` — it outlives this' +
        " session and is readable from every worktree.",
      actionable: false,
      stateVersion: `${total}:${named}`,
      origin: "system",
      requiresPeerFraming: false,
      compact: `${total} diary finding(s) — \`crew recall <words>\`.`,
    });
  }

  // WHAT THIS AGENT KNOWS ABOUT THE OPERATOR. Titles only, and only its own.
  // Keyed on the CONVERSATION first so a rename cannot orphan it, on the
  // lineage second so a disciple still inherits. See `forConversation`.
  const inherited = input.lineageFrom;
  const lineage = inherited !== "" ? inherited : lineageKey(me, sessionId);
  const mine = withPersonal((personal) =>
    personal.forConversation(sessionId, lineage, projectName),
  );
  if (mine.length > 0) {
    // WHOSE knowledge, when it is not your own. An inherited belief is by
    // construction unverified by its inheritor, and a reader who cannot tell
    // the difference will act on a stranger's conclusion as if it were theirs.
    const head =
      inherited === ""
        ? "What you have learned about the person you work with:"
        : `What ${nameCase(inherited)} learned about the person you work with. You are` +
          ` ${discipleName(me, inherited)}, so none of this is verified by you:`;
    const body = mine.map((m) => `  - ${m.title}${m.global ? "" : ` (in ${m.project})`}`);
    add({
      key: "memories",
      priority: P.memories,
      text: [
        head,
        ...body,
        "`crew remember \"<what you learned>\"` adds one (`--global` if it is true of them" +
          " everywhere, not just here); `crew forget <id>` drops one that turned out wrong." +
          " They can read these with `crew about-me`.",
      ].join("\n"),
      actionable: false,
      stateVersion: fingerprint(body),
      origin: "system",
      requiresPeerFraming: false,
      compact: `${mine.length} thing(s) learned about the operator — \`crew about-me\`.`,
    });
  }

  return {
    mandatoryHeader: header,
    // Only earns its space once there is peer text to mistrust — which is
    // exactly what `requiresPeerFraming` decides, candidate by candidate.
    peerFraming: [TRUST_NOTE],
    candidates,
    targetChars: loadConfig().injectionTargetChars,
  };
}
