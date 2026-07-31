/**
 * Roster layout, checked with colour codes stripped.
 *
 * Spacing bugs here are invisible to the eye: a field's ANSI codes come BEFORE
 * its text, so a leading space tucked inside them survives `.trim()` and reads
 * as correct in a terminal until someone looks closely. Both faults below
 * shipped and were spotted by the user, not by me — hence bytes, not eyeballs.
 */

import { describe, expect, test } from "bun:test";

import type { Claim, Session } from "../core/store.ts";
import { formatRoster } from "../core/shared.ts";

const ESC = String.fromCharCode(27);
/** Strips SGR sequences so an assertion sees layout rather than colour. */
const plain = (s: string): string => s.split(new RegExp(`${ESC}\\[[0-9;]*m`, "g")).join("");

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: "s1",
    handle: "ada",
    name: "traffic-4b",
    status: "busy",
    blocked: "",
    worktree: "I:/Projects/Traffic",
    branch: "master",
    intent: "",
    lastSeenMs: 1_000,
    startedMs: 0,
    ...over,
  };
}

const claim = (path: string, handle = "ada", name = "traffic-4b"): Claim => ({
  handle,
  name,
  worktree: "I:/Projects/Traffic",
  path,
  tsMs: 900,
});

describe("formatRoster layout", () => {
  test("never emits a doubled or missing space between fields", () => {
    const lines = formatRoster(
      [
        session({ intent: "" }),
        session({ sessionId: "s2", handle: "turing", name: "t-2", intent: "fix the lane solver" }),
      ],
      [claim("src/a.ts"), claim("src/b.ts")],
      2_000,
      "I:/Projects/Traffic",
      new Map([["s1", { open: 2, done: 4 }]]),
    );
    for (const line of lines.map(plain)) {
      expect(line).not.toMatch(/\S {3,}\S/); // three+ spaces between words
      expect(line).not.toMatch(/,\S/); // a comma with no space after it
      expect(line).not.toMatch(/ $/); // trailing space
    }
  });

  test("omits the task column entirely when files are listed below", () => {
    const [head] = formatRoster(
      [session({ intent: "" })],
      [claim("src/a.ts")],
      2_000,
      "I:/Projects/Traffic",
    ).map(plain);
    // The `editing:` line carries it; repeating it here would print the same
    // paths twice, one line apart.
    expect(head).not.toContain("src/a.ts");
    expect(head).not.toContain("no stated task");
  });

  test("explains itself only when there is nothing underneath", () => {
    const [head] = formatRoster([session({ intent: "" })], [], 2_000, "I:/Projects/Traffic").map(
      plain,
    );
    expect(head).toContain("(no stated task yet)");
  });

  test("shows a stated task when there is one", () => {
    const [head] = formatRoster(
      [session({ intent: "fix the lane solver" })],
      [],
      2_000,
      "I:/Projects/Traffic",
    ).map(plain);
    expect(head).toContain("fix the lane solver");
  });

  test("names sessions the way the user does, never by internal handle", () => {
    // Handles (`knuth`, `turing`, `lovelace`) are an allocation detail. Showing
    // them next to Claude's own `traffic-NN` names forced the user to map the
    // two by hand — "Why's there agent names & claude names mixed?"
    const lines = formatRoster(
      [session({ name: "traffic-07", handle: "knuth" })],
      [claim("src/config.ts", "knuth", "traffic-07")],
      2_000,
      "I:/Projects/Traffic",
    ).map(plain);
    const all = lines.join("\n");
    expect(all).toContain("traffic-07");
    expect(all).not.toContain("knuth");
  });

  test("falls back to the handle when a session has no name yet", () => {
    const [head] = formatRoster(
      [session({ name: "", handle: "knuth" })],
      [],
      2_000,
      "I:/Projects/Traffic",
    ).map(plain);
    // A blank sender is worse than an internal one.
    expect(head).toContain("knuth");
  });

  test("blocked outranks status, because it is the cause not the symptom", () => {
    const [head] = formatRoster(
      [session({ blocked: "waiting for permission approval", status: "idle" })],
      [],
      2_000,
      "I:/Projects/Traffic",
    ).map(plain);
    expect(head).toContain("waiting for permission approval");
    expect(head).not.toContain("idle");
  });
});
