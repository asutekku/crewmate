/**
 * PostToolBatch: deliver peer messages MID-TURN, between batches of tool calls.
 * The closest thing to push delivery there is — every other injecting hook
 * fires at a turn boundary. It cannot wake an IDLE session; nothing can.
 *
 * COST IS THE WHOLE DESIGN, since this fires many times per turn: the empty
 * path is one read-only `hasUnread` and return. NEVER BLOCKS — only
 * `additionalContext`, never `decision: "block"`. See docs/design-notes.md.
 */

import { hasUnread, withStore } from "../core/store.ts";
import { emit, formatMessages, readPayload, TRUST_NOTE } from "../core/shared.ts";
import { resolveProject } from "../core/repo.ts";

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
} catch (err) {
  // Fail open — but REPORT. A silent catch makes a programmer error look like
  // "nothing to report", which is how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
}
