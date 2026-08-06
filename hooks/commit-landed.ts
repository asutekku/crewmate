/**
 * PostToolUse on Bash: notice that a commit landed, and record it. A sha is the
 * one thing on the board that is EVIDENCE rather than a claim.
 *
 * READS THE RESULT, NOT THE COMMAND, so a failed `git commit` records nothing.
 * `git commit -q` prints nothing and is therefore missed — the deliberate
 * trade, since inventing a sha is worse. EMITS NOTHING: the agent was there.
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
 * The sha and subject a git run reports, or null when nothing landed. Split out
 * so the parse is tested against captured git output, not invented strings.
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
  // Fail open — but REPORT. A silent catch makes a programmer error look like
  // "nothing to report", which is how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
}
