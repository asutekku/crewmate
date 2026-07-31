/**
 * SubagentStart: tell a spawned subagent which files its parent's peers hold.
 *
 * A subagent begins with an empty context. It inherits none of the parent's
 * roster knowledge, yet it edits real files — so today its first contact with
 * this system is an overlap warning AFTER it has already chosen what to edit.
 * This makes that knowledge available before the first decision instead.
 *
 * DELIBERATELY MINIMAL: claimed paths only. No message history (a subagent is
 * not a correspondent and cannot be addressed), no messaging instructions, and
 * no `claude agents --json` call — a subagent spawn is frequent enough that the
 * ~950 ms sample would be felt.
 *
 * NOTHING TO CLEAN UP AFTERWARDS. Subagents never fire SessionStart, so they
 * never enter the roster; their tool calls carry the PARENT's `session_id`, so
 * claims they make are already attributed to the parent, which is correct — the
 * parent's tree is where the edit lands.
 */

import { claimName, withStore } from "./store.ts";
import { emit, readPayload } from "./shared.ts";
import { resolveProject } from "./repo.ts";

/** Enough to spot a collision; a full list would crowd a fresh context. */
const MAX_PATHS = 10;

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const project = resolveProject(cwd);

  const text = withStore(project.dbPath, (store) => {
    const now = Date.now();
    const claims = store.allClaims(now);
    const sessions = store.liveSessions(now);
    const self = sessions.find((s) => s.sessionId === sessionId);
    // Only OTHER sessions' claims: the parent's own are this subagent's to edit.
    const others = claims.filter((c) => c.handle !== self?.handle);
    if (others.length === 0) return null;

    const byHandle = new Map<string, string[]>();
    for (const c of others.slice(0, MAX_PATHS)) {
      // `c.path` is ALREADY tree-relative (`pre-edit` relativises before
      // storing), so it is used as-is. Re-relativising here would be a no-op at
      // best and wrong at worst — it would measure a peer's path against THIS
      // session's tree.
      byHandle.set(claimName(c), [...(byHandle.get(claimName(c)) ?? []), c.path]);
    }
    const lines = ["Other Claude Code sessions in this project are editing these files:"];
    for (const [who, paths] of byHandle) lines.push(`  ${who}: ${paths.join(", ")}`);
    lines.push(
      "Edits to them may collide with work already in progress elsewhere in this tree.",
    );
    return lines.join("\n");
  });

  if (!text) return;
  emit("SubagentStart", text);
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A silent catch turns a programmer error into a
  // hook that exits 0 having done nothing, which is indistinguishable from
  // "nothing to report" and is exactly how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
  // Fail open.
}
