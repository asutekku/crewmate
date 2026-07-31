/**
 * PostToolBatch: deliver peer messages MID-TURN, between batches of tool calls.
 *
 * This is the closest thing to push delivery that exists. Every other injecting
 * hook fires at a turn boundary, so a session working through a long task does
 * not learn that a peer just claimed the file it is about to edit until it
 * finishes. `PostToolBatch` fires once after each batch of tool calls resolves
 * and can inject context, so news arrives while the agent can still act on it.
 *
 * IT DOES NOT WAKE AN IDLE SESSION. Nothing can: an agent sitting at a prompt
 * runs no hooks. This narrows the gap for a BUSY agent, which is the case that
 * matters — a busy agent is the one actively editing files.
 *
 * COST IS THE WHOLE DESIGN. This fires many times per turn, so the common path
 * (nothing to deliver) must be nearly free: one read-only query via `hasUnread`,
 * and return. The full store is opened only when there is something to say.
 *
 * MEASURED 2026-07-31, no mail waiting: 76 ms per firing, of which **52 ms is
 * bare Bun process startup** — the floor no in-script work can go below. Caching
 * the git-derived project paths took it from 93 ms (a `git rev-parse` subprocess
 * cost 31 ms of that). Per turn that is ~0.3 s over 5 batches, ~2.2 s over 30.
 * Acceptable beside this repo's existing 7 s-per-edit typecheck hook, but not
 * free — if it ever bites, the fix is fewer firings, not a faster script.
 *
 * `bun build --compile` was tried and REJECTED: the binary measured 85 ms, i.e.
 * SLOWER than the script, for a 98 MB artifact per hook.
 *
 * The `tool_calls` payload is deliberately never parsed — HOOKS.MD warns tool
 * responses "can be large", and this hook needs only the session id and cwd.
 *
 * NEVER BLOCKS. `PostToolBatch` can stop the agentic loop with `decision:
 * "block"`; using that for peer chatter would halt a session mid-task over a
 * message. Only `additionalContext` is used.
 */

import { hasUnread, withStore } from "./store.ts";
import { emit, formatMessages, readPayload, TRUST_NOTE } from "./shared.ts";
import { resolveProject } from "./repo.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const project = resolveProject(cwd);
  // The fast path: no peer has said anything since this session last looked, so
  // do not pay for a write transaction on every batch of tool calls.
  if (!hasUnread(project.dbPath, sessionId)) return;

  const report = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);
    const unread = store.drainUnread(sessionId);
    if (unread.length === 0) return null;
    const lines = [`${unread.length} update(s) from other agents while you were working:`];
    lines.push(...formatMessages(unread, now));
    lines.push("", TRUST_NOTE);
    return { text: lines.join("\n"), count: unread.length };
  });

  if (!report) return;
  emit("PostToolBatch", report.text, `presence: ${report.count} peer update(s)`);
}

try {
  await main();
} catch {
  // Fail open: a coordination hook must never break a turn.
}
