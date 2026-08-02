/**
 * PreToolUse(Bash): refuse a loop that polls for work the harness announces.
 *
 * THE PATTERN, seen live 2026-08-02 in a peer's shell:
 *
 *     for i in $(seq 1 60); do
 *       if [ -s ".../tasks/b0o9k4oas.output" ]; then echo DONE; break; fi
 *       sleep 10
 *     done; cat ".../tasks/b0o9k4oas.output" | tail -40
 *
 * Ten minutes of a turn spent re-deriving something the harness sends for free:
 * a background task emits a `<task-notification>` when it finishes, so the agent
 * can launch it, do other work, and handle the result when it lands.
 *
 * AND IT IS WRONG, not merely wasteful. `-s` tests "non-empty", not "finished".
 * A task that streams output trips it on the first byte, so the `cat` reads a
 * PARTIAL file and the agent treats half an answer as the whole one. That is
 * silent — it looks exactly like a complete short answer. Measured the same day
 * from the other direction: reading a task output file mid-run returned empty.
 *
 * WHY A HOOK AND NOT A CLAUDE.md LINE. The harness already refuses a bare
 * leading `sleep`, which is why this shape appears at all — an agent reaches for
 * `sleep`, gets refused, and wraps it in a loop, where the existing block does
 * not look. Verified 2026-08-02: `for i in $(seq 1 2); do ...; sleep 1; done`
 * runs with exit 0. A written rule is advice; this is the seam the advice keeps
 * leaking through, so the guard belongs where the leak is.
 *
 * DENY, NOT WARN. A warning arrives alongside a command that then runs for ten
 * minutes, so the agent reads the correction after paying the cost. `deny`
 * returns immediately with the reason, and the reason names the replacement —
 * a refusal that does not say what to do instead is one an agent routes around.
 *
 * NARROW BY CONSTRUCTION. It fires only when a loop, a wait, and a task-output
 * path all appear together. Every part of that conjunction is load-bearing:
 * polling an EXTERNAL thing the harness cannot see (a CI run, a deploy, a
 * server coming up) is legitimate and stays allowed, and so does any loop that
 * merely sleeps. See `test/prebash.test.ts` for the cases held open on purpose.
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
 * Strips regions where a poll loop is DATA rather than something the shell runs.
 *
 * Found immediately, by this guard blocking the command that was testing it: a
 * heredoc feeding the pattern to a JSON fixture, and a `bun -e` script listing
 * it as a test case, both read as poll loops. Neither makes the shell wait for
 * anything — the text is an argument.
 *
 * This is deliberately crude. It cannot know whether a quoted region is data or
 * a `bash -c` payload that really will poll, and it errs toward ALLOWING, which
 * is the right direction for a guard that denies: a missed poll costs ten
 * minutes, a false denial blocks work and teaches agents to route around the
 * hook. The unit tests pin the raw patterns; this only widens what gets through.
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
