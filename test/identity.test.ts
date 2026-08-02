/**
 * The identity block: making an assigned name the answer to "who are you".
 *
 * WHAT A TEST CAN AND CANNOT DO HERE. This is a claim about how a model reads a
 * sentence, and no assertion in this file proves the wording works — only a
 * real session answering the question does. What these DO pin is the set of
 * properties the failed version lacked, so a future edit cannot quietly
 * reintroduce the shape that broke.
 *
 * THE MEASURED FAILURE, 2026-08-02. Asked "who are you", a session replied:
 * "I'm Claude Code, Anthropic's AI assistant... In this session, I'm anouk."
 * The old line was `You are "anouk" in Traffic's shared presence log.` — which
 * scopes the name to a log, and the reply mirrored that scoping back. Every
 * assertion below traces to one specific weakness in that sentence.
 */

import { describe, expect, test } from "bun:test";

import { identityLines } from "../hooks/session-start.ts";

const block = (name = "adela", project = "Traffic"): string =>
  identityLines(name, project).join("\n");

describe("the name is asserted, not labelled", () => {
  test("the first line states the name and nothing else", () => {
    // THE CORE FIX. `You are "adela" in Traffic's shared presence log` gave the
    // name a prepositional phrase to hide inside; a reader can accept the whole
    // sentence while treating the name as a database row's label.
    expect(identityLines("adela", "Traffic")[0]).toBe("Your name is Adela.");
  });

  test("the name is never scoped to a log, a roster, or a session", () => {
    // The exact constructions that produced "In this session, I'm anouk".
    const text = block();
    for (const scope of ["presence log", "in this session", "roster entry", "your row"]) {
      expect(text.toLowerCase()).not.toContain(scope);
    }
  });

  test("the name is not quoted", () => {
    // Quotation marks around a name present it as a STRING VALUE — the thing to
    // type at `msg` — rather than as what the agent is called.
    expect(block()).not.toContain('"Adela"');
    expect(block()).not.toContain("'Adela'");
  });

  test("a lowercase pool name is capitalised as a name in prose", () => {
    // Names are stored lowercase for matching; prose that says "your name is
    // adela" reads like an identifier, which is the impression being fought.
    expect(block("hopper")).toContain("Hopper");
    expect(block("hopper")).not.toContain("your name is hopper");
  });
});

describe("it concedes Claude Code rather than ignoring it", () => {
  test("Claude Code is named, and named FIRST in the explanation", () => {
    // The failed answer led with "I'm Claude Code" because that is true and the
    // old block never addressed it. An identity line that pretends the system
    // prompt does not exist invites the "I'm X, but here I'm Y" hedge.
    const text = block();
    expect(text).toContain("Claude Code");
    expect(text.indexOf("You are Claude Code")).toBeLessThan(text.indexOf("names WHAT you are"));
  });

  test("it splits WHO from WHAT rather than contradicting the system prompt", () => {
    // A hook cannot outrank the system prompt — injected text never reaches it.
    // So the claim has to be compatible with "You are Claude Code", not opposed
    // to it, or the agent is being asked to resolve a conflict it will lose.
    expect(block()).toContain("names WHAT you are");
  });

  test("it answers the question that actually failed", () => {
    expect(block()).toContain("Asked who you are, say Adela");
  });

  test("it gives the REASON, not only the instruction", () => {
    // A rule with its rationale attached survives better than a bare order, and
    // this one is true: in a shared tree, "Claude Code" identifies nobody.
    expect(block()).toContain("does not distinguish you");
  });
});

describe("shape", () => {
  test("the assertion and the explanation are separate paragraphs", () => {
    const lines = identityLines("adela", "Traffic");
    expect(lines[1]).toBe("");
    expect(lines).toHaveLength(3);
  });

  test("it names the project it is speaking about", () => {
    expect(block("adela", "Traffic")).toContain("in Traffic you are Adela");
  });

  test("it stays short — every session pays for this on every start", () => {
    // The whole point is that it is read, and a wall of text is skimmed. The
    // old block was one line; this is three, which is the budget.
    expect(block().length).toBeLessThan(500);
  });
});
