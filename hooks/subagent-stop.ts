/**
 * SubagentStop: close the minion row its Start opened.
 *
 * Writes nothing an agent reads — no `emit`, so a subagent's last act is not
 * spent on context it will never use. This exists for the OPERATOR: without it
 * a finished minion stays on `who` as work still in progress, and the roster's
 * whole claim is that it describes now.
 *
 * IT IS ALSO WHERE THE TASK NAME ARRIVES. SubagentStart carries `agent_id` and
 * `agent_type` but no description; Stop carries the parent's own `description`
 * in `background_tasks`. That string is free — the parent already wrote it when
 * spawning — which is why naming a minion's task needs no model call and no
 * convention for an agent to remember. (Measured 2026-08-01 by probing both
 * events; the payload type in `core/shared.ts` records the shape.)
 */

import { withStore } from "../core/store.ts";
import { readPayload } from "../core/shared.ts";
import { resolveProject } from "../core/repo.ts";

/** A roster line, not a description — the long form is the parent's to tell. */
const MAX_TASK = 80;

async function main(): Promise<void> {
  const payload = await readPayload();
  const agentId = payload?.agent_id;
  const cwd = payload?.cwd;
  if (!payload || !agentId || !cwd) return;

  // Matched by id, because a parent running several at once reports ALL of them
  // here — taking the first would name this minion after a sibling's work.
  const task = payload.background_tasks?.find((t) => t.id === agentId)?.description ?? "";

  withStore(resolveProject(cwd).dbPath, (store) => {
    const now = Date.now();
    store.endMinion(agentId, now, task.slice(0, MAX_TASK));
    // Cheap, and this is the one event that reliably fires while a parent is
    // alive — so it is where a crashed parent's abandoned rows get swept.
    store.pruneMinions(now);
  });
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A silent catch turns a programmer error into a hook
  // that exits 0 having done nothing, which is indistinguishable from "nothing
  // to report" and is exactly how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
}
