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
    alias: "",
    role: "",
    status: "busy",
    blocked: "",
    worktree: "I:/Projects/Traffic",
    branch: "master",
    intent: "",
    title: "",
    summary: "",
    summaryMs: 0,
    lastSeenMs: 1_000,
    startedMs: 0,
    ...over,
  };
}

const claim = (path: string, handle = "ada", name = "traffic-4b"): Claim => ({
  sessionId: `sess-${handle}`,
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

  test("names every session ONE way, so the reader never maps two labels", () => {
    // The original complaint — "Why's there agent names & claude names mixed?"
    // — was about MIXING, and it still holds. What changed is which one wins.
    //
    // `traffic-NN` used to win because it was the label on the user's screen.
    // It is not stable: one conversation was relabelled traffic-a0 -> traffic-7c
    // -> traffic-56 in a single afternoon, which made every frozen log line and
    // every peer reference a moving target. The GIVEN NAME (`luna`) is assigned
    // once and held for 60 hours, so it wins now.
    const lines = formatRoster(
      [session({ name: "traffic-07", handle: "luna" })],
      [claim("src/config.ts", "luna", "traffic-07")],
      2_000,
      "I:/Projects/Traffic",
    ).map(plain);
    const all = lines.join("\n");
    expect(all).toContain("luna");
    expect(all).not.toContain("traffic-07");
  });

  test("falls back to Claude's own name when there is no given name", () => {
    const [head] = formatRoster(
      [session({ name: "traffic-07", handle: "" })],
      [],
      2_000,
      "I:/Projects/Traffic",
    ).map(plain);
    // A blank sender is worse than either.
    expect(head).toContain("traffic-07");
  });

  test("keeps the conversation title OUT of what peers are shown", () => {
    // USER RULING: titles are for the operator, who uses them to match a roster
    // line to a window on their screen. An agent has no screen, and this text is
    // injected into every peer's context on every turn — so it stays out by
    // default and only `who` opts in.
    const s = session({ title: "Explore cheap agent communication solutions" });
    const injected = formatRoster([s], [], 2_000, "I:/Projects/Traffic").map(plain).join("\n");
    expect(injected).not.toContain("Explore cheap agent communication");
  });

  test("shows the title and summary when the operator asks for them", () => {
    const lines = formatRoster(
      [session({ title: "Optimize water hot functions", summary: "Benchmarking the texel pack" })],
      [],
      2_000,
      "I:/Projects/Traffic",
      undefined,
      true,
    )
      .map(plain)
      .join("\n");
    expect(lines).toContain("Optimize water hot functions");
    expect(lines).toContain("Benchmarking the texel pack");
  });

  test("omits an absent title instead of printing an empty quoted line", () => {
    const lines = formatRoster(
      [session({ title: "", summary: "" })],
      [],
      2_000,
      "I:/Projects/Traffic",
      undefined,
      true,
    ).map(plain);
    expect(lines.some((l) => l.trim() === '""')).toBe(false);
    expect(lines.some((l) => l.trim() === "doing:")).toBe(false);
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
