/**
 * The generated CLAUDE.md block: what it says, where it lands, and the
 * property everything else leans on — text outside the markers is returned
 * byte-for-byte, and re-applying is idempotent.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import {
  applyBlock,
  BLOCK_BEGIN,
  BLOCK_END,
  findClaudeMd,
  markersDamaged,
  renderBlock,
  type BlockParams,
} from "../core/initBlock.ts";

const GIT: BlockParams = {
  crewSize: "3–10",
  isGit: true,
  baseRef: "head",
  testScoped: "bun test {path}",
  testPolicy: "scoped-only",
  sign: false,
  sessionUrl: false,
};

describe("renderBlock: the git form", () => {
  const block = renderBlock(GIT);

  test("is bounded by both markers", () => {
    expect(block.startsWith(BLOCK_BEGIN)).toBe(true);
    expect(block.endsWith(BLOCK_END)).toBe(true);
  });

  test("carries the EnterWorktree authorization line verbatim", () => {
    expect(block).toContain("`EnterWorktree` tool");
    expect(block).toContain("this line");
    expect(block).toContain("is the authorization it looks for");
  });

  test("states the three git rules", () => {
    expect(block).toContain("NEVER `git stash`");
    expect(block).toContain("Stage explicit paths you wrote");
    expect(block).toContain("git commit -F <msgfile> -o -- <paths>");
  });

  test("the crew size renders into the headline", () => {
    expect(renderBlock({ ...GIT, crewSize: "4–8" })).toContain("one of 4–8 agents");
  });

  test("baseRef head warns that HEAD moves; a branch base does not", () => {
    expect(block).toContain('worktree.baseRef: "head"');
    expect(block).toContain("HEAD moves under you");
    const onMain = renderBlock({ ...GIT, baseRef: "main" });
    expect(onMain).toContain('worktree.baseRef: "main"');
    expect(onMain).not.toContain("HEAD moves under you");
  });

  test("names the two crew habits and the peer-naming rule", () => {
    expect(block).toContain("crew board");
    expect(block).toContain("--scope <folder>");
    expect(block).toContain("give its role too");
  });

  test("the scoped test command renders, with the policy warning", () => {
    expect(block).toContain("Test one file: `bun test {path}`");
    expect(block).toContain("Do not run the full suite");
  });

  test("full-ok drops the warning but keeps the command", () => {
    const relaxed = renderBlock({ ...GIT, testPolicy: "full-ok" });
    expect(relaxed).toContain("Test one file");
    expect(relaxed).not.toContain("Do not run the full suite");
  });

  test("no scoped command, no test line at all", () => {
    expect(renderBlock({ ...GIT, testScoped: "" })).not.toContain("Test one file");
  });
});

describe("renderBlock: the non-git form", () => {
  const block = renderBlock({ ...GIT, isGit: false });

  test("drops every git rule — a plain directory has no tree to share", () => {
    expect(block).not.toContain("git stash");
    expect(block).not.toContain("EnterWorktree");
    expect(block).not.toContain("worktree.baseRef");
  });

  test("keeps the crew habits", () => {
    expect(block).toContain("crew board");
    expect(block).toContain("Shared directory");
  });
});

describe("renderBlock: the signing rule", () => {
  test("is absent until the policy asks for it", () => {
    expect(renderBlock(GIT)).not.toContain("Co-Authored-By");
  });

  const signed = renderBlock({ ...GIT, sign: true });

  test("names the trailer and the lineage form", () => {
    expect(signed).toContain("Co-Authored-By: Aoi (Claude Opus 5)");
    expect(signed).toContain("Hopper's Disciple");
  });

  test("says a minion's work is signed by the parent", () => {
    expect(signed).toContain("signed by the PARENT");
  });

  test("forbids the session link, and stops forbidding it when it is allowed", () => {
    expect(signed).toContain("No `Claude-Session:` trailer");
    expect(renderBlock({ ...GIT, sign: true, sessionUrl: true })).not.toContain(
      "No `Claude-Session:` trailer",
    );
  });

  test("stays out of the non-git form — no commits without a repo", () => {
    expect(renderBlock({ ...GIT, isGit: false, sign: true })).not.toContain("Co-Authored-By");
  });
});

describe("applyBlock: marker mechanics", () => {
  const block = renderBlock(GIT);

  test("no existing file: the block alone, newline-terminated", () => {
    expect(applyBlock(null, block)).toBe(`${block}\n`);
    expect(applyBlock("", block)).toBe(`${block}\n`);
  });

  test("appends to an existing file without touching its text", () => {
    const existing = "# My project\n\nHand-written rules.\n";
    const result = applyBlock(existing, block);
    expect(result.startsWith(existing)).toBe(true);
    expect(result).toContain(BLOCK_BEGIN);
  });

  test("replaces in place, preserving text on both sides byte-for-byte", () => {
    const before = "# Title\n\n";
    const after = "\n\n## Later section\n";
    const existing = `${before}${renderBlock({ ...GIT, crewSize: "2–3" })}${after}`;
    const result = applyBlock(existing, block);
    expect(result).toBe(`${before}${block}${after}`);
    expect(result).toContain("3–10");
    expect(result).not.toContain("2–3");
  });

  test("re-applying is idempotent", () => {
    const once = applyBlock("# Repo\n", block);
    expect(applyBlock(once, block)).toBe(once);
  });

  test("one marker without its pair: refuse and return the input unchanged", () => {
    const damaged = `# Repo\n${BLOCK_BEGIN}\nsomeone deleted the end marker\n`;
    expect(applyBlock(damaged, block)).toBe(damaged);
    expect(markersDamaged(damaged)).toBe(true);
  });

  test("markers in the wrong order also count as damaged", () => {
    const inverted = `${BLOCK_END}\ntext\n${BLOCK_BEGIN}`;
    expect(markersDamaged(inverted)).toBe(true);
    expect(applyBlock(inverted, block)).toBe(inverted);
  });

  test("intact and absent markers are not damage", () => {
    expect(markersDamaged(null)).toBe(false);
    expect(markersDamaged("plain file")).toBe(false);
    expect(markersDamaged(applyBlock(null, block))).toBe(false);
  });
});

describe("findClaudeMd: case-insensitive, this repo's own trap", () => {
  const roots: string[] = [];
  let n = 0;
  const fresh = (): string => {
    const root = `${tmpdir().replace(/\\/g, "/")}/initblock-${process.pid}-${n++}`;
    mkdirSync(root, { recursive: true });
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("a lowercase claude.md is found and reused, never shadowed", () => {
    const root = fresh();
    writeFileSync(`${root}/claude.md`, "# rules\n");
    expect(findClaudeMd(root)).toBe(`${root}/claude.md`);
  });

  test("mixed case is found too", () => {
    const root = fresh();
    writeFileSync(`${root}/Claude.MD`, "");
    expect(findClaudeMd(root)).toBe(`${root}/Claude.MD`);
  });

  test("no file yet: the conventional name is proposed", () => {
    const root = fresh();
    expect(findClaudeMd(root)).toBe(`${root}/CLAUDE.md`);
  });

  test("an unreadable root still proposes the conventional name", () => {
    expect(findClaudeMd("Q:/does/not/exist")).toBe("Q:/does/not/exist/CLAUDE.md");
  });
});
