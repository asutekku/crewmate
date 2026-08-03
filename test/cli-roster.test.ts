import { describe, expect, test } from "bun:test";

import type { Claim } from "../core/store.ts";
import { calculateRosterLayout, indexClaims } from "../cli/roster-model.ts";

function claim(handle: string, path: string, worktree: string): Claim {
  return {
    sessionId: `session-${handle}`,
    handle,
    name: handle,
    path,
    worktree,
    tsMs: 1,
  };
}

describe("roster snapshot indexes", () => {
  test("claims are indexed once for both handle and path consumers", () => {
    const claims = [
      claim("ada", "src/a.ts", "/tree-a"),
      claim("bob", "src/a.ts", "/tree-b"),
      claim("ada", "src/b.ts", "/tree-a"),
    ];
    const index = indexClaims(claims, "/project", () => new Set(["src/a.ts"]));
    expect(index.byHandle.get("ada")).toEqual([claims[0]!, claims[2]!]);
    expect(index.byPath.get("src/a.ts")).toEqual([claims[0]!, claims[1]!]);
    expect(index.contestedPaths).toEqual(new Set(["src/a.ts"]));
  });

  test("dirty files are read at most once per worktree", () => {
    const calls: string[] = [];
    indexClaims(
      [
        claim("ada", "src/a.ts", "/tree-a"),
        claim("bob", "src/a.ts", "/tree-b"),
        claim("ada", "src/b.ts", "/tree-a"),
        claim("bob", "src/b.ts", "/tree-b"),
      ],
      "/project",
      (tree) => {
        calls.push(tree);
        return tree === "/tree-a"
          ? new Set()
          : new Set(["src/a.ts", "src/b.ts"]);
      },
    );
    expect(calls).toEqual(["/tree-a", "/tree-b"]);
  });
});

describe("roster layout", () => {
  test("all dependent widths are calculated as one immutable value", () => {
    const layout = calculateRosterLayout([], 100, () => "unused");
    expect(layout).toEqual({
      width: 100,
      nameWidth: 0,
      ageWidth: 4,
      gutter: 11,
      descriptionWidth: 88,
    });
  });
});
