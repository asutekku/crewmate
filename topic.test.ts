/**
 * What may become a session's roster label, and what may not.
 *
 * Every rejection case here is a string that ACTUALLY reached the roster and
 * described nothing, on 2026-07-31, with real concurrent sessions running. The
 * acceptance cases exist because the first version of each filter was too
 * greedy and silently blanked the field it was meant to protect — an intent
 * that says nothing and an intent that says the wrong thing are both failures.
 */

import { describe, expect, test } from "bun:test";

import { topicOf } from "./topic.ts";

describe("topicOf rejects", () => {
  test.each([
    // Pasting a `cli.ts log` transcript to ask about it set the roster's
    // headline field to "Now it looks like this $ bun ~/.claude/agent-…".
    [
      "a pasted terminal transcript",
      "Now it looks like this\n\n$ bun ~/.claude/agent-presence/bin/cli.ts log\n  40m ago traffic-74 done: reached a stopping point\n\nDoes who have redundancy?",
    ],
    ["a windows prompt", "look at this\r\nPS C:\\Users\\akU> bun test\r\nok"],
    ["a stack frame", "it crashes\n    at Object.<anonymous> (/app/x.ts:12:9)\n  more"],
    ["a diff hunk", "review this\n@@ -1,4 +1,9 @@\n-old\n+new"],
    ["a log timestamp", "see the log\n12:04:31 ERROR something failed\nwhy?"],
    ["anything long enough to be a document", "here\nl1\nl2\nl3\nl4\nl5\nl6"],
    // All three live sessions carried filler of exactly this shape, because a
    // RESUMED session's opening prompt acknowledges a conversation the roster
    // never saw. Under the old rule the first one latched for the session's life.
    ["pure filler", "Lovely, start working on it."],
    ["filler, longer", "Ok great, start implementing the next steps."],
    ["filler, plural", "lovely, we can start working on next steps."],
    ["too few words", "go"],
    // FILLER is matched one word at a time, so multi-word entries in it can
    // never fire. "go ahead" and "carry on" were listed as phrases, and these
    // three sailed through as stated tasks.
    ["a three-word continuation", "yes go ahead"],
    ["a polite continuation", "go ahead please"],
    ["a continuation with a tail", "carry on then"],
    ["an approval", "yes that works"],
    ["a hand-off", "ok you can start now"],
    // A redacted secret still reveals that a secret was there, and what kind.
    ["credential-shaped text", "use api_key=sk-abcdefghijklmnopqrstuvwxyz012345"],
  ])("%s", (_name, prompt) => {
    expect(topicOf(prompt)).toBe("");
  });
});

describe("topicOf keeps", () => {
  test.each([
    ["a plain task", "Fix the water sim substep budget so it spreads across frames"],
    ["a task over two lines", "Add a roundabout tool to the junction editor.\nUse snapping."],
    ["a task naming a path", "refactor src/net/types/ids.ts to use branded ids"],
    // Splitting on the colon left a one-word head that then failed the length
    // gate, so a perfectly good prompt yielded nothing.
    ["a task behind a label", "goal: make the derive fast path cover junction edits"],
    ["a question", "why does the roster show a stale worktree after i cd?"],
    ["a short list", "do these:\nfix lanes\nfix ramps\nfix signals"],
    // Filler at the START is normal speech, not a contentless prompt.
    ["a task opening with filler", "Ok great, now fix the waterTexture channel packing"],
    // The guard against an over-eager FILLER list: each of these is mostly
    // common words, and every one of them is a real instruction. One noun is
    // enough to make a phrase worth showing.
    ["a short real task", "fix the tests"],
    ["a terse instruction", "commit the hooks"],
    ["work named by one noun", "now do the lanes"],
    ["a task with a verb and object", "start the water sim"],
    ["a question about work", "can you check the roster"],
  ])("%s", (_name, prompt) => {
    expect(topicOf(prompt)).not.toBe("");
  });
});

describe("topicOf shape", () => {
  test("caps the label so a roster column stays scannable", () => {
    const long = `rewrite ${"the junction lane connector solver ".repeat(10)}`;
    const out = topicOf(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });

  test("collapses whitespace rather than carrying layout into the roster", () => {
    expect(topicOf("fix   the\t\tlane   solver")).toBe("fix the lane solver");
  });
});
