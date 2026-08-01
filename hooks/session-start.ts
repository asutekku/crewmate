/**
 * SessionStart: register this session, then tell it who else is already working
 * in the repo and what they most recently said.
 *
 * Recent log lines are shown here as a one-off orientation summary and are NOT
 * treated as unread mail — `register` parks the cursor at the current max id so
 * the first turn does not also replay them.
 */

import { displayName, withStore } from "../core/store.ts";
import { emit, formatMessages, formatRoster, readPayload, TRUST_NOTE } from "../core/shared.ts";
import { currentBranch, installedVersion, resolveProject, worktreeRoot } from "../core/repo.ts";
import { listAgents } from "../core/agents.ts";
import { withPersonal } from "../core/personal.ts";

/** Enough log to see what the others are up to, short enough to stay skimmable. */
const RECENT_LINES = 8;

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
 * The name is stated as a fact, the role offered as a choice.
 *
 * An agent that is not TOLD its name keeps referring to itself by whatever
 * label it can see — before sender identity existed, one typed "traffic-4b:"
 * into a message body by hand to say who it was. An assigned name nobody is
 * told is just a database column.
 */
const HOW_TO_BE_CALLED =
  "The name above is what peers type at `msg`, and it survives a restart. You " +
  'can say what you ARE with `cli.ts call-you "<role>"` — "Tooling Master", ' +
  '"Keeper of Wet Things" — which appears beside your name on the roster; or take ' +
  'a different name with `cli.ts call-me "<name>"`. Both optional. Your name stays ' +
  "put while the role changes, so a role that moves still reads as the same agent." +
  "\n\nWHEN YOU MENTION A PEER IN TEXT THE USER READS, give their role too: " +
  '"adela (the road-network agent) is fixing this" rather than "adela is fixing ' +
  'this". The user is looking at eight windows and a bare given name identifies ' +
  "nobody — the roster above lists each peer's role in parentheses after its name.";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const project = resolveProject(cwd);
  const tree = worktreeRoot(cwd);

  // ~950 ms, so it belongs here and nowhere on a per-prompt path. Session start
  // is rare and already slow, and this is the moment the roster is read.
  const agents = listAgents();

  const report = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.pruneStale(now);
    const handle = store.registerAndRestore(sessionId, tree, currentBranch(cwd), now);
    // Recorded once, here, because this is the moment the scripts were loaded —
    // stamping it later would report the version installed by then, not the one
    // actually running.
    store.setCodeVersion(sessionId, installedVersion());
    // Registered first, so this session's own name is filled in too.
    if (agents.length > 0) store.syncAgents(agents);

    const all = store.liveSessions(now);
    const self = all.find((s) => s.sessionId === sessionId);
    const peers = all.filter((s) => s.sessionId !== sessionId);
    const claims = store.allClaims(now);
    const recent = store.recent(RECENT_LINES, sessionId);

    const me = self ? displayName(self) : handle;
    const lines = [`You are "${me}" in ${project.name}'s shared presence log.`];
    if (peers.length === 0) {
      lines.push(
        "No other agents are active right now. Check the roster before editing a file",
        "another agent has claimed if that changes.",
      );
      // The BOARD is worth mentioning with no peers around; messaging is not.
      // A record outlives the session that opened it and is keyed on the
      // conversation, so work started alone is exactly what a peer arriving in
      // an hour needs to be able to read.
      lines.push("", HOW_TO_RECORD);
      lines.push("", HOW_TO_BE_CALLED);
    } else {
      lines.push(`${peers.length} other agent(s) active:`);
      lines.push(
        ...formatRoster(peers, claims, now, tree, store.taskCounts(), false, store.minionCounts(now)),
      );
      if (recent.length > 0) {
        lines.push("", "Recent activity:");
        lines.push(...formatMessages(recent, now));
      }
      lines.push("", HOW_TO_MESSAGE);
      lines.push("", HOW_TO_RECORD);
      lines.push("", HOW_TO_BE_CALLED);
      // The trust note only earns its space once there is peer text to mistrust.
      lines.push("", TRUST_NOTE);
    }
    // COUNTS AND TOPICS, never entries. Session-start context is paid by every
    // agent on every session, and an agent arriving has no file in hand yet —
    // so what it needs is to know the diary EXISTS and roughly what is in it.
    // The entries themselves arrive at `pre-edit`, when a folder is actually
    // being touched and a specific finding is worth its tokens.
    const topics = store.diary.topics();
    if (topics.length > 0) {
      const total = topics.reduce((n, t) => n + t.count, 0);
      const named = topics
        .slice(0, 6)
        .map((t) => `${t.topic} (${t.count})`)
        .join(", ");
      const more = topics.length > 6 ? `, +${topics.length - 6} more` : "";
      lines.push(
        "",
        `The diary holds ${total} finding(s) other agents left about this repo, by topic: ${named}${more}.`,
        "`cli.ts recall <words>` searches them; `cli.ts topic <name>` reads one topic. Findings" +
          " about a folder you edit surface on their own. Add one with" +
          ' `cli.ts note "<what you found>" --topic <t> --scope <folder>` — it outlives this' +
          " session and is readable from every worktree.",
      );
    }
    // WHAT THIS AGENT KNOWS ABOUT THE OPERATOR. The one place automatic
    // injection is clearly right: small, certainly relevant (it is about the
    // person in the room), and the whole difference between an agent that
    // remembers how you work and one that does not.
    //
    // Titles only, and only this agent's own — Hopper's read of the operator is
    // not Luna's, deliberately.
    const mine = withPersonal((personal) =>
      personal.forSession(sessionId, project.name),
    );
    if (mine.length > 0) {
      lines.push("", "What you have learned about the person you work with:");
      for (const m of mine) lines.push(`  - ${m.title}${m.global ? "" : ` (in ${m.project})`}`);
      lines.push(
        "`cli.ts remember \"<what you learned>\"` adds one (`--global` if it is true of them" +
          " everywhere, not just here); `cli.ts forget <id>` drops one that turned out wrong." +
          " They can read these with `cli.ts about-me`.",
      );
    }
    return { text: lines.join("\n"), name: me, peerCount: peers.length };
  });

  emit(
    "SessionStart",
    report.text,
    `presence: you are "${report.name}" — ${report.peerCount} peer(s) active`,
  );
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A silent catch turns a programmer error into a
  // hook that exits 0 having done nothing, which is indistinguishable from
  // "nothing to report" and is exactly how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
  // Fail open: coordination is a convenience, never a reason to break a session.
}
