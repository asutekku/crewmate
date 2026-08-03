import { describe, expect, test } from "bun:test";

import { CommandRegistry } from "../cli/registry.ts";

describe("CLI command registry", () => {
  test("combines independently owned command families", () => {
    const calls: string[] = [];
    const registry = new CommandRegistry()
      .add({ who: () => calls.push("roster") })
      .add({ doing: () => calls.push("work") });

    registry.handler("who")?.([]);
    registry.handler("doing")?.([]);

    expect(calls).toEqual(["roster", "work"]);
    expect(registry.handler("missing")).toBeUndefined();
  });

  test("rejects ambiguous command ownership", () => {
    expect(() =>
      new CommandRegistry().add({ who: () => {} }).add({ who: () => {} }),
    ).toThrow("duplicate CLI command: who");
  });

  test("rejects handlers without canonical help metadata", () => {
    expect(() =>
      new CommandRegistry().add({ undocumented: () => {} }),
    ).toThrow("CLI command has no metadata: undocumented");
  });

  test("dispatch exposes the same metadata that drives help", () => {
    const registry = new CommandRegistry().add({ who: () => {} });
    expect(registry.command("who")?.metadata.blurb).toBe(
      "the roster: who is live, on what, where",
    );
  });
});
