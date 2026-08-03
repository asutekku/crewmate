import { describe, expect, test } from "bun:test";

import {
  parseArguments,
  parseSafeInteger,
  parseSubjectSelector,
  requireSafeInteger,
} from "../cli/args.ts";

describe("typed CLI arguments", () => {
  test("distinguishes unknown, duplicate, missing-value, trailing, and conflicting input", () => {
    expect(parseArguments(["--wat"], {}).ok).toBeFalse();
    expect(
      parseArguments(["--raw", "--raw"], { booleanFlags: ["--raw"] }),
    ).toMatchObject({ ok: false, kind: "duplicate" });
    expect(
      parseArguments(["--agent"], { valueFlags: ["--agent"] }),
    ).toMatchObject({ ok: false, kind: "missing" });
    expect(parseArguments(["one", "two"], { maxPositionals: 1 })).toMatchObject(
      {
        ok: false,
        kind: "trailing",
      },
    );
    const selectors = parseArguments(["--agent", "ada", "--session", "id"], {
      valueFlags: ["--agent", "--session"],
    });
    expect(selectors.ok && parseSubjectSelector(selectors.value)).toMatchObject(
      {
        ok: false,
        kind: "conflict",
      },
    );
  });

  test("safe integers reject fractions, signs, overflow, zero, and excessive limits", () => {
    for (const raw of ["1.5", "-1", "+1", "NaN", "9007199254740992"])
      expect(
        parseSafeInteger(raw, "limit", { min: 1, max: 100 }).ok,
      ).toBeFalse();
    expect(
      requireSafeInteger(undefined, "id", { min: 1, max: 100 }),
    ).toMatchObject({
      ok: false,
      kind: "missing",
    });
    expect(parseSafeInteger("0", "limit", { min: 1, max: 100 }).ok).toBeFalse();
    expect(
      parseSafeInteger("101", "limit", { min: 1, max: 100 }).ok,
    ).toBeFalse();
    expect(parseSafeInteger("100", "limit", { min: 1, max: 100 })).toEqual({
      ok: true,
      value: 100,
    });
  });
});
