/**
 * The session-start block: who is here, what they said, what this agent knows.
 *
 * IN core/ RATHER THAN IN THE HOOK because `cli.ts injection` has to inspect
 * the REAL envelope, and importing a hook module runs it — `session-start.ts`
 * has a top-level `await main()` that reads stdin, so a CLI importing it would
 * hang whenever stdin never reaches EOF (diary finding 35). Duplicating the
 * list instead would drift from what ships, and drift exactly when someone runs
 * the inspector to explain a surprise. Moving it here gives both callers one
 * source with no import hazard.
 *
 * Reads the store; writes nothing. Registration and version stamping stay in
 * the hook, so running the inspector cannot put the CLI on the roster.
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
 * What outranks what, in one table rather than in the order of the code.
 *
 * The old assembly encoded priority as the sequence of `lines.push` calls,
 * which meant reordering two blocks changed what gets dropped under pressure —
 * invisibly, because nothing was ever dropped. Naming the ranks makes the
 * decision reviewable and lets a producer be moved without moving its code.
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
 * Length plus content, not a timestamp: the question is "has this changed since
 * the recipient last saw it", and a clock answers a different one. Collisions
 * only cost a suppressed line that should have been shown, so a full hash would
 * be paying for a guarantee this does not need.
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
 * Told once, at session start, rather than repeated on every delivery — an agent
 * that has peers needs to know the channel exists; it does not need reminding
 * each turn.
 *
 * The delivery caveat is stated plainly because the alternative is an agent
 * sending a message and waiting for a reply that cannot arrive until the peer's
 * next turn.
 */
const HOW_TO_MESSAGE =
  "Peers are reachable with `bun ~/.claude/agent-presence/bin/cli.ts msg <name> " +
  '"<text>"`. A message reaches only the named agent; `say` reaches every agent. ' +
  "Delivery happens between the recipient's tool batches, or at its next turn — a " +
  "`busy` peer is mid-turn and reads it when that turn ends. The channel carries " +
  "findings, warnings about shared files, and questions between agents.";

/**
 * The work board, phrased as PERMISSION rather than instruction.
 *
 * Saying when NOT to is the load-bearing half. A line that only says "record
 * your work" fails two ways: agents dutifully open an item for "what does this
 * function do", burying the real ones, or they read it as boilerplate and ignore
 * it entirely. Naming the exemption makes it a judgement call, which is what an
 * agent is good at — and whether a checklist exists is the signal that will gate
 * the planned idle check, so it has to mean something.
 *
 * Repeated here as well as in CLAUDE.md because this reaches sessions that never
 * read one: subagents, and any repo without its own.
 */
const HOW_TO_RECORD =
  "Work worth tracking across turns can be recorded with `cli.ts doing " +
  '"<subject>" --plan "step a; step b; step c"`, ticked off with `cli.ts did <n> ' +
  '"<what changed>"`, and closed with `cli.ts done`. `cli.ts board` shows what ' +
  "every agent is working on. QUICK CHECKS AND ONE-OFF QUESTIONS DO NOT NEED A " +
  "CHECKLIST — `--plan` is optional and an item with no steps is fine.";

/**
 * WHO THIS SESSION IS, phrased to survive contact with the system prompt.
 *
 * MEASURED FAILURE, 2026-08-02. Asked "who are you", a session answered: "I'm
 * Claude Code, Anthropic's AI assistant... In this session, I'm anouk." It had
 * ranked two claims correctly. The system prompt says "You are Claude Code" and
 * is re-presented every turn; the old line here said `You are "anouk" in
 * Traffic's shared presence log` exactly once, and that sentence ARGUES for the
 * losing reading — `in ... log` scopes the name to a database row. The reply
 * mirrored the scoping straight back.
 *
 * A HOOK CANNOT WIN ON RANK. Injected text never reaches the system prompt
 * (only output styles, `--append-system-prompt`, and a subagent's own agent
 * file do), so the goal is not to overwrite "Claude Code" — it is to make the
 * name the answer to WHO, while "Claude Code" stays the answer to WHAT. Those
 * do not conflict, and the old wording never said so.
 *
 * Hence the three moves here, each earning its tokens:
 *   - the name alone on its own line, with no preposition to hide behind;
 *   - "Claude Code" CONCEDED rather than ignored, because it is true and an
 *     unaddressed truth is what produced the "I'm X, but here I'm Y" hedge;
 *   - the REASON given, not just the rule — "Claude Code" does not distinguish
 *     you from the four other agents in this tree, which in a shared repo is
 *     the only thing the name is for.
 *
 * Phrased as fact plus rationale rather than as an order. HOOKS.MD is explicit
 * that imperative injected text can read as an out-of-band command; the one
 * near-imperative ("Asked who you are, say X") stays because it names the exact
 * situation that failed, and a rule with its reason attached holds better than
 * either alone.
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
 * An agent that is not TOLD its name keeps referring to itself by whatever
 * label it can see — before sender identity existed, one typed "traffic-4b:"
 * into a message body by hand to say who it was. An assigned name nobody is
 * told is just a database column.
 *
 * THIS NO LONGER DEFINES THE NAME. It used to open "The name above is what
 * peers type at `msg`", which defines an identity as an ADDRESS — an email
 * alias — one line after `identityLines` has just asserted it as a self. Being
 * addressable is now a CONSEQUENCE of having a name, which is the true
 * relationship and the one that does not undercut the line above it.
 */
const HOW_TO_BE_CALLED =
  "Peers reach you by that name — it is what they type at `msg`, and it " +
  "survives a restart. You " +
  'can say what you ARE with `cli.ts call-you "<role>"` — "Tooling Master", ' +
  '"Keeper of Wet Things" — which appears beside your name on the roster; or take ' +
  'a different name with `cli.ts call-me "<name>"`. Both optional. Your name stays ' +
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
 * EXPORTED SO `cli.ts injection` INSPECTS THE REAL THING. An inspector that
 * rebuilt this list would drift from it in exactly the situation someone runs
 * the inspector — after a surprise — and would then report a block that was
 * never injected. Both callers pass the same store and get the same candidates;
 * only the rendering differs.
 *
 * Reads the store; writes nothing. Registration and version stamping stay in
 * `main`, because running the inspector must not make the CLI look like a
 * session on the roster.
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
        compact: `${log.length} recent peer message(s) — \`cli.ts log\`.`,
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
        "`cli.ts recall <words>` searches them; `cli.ts topic <name>` reads one topic. Findings" +
        " about a folder you edit surface on their own. Add one with" +
        ' `cli.ts note "<what you found>" --topic <t> --scope <folder>` — it outlives this' +
        " session and is readable from every worktree.",
      actionable: false,
      stateVersion: `${total}:${named}`,
      origin: "system",
      requiresPeerFraming: false,
      compact: `${total} diary finding(s) — \`cli.ts recall <words>\`.`,
    });
  }

  // WHAT THIS AGENT KNOWS ABOUT THE OPERATOR. The one place automatic injection
  // is clearly right: small, certainly relevant (it is about the person in the
  // room), and the whole difference between an agent that remembers how you
  // work and one that does not.
  //
  // Titles only, and only this LINEAGE's — Hopper's read of the operator is not
  // Luna's, deliberately. Keyed on the lineage rather than the uuid so a
  // successor arrives already knowing what its predecessor learned.
  const inherited = input.lineageFrom;
  const lineage = inherited !== "" ? inherited : lineageKey(me, sessionId);
  const mine = withPersonal((personal) => personal.forLineage(lineage, projectName));
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
        "`cli.ts remember \"<what you learned>\"` adds one (`--global` if it is true of them" +
          " everywhere, not just here); `cli.ts forget <id>` drops one that turned out wrong." +
          " They can read these with `cli.ts about-me`.",
      ].join("\n"),
      actionable: false,
      stateVersion: fingerprint(body),
      origin: "system",
      requiresPeerFraming: false,
      compact: `${mine.length} thing(s) learned about the operator — \`cli.ts about-me\`.`,
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

