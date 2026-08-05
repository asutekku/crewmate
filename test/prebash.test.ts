/**
 * The poll-loop guard: what it refuses, and the far longer list of what it must
 * not.
 *
 * A GUARD THAT OVERREACHES IS WORSE THAN NO GUARD. This one denies a tool call
 * outright, so a false positive does not merely annoy — it blocks legitimate
 * work and teaches the next agent to route around the hook. Hence the balance
 * of this file: two describes for the pattern it exists to stop, four for the
 * things that look like it and are fine, and one that pins the known gaps so
 * that changing one is a decision rather than an accident.
 *
 * THE REAL COMMAND, recorded verbatim below, was seen in a peer's shell on
 * 2026-08-02: a 60×10s poll on a background task's output file, waiting for an
 * event the harness already announces with a <task-notification>.
 *
 * WHICH DIRECTION TO ERR. The two failure modes are not symmetric. A missed
 * poll loop costs ten minutes and a possibly-truncated read. A false denial
 * blocks real work and trains the agent to phrase the same command differently
 * until it gets through — after which the guard protects nothing. Every case in
 * "known gaps" that leans toward ALLOW is therefore acceptable; the ones that
 * lean toward DENY are the ones worth fixing first.
 *
 * BOTH OVER-BLOCKS THAT WERE PINNED HERE ARE NOW FIXED — a comment describing
 * the pattern, and `echo`ing it into a file. They moved into the DATA describe
 * above, and the pinning is what made that a decision instead of a surprise:
 * changing the hook turned two green tests red and named exactly what moved.
 * The remaining gaps all under-block, which is the tolerable direction.
 */

import { describe, expect, test } from "bun:test";

import { checkCommand } from "../hooks/pre-bash.ts";

const denied = (cmd: string): boolean => checkCommand(cmd).deny;

/** The exact command that motivated the guard, as typed. */
const REAL_POLL =
  'cd "I:/Projects/Traffic" && for i in $(seq 1 60); do if [ -s ' +
  '"C:/Users/akU/AppData/Local/Temp/claude/I--Projects-Traffic/d881f8ac/tasks/b0o9k4oas.output" ]; ' +
  'then echo "DONE"; break; fi; sleep 10; done; echo "--- output ---"; cat ' +
  '"C:/Users/akU/AppData/Local/Temp/claude/I--Projects-Traffic/d881f8ac/tasks/b0o9k4oas.output" 2>/dev/null | tail -40';

describe("the pattern it exists to stop", () => {
  test("the real command that motivated this is denied", () => {
    expect(denied(REAL_POLL)).toBe(true);
  });

  test("the reason names the replacement, not just the refusal", () => {
    // A refusal that does not say what to do instead is one an agent routes
    // around — it will simply write the loop a different way.
    const why = checkCommand(REAL_POLL).reason;
    expect(why).toContain("task-notification");
    expect(why).toContain("Monitor");
    // And it explains the CORRECTNESS bug, which is the half an agent would
    // otherwise dismiss as mere style.
    expect(why).toContain("PARTIAL");
  });

  test("`until` and `while` are the same bug", () => {
    expect(denied("until [ -s tasks/abc.output ]; do sleep 5; done")).toBe(true);
    expect(denied("while [ ! -s tasks/abc.output ]; do sleep 2; done")).toBe(true);
  });

  test("windows-style separators still match", () => {
    expect(denied('for i in 1 2 3; do sleep 5; cat "C:\\tmp\\tasks\\x9.output"; done')).toBe(true);
  });

  test("a fractional sleep does not slip through", () => {
    expect(denied("while true; do sleep 0.5; cat tasks/q1.output; done")).toBe(true);
  });

  test("the multi-line form is the same command", () => {
    // Newlines instead of semicolons — how it looks when written into a script
    // rather than typed at a prompt. Nothing in the guard is line-anchored.
    const cmd =
      "for i in $(seq 1 60)\n" +
      "do\n" +
      "  if [ -s tasks/b0o9k4oas.output ]; then break; fi\n" +
      "  sleep 10\n" +
      "done\n" +
      "cat tasks/b0o9k4oas.output";
    expect(denied(cmd)).toBe(true);
  });

  test("the wait and the read need not be in the same statement", () => {
    // The loop sleeps blind and the read happens after it. Same ten minutes,
    // same truncation risk, and the conjunction still holds across `;`.
    expect(denied("for i in $(seq 1 60); do sleep 10; done; cat tasks/x.output")).toBe(true);
  });

  test("a poll handed to `sh -c` or `bash -c` is still a poll", () => {
    // Only `-e` payloads are stripped as data; `-c` is not, and must not be —
    // this is a shell that really will wait.
    expect(denied(`sh -c 'for i in 1 2; do sleep 5; cat tasks/x.output; done'`)).toBe(true);
    expect(denied(`bash -c "until [ -s tasks/x.output ]; do sleep 5; done"`)).toBe(true);
  });

  test("a break-on-test loop, the shape agents write after a plain `sleep` is refused", () => {
    expect(denied("while :; do sleep 1; [ -s tasks/x.output ] && break; done")).toBe(true);
  });

  test("the path can arrive via a variable, as long as it is written once", () => {
    expect(denied('OUT=tasks/x.output; until [ -s "$OUT" ]; do sleep 5; done')).toBe(true);
  });
});

describe("each conjunct, at its edges", () => {
  // The guard is three regexes ANDed together. These pin the boundary of each
  // one independently, so a future tweak to one cannot quietly widen or narrow
  // the whole.

  test("the loop keyword must stand alone", () => {
    // `\b(?:for|while|until)\b` — substrings of ordinary identifiers are not
    // loops, and `sleepy_check` is not a wait.
    expect(denied("formatted=1; sleepy_check; cat tasks/x.output")).toBe(false);
    expect(denied("beforehand=1; sleep 5; cat tasks/x.output")).toBe(false);
  });

  test("whitespace between `sleep` and its argument is arbitrary", () => {
    expect(denied("until [ -s tasks/x.output ]; do sleep\t10; done")).toBe(true);
    expect(denied("until [ -s tasks/x.output ]; do sleep   10; done")).toBe(true);
  });

  test("a leading-dot sleep is a sleep", () => {
    expect(denied("while true; do sleep .5; cat tasks/q1.output; done")).toBe(true);
  });

  test("the task id may be any of the harness's id characters", () => {
    for (const id of ["b0o9k4oas", "B0O9K4OAS", "my_task-01", "0000"]) {
      expect(denied(`until [ -s tasks/${id}.output ]; do sleep 3; done`)).toBe(true);
    }
  });

  test("the tasks directory can sit at any depth", () => {
    expect(denied("until [ -s ./run/d881f8ac/tasks/b0.output ]; do sleep 3; done")).toBe(true);
    expect(denied("until [ -s /tmp/claude/x/y/z/tasks/b0.output ]; do sleep 3; done")).toBe(true);
  });
});

describe("polling something the harness CANNOT see stays allowed", () => {
  // The distinction the whole guard turns on. Waiting is not the problem;
  // waiting for an event you have already been promised is.
  test("waiting for a dev server to come up", () => {
    expect(denied("until curl -s localhost:3000 >/dev/null; do sleep 2; done")).toBe(false);
  });

  test("waiting on a CI run", () => {
    expect(denied('while [ "$(gh run view --json status -q .status)" != "completed" ]; do sleep 30; done')).toBe(
      false,
    );
  });

  test("waiting for a file that is not a task output", () => {
    expect(denied("until [ -s dist/bundle.js ]; do sleep 1; done")).toBe(false);
    expect(denied("while [ ! -f /tmp/build.lock ]; do sleep 5; done")).toBe(false);
  });

  test("waiting for a port to open", () => {
    expect(denied("while ! nc -z localhost 5173; do sleep 1; done")).toBe(false);
  });

  test("a filename that merely contains the word tasks", () => {
    // `tasks-report.txt` is not `tasks/<id>.output` — the discriminator is the
    // harness's own layout, not the word.
    expect(denied("until [ -s ~/.cache/tasks-report.txt ]; do sleep 5; done")).toBe(false);
  });
});

describe("ordinary commands are untouched", () => {
  test("a loop with no wait", () => {
    expect(denied("for f in src/*.ts; do wc -l $f; done")).toBe(false);
  });

  test("a wait with no loop", () => {
    expect(denied("sleep 5; echo done")).toBe(false);
  });

  test("READING a task output once is fine — that is not polling", () => {
    // After a notification arrives, reading the file is exactly right.
    expect(denied("cat tasks/b0o9k4oas.output | tail -40")).toBe(false);
    expect(denied("cat tasks/a.output tasks/b.output | tail -40")).toBe(false);
  });

  test("a loop that merely mentions a task path without waiting", () => {
    expect(denied("for f in tasks/*.output; do echo $f; done")).toBe(false);
  });

  test("consuming a task output line by line", () => {
    // A `while read` loop over a finished file. Loop and task path, no wait.
    expect(denied("while read -r l; do echo $l; done < tasks/x.output")).toBe(false);
  });

  test("a one-shot sleep before reading is not a poll", () => {
    // Crude, but it waits once and reads once — no loop, nothing to refuse.
    expect(denied("sleep 30; cat tasks/x.output")).toBe(false);
  });

  test("`timeout` BOUNDS a wait rather than being one", () => {
    expect(denied("timeout 600 bun test; cat tasks/x.output | tail -40")).toBe(false);
  });

  test("grepping for the literal text is not running it", () => {
    expect(denied(`grep -rn "sleep 10" ~/.claude/tasks/x.output`)).toBe(false);
  });

  test("the tool's own test and git commands", () => {
    for (const cmd of [
      "bun test test/prebash.test.ts",
      "git commit -F msg.txt -o -- a.ts b.ts",
      "crew who",
      "for i in 1 2 3; do bun test; done",
    ]) {
      expect(denied(cmd)).toBe(false);
    }
  });

  test("an empty command is not a crash", () => {
    expect(denied("")).toBe(false);
    expect(denied("   \n\t ")).toBe(false);
  });
});

describe("a poll loop quoted as DATA is not a poll loop", () => {
  // FOUND BY THE GUARD BLOCKING THE COMMAND THAT WAS TESTING IT, minutes after
  // install. Both of these mention the pattern; neither makes the shell wait.
  test("a heredoc writing the pattern into a fixture", () => {
    const cmd =
      "cat > poll.json <<'J'\n" +
      '{"command":"for i in $(seq 1 60); do sleep 10; cat tasks/b0.output; done"}\n' +
      "J\necho written";
    expect(denied(cmd)).toBe(false);
  });

  test("an inline script listing it as a test case", () => {
    const cmd =
      `bun -e 'const cases = [["poll", "for i in 1 2; do sleep 5; cat tasks/x.output; done"]];` +
      ` for (const c of cases) console.log(c);'`;
    expect(denied(cmd)).toBe(false);
  });

  test("a comment describing the pattern", () => {
    // WAS A PINNED OVER-BLOCK and is now fixed — a comment is data, and this
    // was the dangerous direction: a false denial blocks real work and teaches
    // the agent to rephrase until it gets through.
    const cmd = "# for i in $(seq 1 60); do sleep 10; cat tasks/x.output; done\nbun test";
    expect(denied(cmd)).toBe(false);
  });

  test("`echo` WRITING the pattern into a file", () => {
    // Also a fixed over-block. The heredoc form of exactly this was already
    // allowed, so an agent reaching for `echo` instead must not get a different
    // answer — an inconsistent guard is one that reads as arbitrary.
    expect(denied(`echo "for i in 1 2; do sleep 5; cat tasks/x.output; done" > poll.sh`)).toBe(
      false,
    );
  });

  test("a `#` that does not open a word is not a comment", () => {
    // `$#`, `a#b`, and a `#` inside a path must not swallow the rest of the
    // line — stripping too eagerly is how a real poll slips through.
    expect(denied("until [ $# -gt 0 ] && [ -s tasks/x.output ]; do sleep 5; done")).toBe(true);
  });

  test("but a REAL loop beside a heredoc is still caught", () => {
    // The stripping must not become a way to smuggle one past the guard.
    const cmd =
      "cat > note.txt <<'X'\nharmless\nX\n" +
      "for i in $(seq 1 60); do sleep 10; cat tasks/b0.output; done";
    expect(denied(cmd)).toBe(true);
  });

  test("the delimiter may be unquoted or double-quoted", () => {
    const unquoted =
      "cat > a.json <<EOF\nfor i in 1 2; do sleep 5; cat tasks/x.output; done\nEOF\necho ok";
    const doubled =
      'cat > a.json <<"J"\nfor i in 1 2; do sleep 5; cat tasks/x.output; done\nJ\necho ok';
    expect(denied(unquoted)).toBe(false);
    expect(denied(doubled)).toBe(false);
  });

  test("`<<-` with an indented terminator", () => {
    const cmd = "cat > a.txt <<-'X'\n\tfor i in 1 2; do sleep 5; cat tasks/x.output; done\n\tX\necho ok";
    expect(denied(cmd)).toBe(false);
  });

  test("a heredoc that ends the command, with no trailing newline", () => {
    const cmd =
      "cat > poll.json <<'J'\n" +
      '{"c":"for i in 1 2; do sleep 5; cat tasks/b0.output; done"}\n' +
      "J";
    expect(denied(cmd)).toBe(false);
  });

  test("two heredocs in one command are both stripped", () => {
    const cmd =
      "cat > a <<'A'\nfor i in 1 2; do sleep 5; cat tasks/x.output; done\nA\n" +
      "cat > b <<'B'\nuntil [ -s tasks/y.output ]; do sleep 1; done\nB";
    expect(denied(cmd)).toBe(false);
  });

  test("`-e` stripping is non-greedy and cannot swallow a following loop", () => {
    // If the `-e` match ran to the LAST quote in the command, everything
    // between two harmless echoes would vanish — including a real poll.
    const one = `echo -e "starting"; for i in $(seq 1 60); do sleep 10; cat tasks/x.output; done`;
    const two = `echo -e 'a'; for i in $(seq 1 60); do sleep 10; cat tasks/x.output; done; echo -e 'b'`;
    expect(denied(one)).toBe(true);
    expect(denied(two)).toBe(true);
  });

  test("a real loop after a heredoc of either style", () => {
    const afterUnquoted =
      "cat > n.txt <<EOF\nharmless\nEOF\nfor i in $(seq 1 60); do sleep 10; cat tasks/b0.output; done";
    const afterDash = "cat > n.txt <<-'X'\n\tharmless\n\tX\nuntil [ -s tasks/b0.output ]; do sleep 5; done";
    expect(denied(afterUnquoted)).toBe(true);
    expect(denied(afterDash)).toBe(true);
  });
});

describe("the verdict contract", () => {
  test("an allowed command carries no reason", () => {
    // Callers may render `reason` unconditionally; it must be empty, not stale.
    expect(checkCommand("ls -la").reason).toBe("");
    expect(checkCommand("").reason).toBe("");
  });

  test("a denial explains the `-s` bug, not only the waste", () => {
    const why = checkCommand(REAL_POLL).reason;
    expect(why).toContain("-s");
    expect(why).toContain("NON-EMPTY");
    expect(why.length).toBeGreaterThan(100);
  });

  test("repeated calls agree", () => {
    // Guards against a stateful regex: a `/g` flag on any of LOOP, WAIT or
    // TASK_OUTPUT makes `.test` advance `lastIndex` and alternate its answer.
    for (const cmd of [REAL_POLL, "ls", "until curl -s localhost:3000; do sleep 2; done"]) {
      const first = denied(cmd);
      expect(denied(cmd)).toBe(first);
      expect(denied(cmd)).toBe(first);
    }
  });

  test("a very large command stays cheap", () => {
    // The heredoc regex scans to end-of-string from every `<<`. Keep an eye on
    // it: a hook that takes seconds is a hook someone disables.
    const big = Array.from({ length: 5000 }, (_, i) => `echo line ${i} >> out.txt`).join("\n");
    expect(denied(big)).toBe(false);
    expect(denied(`${big}\nfor i in $(seq 1 60); do sleep 10; cat tasks/x.output; done`)).toBe(true);
  }, 2000);
});

describe("known gaps — pinned so that changing one is deliberate", () => {
  // Everything here is CURRENT BEHAVIOUR, not endorsed behaviour. If a change
  // flips one of these, that is fine — but it should show up as a failing test
  // and a decision, not as a surprise in someone's shell.

  test("UNDER-BLOCKS: a delay held in a variable", () => {
    // WAIT requires a digit or dot after `sleep`.
    expect(denied("until [ -s tasks/x.output ]; do sleep $DELAY; done")).toBe(false);
    expect(denied("until [ -s tasks/x.output ]; do sleep ${DELAY}; done")).toBe(false);
  });

  test("UNDER-BLOCKS: a path assembled entirely from variables", () => {
    expect(denied('until [ -s "$dir/$id.output" ]; do sleep 5; done')).toBe(false);
  });

  test("UNDER-BLOCKS: case differences, which Windows does not care about", () => {
    expect(denied("until [ -s tasks/x.OUTPUT ]; do sleep 5; done")).toBe(false);
    expect(denied("until [ -s Tasks/x.output ]; do sleep 5; done")).toBe(false);
  });

  test("UNDER-BLOCKS: an id containing a dot", () => {
    // TASK_OUTPUT's id class is [A-Za-z0-9_-], so `b0.9k` breaks the match.
    expect(denied("until [ -s tasks/b0.9k.output ]; do sleep 5; done")).toBe(false);
  });

  test("UNDER-BLOCKS: a glob over task outputs", () => {
    expect(denied("for f in tasks/*.output; do sleep 1; echo $f; done")).toBe(false);
  });

  test("UNDER-BLOCKS: a busy loop with no sleep at all", () => {
    // Same wrong idea, more expensive. WAIT is a required conjunct, so it goes
    // through — narrowness bought at a price worth naming.
    expect(denied("while [ ! -s tasks/x.output ]; do bun test; done")).toBe(false);
  });

  test("UNDER-BLOCKS: an `-e` payload that really would poll", () => {
    // Acknowledged in the hook: the stripper cannot tell a fixture from a
    // script that will actually run. It errs toward allowing, on purpose.
    expect(denied(`bun -e 'for i in 1 2; do sleep 5; cat tasks/x.output; done'`)).toBe(false);
  });

  test("OVER-BLOCKS: an unterminated heredoc falls back to the raw text", () => {
    // No closing delimiter means no match, so nothing is stripped and the body
    // is read as shell. Rare, but it fails closed rather than open.
    const cmd = "cat > a <<'A'\nfor i in 1 2; do sleep 5; cat tasks/x.output; done";
    expect(denied(cmd)).toBe(true);
  });
});