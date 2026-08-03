import { describe, expect, test } from "bun:test";

import { parseStructuredShortcut } from "../cli/structured.ts";

function parsed(command: string, args: readonly string[]) {
  const result = parseStructuredShortcut(command, args);
  expect(result.matched).toBeTrue();
  expect(result.matched && result.result.ok).toBeTrue();
  if (!result.matched || !result.result.ok)
    throw new Error("expected a valid structured shortcut");
  return result.result.value;
}

describe("structured CLI shortcuts", () => {
  test("request creates a proposed request act", () => {
    expect(parsed("request", ["ada", "review", "the", "store"])).toEqual({
      command: "request",
      target: "ada",
      acts: [{ key: "request", type: "request", text: "review the store" }],
    });
  });

  test("perform and refrain promises retain their distinct semantics", () => {
    expect(parsed("promise", ["ada", "run", "the", "tests"]).acts).toEqual([
      {
        key: "promise",
        type: "promise",
        text: "run the tests",
        mode: "perform",
      },
    ]);
    expect(
      parsed("promise", [
        "ada",
        "--refrain",
        "--until",
        "release",
        "touch",
        "store.ts",
      ]).acts,
    ).toEqual([
      {
        key: "promise",
        type: "promise",
        text: "touch store.ts",
        mode: "refrain",
        releaseBoundary: { text: "release", handling: "manual" },
      },
    ]);
  });

  test.each([
    [
      "handoff",
      ["ada", "schema", "ownership"],
      {
        key: "handoff",
        type: "handoff",
        text: "Responsibility for schema ownership",
        subject: "schema ownership",
      },
    ],
    [
      "grant",
      ["ada", "presence", "hooks"],
      {
        key: "grant",
        type: "grant",
        text: "Go ahead on presence hooks",
        scopeText: "presence hooks",
      },
    ],
    [
      "correct",
      ["ada", "peer", "the", "claim", "expired"],
      {
        key: "correction",
        type: "correction",
        text: "the claim expired",
        correctionType: "peer_correction",
      },
    ],
    [
      "hazard",
      ["ada", "store.ts", "migration", "ordering"],
      {
        key: "hazard",
        type: "hazard",
        text: "migration ordering",
        subject: "store.ts",
      },
    ],
  ] as const)("%s builds the expected act", (command, args, act) => {
    expect(parsed(command, args).acts).toEqual([act]);
  });

  test("invalid shortcut arguments are rejected before service execution", () => {
    expect(
      parseStructuredShortcut("promise", [
        "ada",
        "--refrain",
        "touch",
        "store.ts",
      ]),
    ).toEqual({
      matched: true,
      result: {
        ok: false,
        error: "--refrain requires --until <condition>",
      },
    });
    expect(
      parseStructuredShortcut("correct", ["ada", "guess", "something"]),
    ).toEqual({
      matched: true,
      result: {
        ok: false,
        error: "correct requires target, correction kind, and text",
      },
    });
  });

  test("plain messages are outside the semantic shortcut parser", () => {
    expect(parseStructuredShortcut("msg", ["ada", "hello"])).toEqual({
      matched: false,
    });
    expect(parseStructuredShortcut("say", ["hello"])).toEqual({
      matched: false,
    });
  });
});
