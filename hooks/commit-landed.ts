/**
 * PostToolUse on Bash: notice that a commit landed, and record it.
 *
 * THE ONE THING ON THE BOARD NOBODY HAS TO REMEMBER. A sha is proof the work is
 * real — the difference between a checklist an agent wrote and a record of what
 * actually happened — and it is the single fact a hook can establish without
 * asking. Everything else on an item is a claim; this is evidence.
 *
 * READS THE RESULT, NOT THE COMMAND. A `git commit` that fails a pre-commit hook
 * or finds nothing staged still ran, and recording it would put a sha-less
 * "landed" on the board for work that did not land. Git prints
 * `[branch abc1234] subject` on success and nothing of the kind otherwise, so
 * the sha is taken from the OUTPUT and an absent one means no commit happened.
 *
 * `git commit -q` PRINTS NOTHING, so a quiet commit is invisible here and is
 * recorded by nobody. Measured 2026-08-01 by probing both forms: the quiet one
 * emitted no matching line at all. That is the deliberate trade — silently
 * MISSING a commit costs the board one event, where inventing one from the
 * command text would put a sha nobody can look up next to work that may not
 * exist. `cli.ts did`/`step` still record it by hand.
 *
 * NEVER BLOCKS AND EMITS NOTHING. The agent already knows it committed; telling
 * it so would spend context on news it just made.
 */

import { withStore } from "../core/store.ts";
import { readPayload } from "../core/shared.ts";
import { resolveProject } from "../core/repo.ts";
import { agentKey } from "../core/work.ts";

/**
 * `[master 074bb51] feat(presence): …` — git's own success line.
 *
 * Also matches the detached and root-commit forms (`[detached HEAD abc1234]`,
 * `[master (root-commit) abc1234]`), which differ only in what sits before the
 * sha. A branch name can contain almost anything, so the anchor is the SHA
 * SHAPE at the end of the bracket rather than the branch at the start.
 */
export const COMMITTED = /^\[[^\]]*?\b([0-9a-f]{7,40})\]\s*(.*)$/m;

/**
 * The sha and subject a git run reports, or null when nothing landed.
 *
 * Split out from `main` so the parse can be tested against real git output
 * without spawning a hook. The shapes it has to survive are not guessable —
 * see the test file, where each one is a captured `git` run rather than an
 * invented string.
 */
export function parseCommit(output: string): { sha: string; subject: string } | null {
  const m = COMMITTED.exec(output);
  if (!m) return null;
  const sha = (m[1] ?? "").slice(0, 7);
  if (sha === "") return null;
  return { sha, subject: (m[2] ?? "").trim() };
}

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  // The command is checked first only as a cheap filter — the OUTPUT is what
  // decides. Without this every `ls` would pay for a db open.
  const command = payload.tool_input?.command ?? "";
  if (!/\bgit\b[\s\S]*\bcommit\b/.test(command)) return;

  const output = `${payload.tool_response?.stdout ?? ""}\n${payload.tool_response?.stderr ?? ""}`;
  const landed = parseCommit(output);
  if (!landed) return;
  const { sha, subject } = landed;

  withStore(resolveProject(cwd).dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);
    // Attached to whatever item the agent has open, which is what `did`/`step`
    // already do — a commit with no open item is not worth inventing one for.
    store.work.recordLanded(agentKey("", sessionId), sha, subject, now);
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
