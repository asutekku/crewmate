/**
 * The poll-loop guard: what it refuses, and the far longer list of what it must
 * not.
 *
 * A GUARD THAT OVERREACHES IS WORSE THAN NO GUARD. This one denies a tool call
 * outright, so a false positive does not merely annoy — it blocks legitimate
 * work and teaches the next agent to route around the hook. Hence the balance
 * of this file: one describe for the pattern it exists to stop, three for the
 * things that look like it and are fine.
 *
 * THE REAL COMMAND, recorded verbatim below, was seen in a peer's shell on
 * 2026-08-02: a 60×10s poll on a background task's output file, waiting for an
 * event the harness already announces with a <task-notification>.
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
    expect(denied('until [ -s tasks/abc.output ]; do sleep 5; done')).toBe(true);
    expect(denied('while [ ! -s tasks/abc.output ]; do sleep 2; done')).toBe(true);
  });

  test("windows-style separators still match", () => {
    expect(denied('for i in 1 2 3; do sleep 5; cat "C:\\tmp\\tasks\\x9.output"; done')).toBe(true);
  });

  test("a fractional sleep does not slip through", () => {
    expect(denied("while true; do sleep 0.5; cat tasks/q1.output; done")).toBe(true);
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
  });

  test("a loop that merely mentions a task path without waiting", () => {
    expect(denied("for f in tasks/*.output; do echo $f; done")).toBe(false);
  });

  test("the tool's own test and git commands", () => {
    for (const cmd of [
      "bun test test/prebash.test.ts",
      "git commit -F msg.txt -o -- a.ts b.ts",
      "bun ~/.claude/agent-presence/bin/cli.ts who",
      "for i in 1 2 3; do bun test; done",
    ]) {
      expect(denied(cmd)).toBe(false);
    }
  });

  test("an empty command is not a crash", () => {
    expect(denied("")).toBe(false);
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

  test("but a REAL loop beside a heredoc is still caught", () => {
    // The stripping must not become a way to smuggle one past the guard.
    const cmd =
      "cat > note.txt <<'X'\nharmless\nX\n" +
      "for i in $(seq 1 60); do sleep 10; cat tasks/b0.output; done";
    expect(denied(cmd)).toBe(true);
  });
});
