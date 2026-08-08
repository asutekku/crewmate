import { describe, expect, test } from "bun:test";

import { canonicalTrackedPath, resolveTrustedPath } from "../cli/paths.ts";

describe("trusted CLI paths", () => {
  // `resolve` is platform-dependent, so the root must be absolute on the host
  // running the test: a Windows-shaped root is relative everywhere else.
  const root = process.platform === "win32" ? "C:/projects/traffic" : "/projects/traffic";
  const sibling = `${root}-old/file.ts`;

  test.each([
    ["src/file.ts", "src/file.ts"],
    ["src\\file.ts", "src/file.ts"],
    [`${root}/src/file.ts`, "src/file.ts"],
  ])("accepts an in-root path %s", (raw, expected) => {
    expect(resolveTrustedPath(raw, root)).toMatchObject({
      ok: true,
      value: { relative: expected },
    });
  });

  test.each(["../traffic-old/file.ts", sibling, "../../outside"])(
    "rejects sibling and traversal path %s",
    (raw) => expect(resolveTrustedPath(raw, root).ok).toBeFalse(),
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
