/**
 * SessionStart: register this session, then tell it who else is already working
 * in the repo and what they most recently said.
 *
 * Recent log lines are shown here as a one-off orientation summary and are NOT
 * treated as unread mail — `register` parks the cursor at the current max id so
 * the first turn does not also replay them.
 */

import { displayName, withStore } from "./store.ts";
import { emit, formatMessages, formatRoster, readPayload, TRUST_NOTE } from "./shared.ts";
import { currentBranch, installedVersion, resolveProject, worktreeRoot } from "./repo.ts";
import { listAgents } from "./agents.ts";

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
    const handle = store.register(sessionId, tree, currentBranch(cwd), now);
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
    } else {
      lines.push(`${peers.length} other agent(s) active:`);
      lines.push(...formatRoster(peers, claims, now, tree, store.taskCounts()));
      if (recent.length > 0) {
        lines.push("", "Recent activity:");
        lines.push(...formatMessages(recent, now));
      }
      lines.push("", HOW_TO_MESSAGE);
      // The trust note only earns its space once there is peer text to mistrust.
      lines.push("", TRUST_NOTE);
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
