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
 * IT ALSO RECORDS THE MINION, so `who` can show what a parent has running.
 * Subagents never fire SessionStart and never enter the roster; their tool
 * calls carry the PARENT's `session_id`, so claims they make are already
 * attributed to the parent, which is correct — the parent's tree is where the
 * edit lands. The minions table is purely so the operator can see them; it
 * changes no attribution.
 */

import { claimName, displayName, withStore } from "../core/store.ts";
import { emit, readPayload } from "../core/shared.ts";
import { minionName, nameCase } from "../core/names.ts";
import { resolveProject } from "../core/repo.ts";

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
    // Recorded FIRST and unconditionally: the roster line is owed to the
    // operator whether or not this subagent gets a warning to read. Returning
    // early on "no claims to report" below would have skipped it.
    let seq = 0;
    if (payload.agent_id) {
      seq = store.startMinion(payload.agent_id, sessionId, now, {
        ...(payload.agent_type !== undefined ? { agentType: payload.agent_type } : {}),
      });
    }
    const claims = store.allClaims(now);
    const sessions = store.liveSessions(now);
    const self = sessions.find((s) => s.sessionId === sessionId);
    // WHO THIS SUBAGENT IS, before anything it might collide with. A minion
    // arrives with an empty context and its own system prompt saying "Claude
    // Code", so it has even less to go on than a parent session does — and the
    // parent's name is the one thing that makes its edits attributable in `who`.
    // Stated even when there is nothing else to say, which is why the
    // no-claims early return below now comes after it.
    const parent = self ? displayName(self) : "";
    const identity =
      seq > 0 && parent !== ""
        ? [
            `You are ${minionName(parent, seq)}.`,
            "",
            `You are Claude Code, spawned by ${nameCase(parent)} — one of several Claude Code` +
              ` sessions working in this repo at once. Your edits are recorded under` +
              ` ${nameCase(parent)}'s name, because that is the tree they land in. Asked who` +
              ` you are, say so: peers cannot reach you directly, only ${nameCase(parent)}.`,
          ]
        : [];

    // Only OTHER sessions' claims: the parent's own are this subagent's to edit.
    const others = claims.filter((c) => c.handle !== self?.handle);
    if (others.length === 0) return identity.length > 0 ? identity.join("\n") : null;

    const byHandle = new Map<string, string[]>();
    for (const c of others.slice(0, MAX_PATHS)) {
      // `c.path` is ALREADY tree-relative (`pre-edit` relativises before
      // storing), so it is used as-is. Re-relativising here would be a no-op at
      // best and wrong at worst — it would measure a peer's path against THIS
      // session's tree.
      byHandle.set(claimName(c), [...(byHandle.get(claimName(c)) ?? []), c.path]);
    }
    const lines = [...identity];
    if (lines.length > 0) lines.push("");
    lines.push("Other Claude Code sessions in this project are editing these files:");
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
