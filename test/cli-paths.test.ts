import { describe, expect, test } from "bun:test";

import { canonicalTrackedPath, resolveTrustedPath } from "../cli/paths.ts";

describe("trusted CLI paths", () => {
  const root = "C:/projects/traffic";

  test.each([
    ["src/file.ts", "src/file.ts"],
    ["src\\file.ts", "src/file.ts"],
    ["C:/projects/traffic/src/file.ts", "src/file.ts"],
  ])("accepts an in-root path %s", (raw, expected) => {
    expect(resolveTrustedPath(raw, root)).toMatchObject({
      ok: true,
      value: { relative: expected },
    });
  });

  test.each([
    "../traffic-old/file.ts",
    "C:/projects/traffic-old/file.ts",
    "../../outside",
  ])("rejects sibling and traversal path %s", (raw) =>
    expect(resolveTrustedPath(raw, root).ok).toBeFalse(),
  );

  test("rejects a physical symlink escape even when the lexical path is inside", () => {
    const result = resolveTrustedPath("link/file.ts", root, {
      requireRealpath: true,
      realpath: (path) =>
        canonicalTrackedPath(path).endsWith("/link/file.ts")
          ? "C:/outside/file.ts"
          : "C:/projects/traffic",
    });
    expect(result).toEqual({
      ok: false,
      error: "path escapes the project root through a symlink",
    });
  });

  test("reports a missing or transient sidecar distinctly", () => {
    const result = resolveTrustedPath("missing.json", root, {
      requireRealpath: true,
      realpath: () => {
        throw new Error("not found");
      },
    });
    expect(result).toEqual({
      ok: false,
      error: "cannot resolve path: not found",
    });
  });
});
