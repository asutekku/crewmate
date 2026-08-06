/**
 * PreToolUse(Bash): refuse a loop that polls for work the harness announces.
 *
 * DENY, NOT WARN — a warning arrives beside a command that then runs for ten
 * minutes, and the reason names the replacement. NARROW BY CONSTRUCTION: a
 * loop, a wait and a task-output path must ALL appear, so polling something
 * external stays allowed. See docs/design-notes.md, "The poll-loop guard", and
 * `test/prebash.test.ts` for the cases held open on purpose.
 */

import { readPayload } from "../core/shared.ts";

/** A shell loop. `until` counts: `until [ -s f ]; do sleep 5; done` is the same bug. */
const LOOP = /\b(?:for|while|until)\b/;

/** Something that waits. `timeout` alone is not a wait -- it BOUNDS one. */
const WAIT = /\bsleep\s+[\d.]/;

/**
 * A path under the harness's own task directory.
 *
 * This is the whole discriminator. `tasks/<id>.output` is written by the
 * background-task machinery, which is exactly the machinery that also sends the
 * notification -- so a loop watching one is a loop waiting for an event it has
 * already been promised.
 */
const TASK_OUTPUT = /tasks[/\\][A-Za-z0-9_-]+\.output/;

export interface Verdict {
  readonly deny: boolean;
  readonly reason: string;
}

/**
 * Strips regions where a poll loop is DATA rather than something the shell runs
 * — a heredoc or a `bun -e` script quoting the pattern.
 *
 * Deliberately crude, and errs toward ALLOWING: a missed poll costs ten
 * minutes, a false denial teaches agents to route around the hook.
 */
function executableParts(command: string): string {
  return (
    command
      // Heredoc bodies: `<<'J' ... J`, quoted or not.
      .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ")
      // An inline script passed to an interpreter: `-e '...'` / `-e "..."`.
      // NOT `-c`: `sh -c '<poll>'` is a shell that really will wait, and
      // `test/prebash.test.ts` pins that it stays denied.
      .replace(/-e\s+(['"])[\s\S]*?\1/g, " ")
      // A comment is data. Stripped from `#` to end of line, and only where `#`
      // opens a word -- `$#`, `a#b` and a `#` inside a path are not comments.
      .replace(/(^|\s)#[^\n]*/g, "$1")
      // `echo "<poll>" > poll.sh` WRITES the pattern; it does not run it. The
      // heredoc form of exactly this was already allowed, and an agent that
      // reaches for `echo` instead should not get a different answer.
      .replace(/\becho\s+(['"])[\s\S]*?\1/g, " ")
  );
}

export function checkCommand(command: string): Verdict {
  const runnable = executableParts(command);
  const polls = LOOP.test(runnable) && WAIT.test(runnable) && TASK_OUTPUT.test(runnable);
  if (!polls) return { deny: false, reason: "" };
  return {
    deny: true,
    reason:
      "This polls a background task's output file, and the harness already tells you when " +
      "that task finishes — a <task-notification> arrives on its own. Launch the agent, do " +
      "other work, and handle the result when it lands.\n\n" +
      "It is also unsound: `-s` tests NON-EMPTY, not finished, so a task that streams output " +
      "trips the check on its first byte and the `cat` reads a PARTIAL file — which looks " +
      "exactly like a complete short answer.\n\n" +
      "If you must block on something the harness cannot see (CI, a deploy, a port opening), " +
      "use Monitor with an until-loop instead of a sleep chain.",
  };
}

async function main(): Promise<void> {
  const payload = await readPayload();
  const command = payload?.tool_input?.command ?? "";
  if (command === "") return;

  const verdict = checkCommand(command);
  if (!verdict.deny) return;

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason,
      },
    }),
  );
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A guard that crashes must not block a shell; a
  // silent catch would turn a programmer error into a hook that exits 0 having
  // checked nothing, which is indistinguishable from "this command is fine".
  console.error(`[presence] ${import.meta.file} failed:`, err);
}
