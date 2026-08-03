import { afterEach, describe, expect, test } from "bun:test";

import { runHook } from "../core/hook.ts";

const originalError = console.error;

afterEach(() => {
  console.error = originalError;
});

describe("hook process boundary", () => {
  test("runs a successful hook once", async () => {
    let calls = 0;

    await runHook("hook.ts", async () => {
      calls += 1;
    });

    expect(calls).toBe(1);
  });

  test("reports an error and fails open", async () => {
    const reports: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      reports.push(args);
    };
    const failure = new Error("broken hook");

    await expect(
      runHook("notify.ts", async () => {
        throw failure;
      }),
    ).resolves.toBeUndefined();

    expect(reports).toEqual([["[presence] notify.ts failed:", failure]]);
  });
});
