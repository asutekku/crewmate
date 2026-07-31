/**
 * SessionStart: register this session, then tell it who else is already working
 * in the repo and what they most recently said.
 *
 * Recent log lines are shown here as a one-off orientation summary and are NOT
 * treated as unread mail — `register` parks the cursor at the current max id so
 * the first turn does not also replay them.
 */

import { withStore } from "./store.ts";
import { emit, formatMessages, formatRoster, readPayload } from "./shared.ts";
import { currentBranch, resolveProject, worktreeRoot } from "./repo.ts";

/** Enough log to see what the others are up to, short enough to stay skimmable. */
const RECENT_LINES = 8;

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const project = resolveProject(cwd);
  const tree = worktreeRoot(cwd);

  const report = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.pruneStale(now);
    // Peers are read BEFORE registering so this session is not in its own roster.
    const peers = store.liveSessions(now).filter((s) => s.sessionId !== sessionId);
    const claims = store.allClaims(now);
    const handle = store.register(sessionId, tree, currentBranch(cwd), now);
    const recent = store.recent(RECENT_LINES);

    const lines = [`You are agent "${handle}" in ${project.name}'s shared presence log.`];
    if (peers.length === 0) {
      lines.push("No other agents are active right now.");
    } else {
      lines.push(`${peers.length} other agent(s) active:`);
      lines.push(...formatRoster(peers, claims, now, tree));
      if (recent.length > 0) {
        lines.push("", "Recent activity:");
        lines.push(...formatMessages(recent, now));
      }
    }
    lines.push(
      "",
      "State your task in one line early on (it is published to peers automatically),",
      "and check the roster before editing a file another agent has claimed.",
    );
    return { text: lines.join("\n"), handle, peerCount: peers.length };
  });

  emit(
    "SessionStart",
    report.text,
    `presence: you are "${report.handle}" — ${report.peerCount} peer(s) active`,
  );
}

try {
  await main();
} catch {
  // Fail open: coordination is a convenience, never a reason to break a session.
}
