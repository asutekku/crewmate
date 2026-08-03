import { describe, expect, test } from "bun:test";

import { runCli } from "../cli/main.ts";

const options = (logs: string[], errors: string[], exits: number[]) => ({
  cwd: process.cwd(),
  binRoot: new URL("..", import.meta.url).pathname,
  log: (message: string) => logs.push(message),
  error: (message: string) => errors.push(message),
  setExitCode: (code: number) => exits.push(code),
});

describe("CLI application boundary", () => {
  test("help is dispatched without terminating the process", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    runCli(["help"], options(logs, errors, exits));
    expect(logs.join("\n")).toContain("who [--raw]");
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  });

  test("unknown commands report usage through the injected process boundary", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    runCli(["definitely-not-a-command"], options(logs, errors, exits));
    expect(logs).toEqual([]);
    expect(errors[0]).toContain("unknown command: definitely-not-a-command");
    expect(errors.join("\n")).toContain("who [--raw]");
    expect(exits).toEqual([1]);
  });

  test("a registered read-only command runs through the same boundary", () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    runCli(["where"], options(logs, errors, exits));
    expect(logs.join("\n")).toContain("project:");
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  });
});
