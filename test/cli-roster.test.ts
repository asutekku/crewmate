import { describe, expect, test } from "bun:test";

import type { Claim, Session } from "../core/store.ts";
import { calculateRosterLayout, groupSessions, indexClaims } from "../cli/roster-model.ts";
import { renderClaims, renderSession } from "../cli/roster-renderers.ts";

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

  test("renderer sanitizes before fitting and is deterministic", () => {
    const session: Session = {
      sessionId: "s1", handle: "ada", name: "ada", alias: "", role: "",
      status: "busy", blocked: "blocked\nspoof", worktree: "/project", branch: "main",
      behindBase: 0, baseBranch: "main", lineageFrom: "", intent: "",
      title: "task\u001b]8;;https://evil.test\u0007", summary: "safe\u001b[31m",
      summaryMs: 0, lastSeenMs: 1000, lastTurnMs: 0, startedMs: 0,
    };
    const input = {
      now: 2000,
      raw: true,
      layout: calculateRosterLayout([session], 60, () => "ada"),
      paint: (text: string) => text,
      taskCounts: new Map(),
    };
    const first = renderSession(session, input);
    expect(first).toEqual(renderSession(session, input));
    expect(first.join("\n")).not.toContain("https://evil.test");
    expect(first.join("\n")).not.toContain("\u001b[31m");
    expect(first.join("\n")).toContain("blocked spoof");
  });
});

describe("the overlap a shared tree exists to create", () => {
  const layout = { width: 100, nameWidth: 14, ageWidth: 5, gutter: 24, descriptionWidth: 60 };

  test("a peer holding the same file is NAMED, not just coloured", () => {
    // The contested path was already painted red, which says "someone else is
    // here" without saying who — and who is the part you act on.
    const claims = [
      claim("ada", "src/a.ts", "/tree"),
      claim("bob", "src/a.ts", "/tree"),
      claim("ada", "src/b.ts", "/tree"),
    ];
    const index = indexClaims(claims, "/project", () => new Set(["src/a.ts"]));
    const lines = renderClaims("ada", index, layout).join("\n");
    expect(lines).toContain("1 shared with bob");
  });

  test("the count is FILES shared with that peer", () => {
    const claims = [
      claim("ada", "src/a.ts", "/tree"),
      claim("bob", "src/a.ts", "/tree"),
      claim("ada", "src/b.ts", "/tree"),
      claim("bob", "src/b.ts", "/tree"),
    ];
    const index = indexClaims(claims, "/project", () => new Set());
    expect(renderClaims("ada", index, layout).join("\n")).toContain("2 shared with bob");
  });

  test("several peers are listed, heaviest overlap first", () => {
    const claims = [
      claim("ada", "src/a.ts", "/tree"),
      claim("ada", "src/b.ts", "/tree"),
      claim("bob", "src/a.ts", "/tree"),
      claim("cy", "src/a.ts", "/tree"),
      claim("cy", "src/b.ts", "/tree"),
    ];
    const index = indexClaims(claims, "/project", () => new Set());
    const line = renderClaims("ada", index, layout).join("\n");
    expect(line.indexOf("shared with cy")).toBeLessThan(line.indexOf("shared with bob"));
  });

  test("an agent alone in its files gets NO warning line", () => {
    // A warning that fires when nothing is wrong is one a reader stops seeing.
    const index = indexClaims([claim("ada", "src/a.ts", "/tree")], "/project", () => new Set());
    expect(renderClaims("ada", index, layout).join("\n")).not.toContain("shared with");
  });

  test("an agent's OWN second claim on a path is not an overlap with itself", () => {
    const claims = [claim("ada", "src/a.ts", "/tree"), claim("ada", "src/a.ts", "/tree")];
    const index = indexClaims(claims, "/project", () => new Set());
    expect(renderClaims("ada", index, layout).join("\n")).not.toContain("shared with");
  });
});

describe("every agent is under a named tree", () => {
  function session(handle: string, worktree: string, branch: string): Session {
    return {
      sessionId: `s-${handle}`, handle, name: handle, alias: "", role: "",
      status: "", blocked: "", worktree, branch, behindBase: -1, baseBranch: "",
      lineageFrom: "", intent: "", title: "", summary: "", summaryMs: 0,
      lastSeenMs: 1000, lastTurnMs: 0, startedMs: 0,
    };
  }

  test("the busiest tree is a heading too, not an unlabelled default", () => {
    // The old rule keyed the most populated tree as "" and printed no header
    // for it, so a minority tree got an inline label that read as either a
    // header for the rows below or a footer for the rows above. "2 trees" was
    // stated and the assignment was then withheld.
    const { groups } = groupSessions([
      session("ada", "/repo", "master"),
      session("bob", "/repo", "master"),
      session("cy", "/repo/wt/feature", "feature"),
    ]);
    expect(groups.map(([tree]) => tree)).toEqual(["/repo", "/repo/wt/feature"]);
    // MEMBERS, not just keys. A grouping that drops a session still produces
    // the right key list, so asserting keys alone passes while an agent
    // silently vanishes off the roster.
    expect(groups.map(([, group]) => group.map((x) => x.handle))).toEqual([
      ["ada", "bob"],
      ["cy"],
    ]);
  });

  test("a session with no recorded tree is grouped as unknown, not hidden", () => {
    const { groups } = groupSessions([session("ada", "", "")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.[0]).toBe("");
  });
});
