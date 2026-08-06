/**
 * The testPolicy warning in pre-bash: WARN where the poll guard DENIES.
 *
 * The asymmetry is the design — a full-suite run is sometimes right, so a
 * false warning merely costs a sentence, where the poll guard's false denial
 * blocks work. Still, most of this file pins the quiet cases: a warning that
 * fires on scoped runs teaches agents to ignore it, and then the one that
 * matters is skipped like the rest.
 */

import { describe, expect, test } from "bun:test";

import { EMPTY_CREWFILE, type CrewFile } from "../core/crewfile.ts";
import { checkTestPolicy } from "../hooks/pre-bash.ts";

const SCOPED_ONLY: CrewFile = {
  ...EMPTY_CREWFILE,
  checks: { test: "bun test", testScoped: "bun test {path}", lint: "" },
  testPolicy: "scoped-only",
};

const warn = (cmd: string, crew: CrewFile = SCOPED_ONLY): string => checkTestPolicy(cmd, crew);

describe("when the warning fires", () => {
  test("a bare full-suite run", () => {
    expect(warn("bun test")).not.toBe("");
  });

  test("full run with only flags is still full", () => {
    expect(warn("bun test --coverage")).not.toBe("");
    expect(warn("bun test --timeout 10000 --bail")).not.toBe("");
  });

  test("a full run after a cd or another statement", () => {
    expect(warn("cd apps/web && bun test")).not.toBe("");
    expect(warn("git pull; bun test")).not.toBe("");
  });

  test("a scoped statement does not excuse a full one beside it", () => {
    expect(warn("bun test test/a.test.ts; bun test")).not.toBe("");
  });

  test("the warning names the scoped alternative and the policy", () => {
    const text = warn("bun test");
    expect(text).toContain("bun test {path}");
    expect(text).toContain("scoped-only");
    expect(text).toContain("full test suite");
  });

  test("without a scoped form the advice still names a path form", () => {
    const noScoped: CrewFile = {
      ...SCOPED_ONLY,
      checks: { test: "npm test", testScoped: "", lint: "" },
    };
    const text = warn("npm test", noScoped);
    expect(text).toContain("npm test <path>");
  });

  test("a test command with regex metacharacters is matched literally", () => {
    const go: CrewFile = {
      ...SCOPED_ONLY,
      checks: { test: "go test ./...", testScoped: "go test {path}", lint: "" },
    };
    expect(warn("go test ./...", go)).not.toBe("");
    expect(warn("go test ./pkg/api", go)).toBe("");
  });
});

describe("when it stays quiet", () => {
  test("a scoped run — the thing the policy asks for", () => {
    expect(warn("bun test test/crewfile.test.ts")).toBe("");
    expect(warn("bun test test/a.test.ts test/b.test.ts")).toBe("");
    expect(warn("bun test --timeout 10000 test/a.test.ts")).toBe("");
  });

  test("no policy, no opinion", () => {
    expect(warn("bun test", EMPTY_CREWFILE)).toBe("");
    expect(warn("bun test", { ...SCOPED_ONLY, testPolicy: "full-ok" })).toBe("");
    expect(warn("bun test", { ...SCOPED_ONLY, testPolicy: "" })).toBe("");
  });

  test("a policy with no known test command cannot match anything", () => {
    expect(warn("bun test", { ...SCOPED_ONLY, checks: { test: "", testScoped: "", lint: "" } })).toBe(
      "",
    );
  });

  test("commands that merely contain the words", () => {
    expect(warn("bun tester")).toBe("");
    expect(warn("echo bun testing")).toBe("");
    expect(warn("git commit -m 'bun test everything'")).toBe("");
  });

  test("the pattern quoted as data is not a run", () => {
    expect(warn('echo "bun test" > run.sh')).toBe("");
    expect(warn("# bun test\nls")).toBe("");
  });

  test("unrelated commands", () => {
    expect(warn("crew who")).toBe("");
    expect(warn("git status")).toBe("");
    expect(warn("")).toBe("");
  });

  test("npm's `--` separator before a path reads as scoped", () => {
    const npm: CrewFile = {
      ...SCOPED_ONLY,
      checks: { test: "npm test", testScoped: "npm test -- {path}", lint: "" },
    };
    expect(warn("npm test -- test/a.spec.ts", npm)).toBe("");
  });

  test("repeated calls agree — no stateful regex", () => {
    for (const cmd of ["bun test", "bun test test/a.test.ts"]) {
      const first = warn(cmd);
      expect(warn(cmd)).toBe(first);
      expect(warn(cmd)).toBe(first);
    }
  });
});
