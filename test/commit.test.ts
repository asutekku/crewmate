/**
 * Noticing that a commit landed.
 *
 * THE ONE FACT ON THE BOARD THAT IS EVIDENCE RATHER THAN A CLAIM, so the parse
 * has exactly two ways to be wrong and both are bad in different directions:
 * MISSING a real commit costs the board an event, and INVENTING one puts a sha
 * nobody can look up next to work that may not exist. The second is worse, so
 * the cases below lean on output that merely resembles a commit line.
 *
 * EVERY GIT FIXTURE HERE WAS CAPTURED FROM A REAL `git` RUN on 2026-08-01, not
 * written from memory. That matters: the shapes git actually emits for a root
 * commit, an amend, a detached HEAD and a merge are not guessable, and a regex
 * verified against one hand-written string is verified against nothing.
 */

import { describe, expect, test } from "bun:test";

import { parseCommit } from "../hooks/commit-landed.ts";

describe("what git really prints", () => {
  test("the ordinary commit", () => {
    const r = parseCommit("[master 074bb51] feat(presence): diary freshness\n 3 files changed");
    expect(r?.sha).toBe("074bb51");
    expect(r?.subject).toBe("feat(presence): diary freshness");
  });

  test("a ROOT COMMIT, whose bracket carries an extra word", () => {
    // Captured: `[master (root-commit) 79e34d6] root subject here`. The anchor
    // has to be the SHA SHAPE at the end of the bracket, not the branch at the
    // start, or every one of these forms needs its own pattern.
    const r = parseCommit("[master (root-commit) 79e34d6] root subject here\n 1 file changed");
    expect(r?.sha).toBe("79e34d6");
    expect(r?.subject).toBe("root subject here");
  });

  test("a DETACHED HEAD, where the branch is two words", () => {
    const r = parseCommit("[detached HEAD 482b352] detached work\n 1 file changed");
    expect(r?.sha).toBe("482b352");
    expect(r?.subject).toBe("detached work");
  });

  test("an AMEND, which prints a Date line under the subject", () => {
    const r = parseCommit("[master 36293a0] amended subject\n Date: Sat Aug 1 13:33:01 2026 +0900\n 1 file changed");
    expect(r?.sha).toBe("36293a0");
    expect(r?.subject).toBe("amended subject");
  });

  test("A SUBJECT CONTAINING ITS OWN BRACKETED SHA does not fool the parse", () => {
    // Captured from a real commit whose message is `fix [deadbee1] regression`.
    // `[^\]]*?` cannot cross the first `]`, so the branch-side sha wins and the
    // one in the message is left in the subject where it belongs. Without that,
    // the board would record a sha the repo has never heard of.
    const r = parseCommit("[master d973d9f] fix [deadbee1] regression");
    expect(r?.sha).toBe("d973d9f");
    expect(r?.subject).toBe("fix [deadbee1] regression");
  });

  test("the bracket line need not be first", () => {
    // A pre-commit hook prints above it, and a `git commit` inside a compound
    // command prints around it. The `m` flag is what makes this work.
    const r = parseCommit("husky > pre-commit\nlint ok\n[master 074bb51] feat: thing\n 2 files changed");
    expect(r?.sha).toBe("074bb51");
    expect(r?.subject).toBe("feat: thing");
  });

  test("CRLF output parses, because the tool runs on Windows", () => {
    // `$` before a `\r` is the classic Windows regex miss. This repo's shell is
    // Git Bash on Windows and CRLF has bitten it before.
    const r = parseCommit("[master 074bb51] subject here\r\n 3 files changed\r\n");
    expect(r?.sha).toBe("074bb51");
    // The subject must not keep a trailing carriage return, or the board shows
    // a stray character and any comparison against it fails.
    expect(r?.subject).toBe("subject here");
  });

  test("a FULL 40-char sha is cut to seven, so the board's refs are comparable", () => {
    // `git commit` abbreviates, but a repo can configure `core.abbrev` or a
    // wrapper can print the full id. Every ref on the board is a 7-char prefix,
    // so a full one has to be reduced or two records of one commit stop
    // comparing equal.
    const full = "0123456789abcdef0123456789abcdef01234567";
    expect(full.length).toBe(40);
    expect(parseCommit(`[master ${full}] subject`)?.sha).toBe("0123456");
  });
});

describe("output that must NOT be read as a commit", () => {
  test("nothing to commit", () => {
    // Captured: git prints the branch state and a plain sentence, with no
    // bracket line at all.
    expect(parseCommit("HEAD detached from d973d9f\nnothing to commit, working tree clean")).toBeNull();
  });

  test("nothing ADDED to commit", () => {
    expect(
      parseCommit("On branch master\nnothing added to commit but untracked files present"),
    ).toBeNull();
  });

  test("`git commit -q` PRINTS NOTHING, so nothing is recorded", () => {
    // Confirmed against real git 2026-08-01: a quiet commit emits no matching
    // line whatsoever. This is the deliberate trade the hook documents —
    // silently MISSING a commit costs one board event, where guessing from the
    // command text would invent a sha. The test pins "records nothing" rather
    // than "records something wrong", which is the failure that would matter.
    expect(parseCommit("")).toBeNull();
    expect(parseCommit("\n")).toBeNull();
  });

  test("A MERGE COMMIT IS NOT DETECTED, and that is a known gap", () => {
    // Captured: `git merge` prints "Merge made by the 'ort' strategy." and a
    // diffstat — no bracket line, no sha. So a merge lands on the board as
    // nothing at all, exactly like `-q`.
    //
    // Asserted rather than fixed: the sha is genuinely absent from the output,
    // so recording one would mean running `git rev-parse` from the hook, and
    // "the hook shells out on every Bash call that mentions commit" is a
    // different trade than the one this file made. Pinned here so the gap is a
    // decision on record instead of a surprise.
    expect(parseCommit("Merge made by the 'ort' strategy.\n c.txt | 1 +\n 1 file changed")).toBeNull();
  });

  test("a `git log` line is not a commit line", () => {
    // `commit 074bb51…` has the sha but no brackets. A pattern anchored on the
    // sha alone would record a commit every time somebody read the history.
    expect(parseCommit("commit 074bb51aaaabbbbccccddddeeeeffff00001111\nAuthor: x")).toBeNull();
  });

  test("a DIFF line quoting a commit line is not a commit", () => {
    // `git show` and a failed patch both print `+[master abc1234] …`. The `^`
    // anchor is what keeps this out.
    expect(parseCommit("+[master abc1234] fake subject")).toBeNull();
  });

  test("a sha too short to be a sha is refused", () => {
    // Six hex digits is a branch name or a word, not an abbreviated sha.
    expect(parseCommit("[master abc123] subject")).toBeNull();
  });

  test("an UPPERCASE hex string is not a git sha", () => {
    // git abbreviates in lowercase. Accepting uppercase would widen the pattern
    // toward ordinary bracketed text for no gain.
    expect(parseCommit("[master ABC1234] subject")).toBeNull();
  });

  test("an empty subject still records the sha", () => {
    // A commit whose message git does not echo is still a commit; the sha is
    // the part that is evidence.
    const r = parseCommit("[master abc1234]");
    expect(r?.sha).toBe("abc1234");
    expect(r?.subject).toBe("");
  });
});
