/**
 * crew.json parsing: per-FIELD degradation, the same contract as
 * `core/config.ts`. The file is hand-editable and read on the pre-edit hook
 * path, so every malformed shape below must yield a working config, never a
 * throw — and one bad field must not revert the rest.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { loadConfig } from "../core/config.ts";
import {
  clearCrewfileCache,
  crewfilePath,
  EMPTY_CREWFILE,
  loadCrewFile,
  matchesAny,
  parseCrewFile,
  repoConfig,
} from "../core/crewfile.ts";

let n = 0;
const roots: string[] = [];

function freshRoot(): string {
  const root = `${tmpdir().replace(/\\/g, "/")}/crewfile-${process.pid}-${n++}`;
  mkdirSync(`${root}/.claude`, { recursive: true });
  roots.push(root);
  return root;
}

function writeCrewfile(root: string, content: string): void {
  writeFileSync(crewfilePath(root), content);
}

afterEach(() => {
  clearCrewfileCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseCrewFile: shapes that are not a crew.json", () => {
  test("null, arrays and scalars parse to the empty shape", () => {
    expect(parseCrewFile(null)).toEqual(EMPTY_CREWFILE);
    expect(parseCrewFile([1, 2])).toEqual(EMPTY_CREWFILE);
    expect(parseCrewFile("hot")).toEqual(EMPTY_CREWFILE);
    expect(parseCrewFile(42)).toEqual(EMPTY_CREWFILE);
    expect(parseCrewFile(undefined)).toEqual(EMPTY_CREWFILE);
  });

  test("an empty object is a valid, empty crew.json", () => {
    const parsed = parseCrewFile({});
    expect(parsed.v).toBe(1);
    expect(parsed.hot).toEqual([]);
    expect(parsed.testPolicy).toBe("");
  });
});

describe("parseCrewFile: per-field degradation", () => {
  test("a full valid file round-trips", () => {
    const parsed = parseCrewFile({
      v: 2,
      units: ["apps/*"],
      generated: ["dist/**"],
      hot: ["package.json"],
      sequenced: ["migrations"],
      checks: { test: "bun test", testScoped: "bun test {path}", lint: "eslint" },
      testPolicy: "scoped-only",
      codegen: [{ edits: "a.prisma", stales: "gen/**", run: "prisma generate" }],
      tunables: { workStaleMs: 3600 },
    });
    expect(parsed.v).toBe(2);
    expect(parsed.units).toEqual(["apps/*"]);
    expect(parsed.checks.testScoped).toBe("bun test {path}");
    expect(parsed.testPolicy).toBe("scoped-only");
    expect(parsed.codegen).toEqual([{ edits: "a.prisma", stales: "gen/**", run: "prisma generate" }]);
    expect(parsed.tunables).toEqual({ workStaleMs: 3600 });
    expect(parsed.unknownKeys).toEqual([]);
    expect(parsed.reservedKeys).toEqual([]);
  });

  test("one bad field does not drop the rest", () => {
    const parsed = parseCrewFile({ hot: "package.json", generated: ["dist/**"] });
    expect(parsed.hot).toEqual([]);
    expect(parsed.generated).toEqual(["dist/**"]);
  });

  test("non-string and empty entries are filtered from lists, not fatal", () => {
    const parsed = parseCrewFile({ hot: ["a.lock", 3, null, "", "  ", "b.lock"] });
    expect(parsed.hot).toEqual(["a.lock", "b.lock"]);
  });

  test("checks tolerates partial and wrongly-typed fields", () => {
    expect(parseCrewFile({ checks: { test: "bun test" } }).checks).toEqual({
      test: "bun test",
      testScoped: "",
      lint: "",
    });
    expect(parseCrewFile({ checks: "bun test" }).checks.test).toBe("");
    expect(parseCrewFile({ checks: { test: 5 } }).checks.test).toBe("");
  });

  test("an unrecognised testPolicy degrades to no policy", () => {
    expect(parseCrewFile({ testPolicy: "sometimes" }).testPolicy).toBe("");
    expect(parseCrewFile({ testPolicy: true }).testPolicy).toBe("");
    expect(parseCrewFile({ testPolicy: "full-ok" }).testPolicy).toBe("full-ok");
  });

  test("codegen keeps empty `stales` but drops pairs missing source or command", () => {
    const parsed = parseCrewFile({
      codegen: [
        { edits: "s.prisma", stales: "", run: "prisma generate" },
        { edits: "", stales: "x", run: "y" },
        { edits: "a", stales: "b", run: "" },
        "not-an-object",
        null,
      ],
    });
    expect(parsed.codegen).toEqual([{ edits: "s.prisma", stales: "", run: "prisma generate" }]);
  });

  test("tunables keeps only known keys with finite positive numbers", () => {
    const parsed = parseCrewFile({
      tunables: {
        workStaleMs: 1000,
        staleMs: 0,
        claimTtlMs: -5,
        editKeepMs: "7 days",
        diaryKeepMs: Number.NaN,
        notAKnob: 99,
      },
    });
    expect(parsed.tunables).toEqual({ workStaleMs: 1000 });
  });

  test("a bad version number falls back to 1", () => {
    expect(parseCrewFile({ v: "two" }).v).toBe(1);
    expect(parseCrewFile({ v: 0 }).v).toBe(1);
    expect(parseCrewFile({ v: 1.5 }).v).toBe(1);
  });

  test("unknown and reserved keys are reported separately, never dropped silently", () => {
    const parsed = parseCrewFile({ topics: ["db"], protected: ["ci/**"], banana: 1 });
    expect([...parsed.reservedKeys].sort()).toEqual(["protected", "topics"]);
    expect(parsed.unknownKeys).toEqual(["banana"]);
  });
});

describe("loadCrewFile: the file on disk", () => {
  test("a missing file is the empty shape", () => {
    expect(loadCrewFile(freshRoot())).toEqual(EMPTY_CREWFILE);
  });

  test("malformed JSON degrades to the empty shape — a typo must not break edits", () => {
    const root = freshRoot();
    writeCrewfile(root, "{ hot: [unquoted}");
    expect(loadCrewFile(root)).toEqual(EMPTY_CREWFILE);
  });

  test("a valid file is read and parsed", () => {
    const root = freshRoot();
    writeCrewfile(root, JSON.stringify({ hot: ["bun.lock"] }));
    expect(loadCrewFile(root).hot).toEqual(["bun.lock"]);
  });

  test("cached per root until the seam clears it", () => {
    const root = freshRoot();
    writeCrewfile(root, JSON.stringify({ hot: ["a"] }));
    expect(loadCrewFile(root).hot).toEqual(["a"]);
    writeCrewfile(root, JSON.stringify({ hot: ["b"] }));
    expect(loadCrewFile(root).hot).toEqual(["a"]);
    clearCrewfileCache();
    expect(loadCrewFile(root).hot).toEqual(["b"]);
  });

  test("two roots do not share a cache slot", () => {
    const one = freshRoot();
    const two = freshRoot();
    writeCrewfile(one, JSON.stringify({ hot: ["one"] }));
    writeCrewfile(two, JSON.stringify({ hot: ["two"] }));
    expect(loadCrewFile(one).hot).toEqual(["one"]);
    expect(loadCrewFile(two).hot).toEqual(["two"]);
  });
});

describe("repoConfig: DEFAULTS ← global ← repo, per field", () => {
  // Asserted RELATIVE to loadConfig() rather than to DEFAULTS, because the
  // machine running this test may legitimately have a global config.json.
  test("with no crewfile every value equals the global answer", () => {
    expect(repoConfig(freshRoot())).toEqual(loadConfig());
  });

  test("a repo tunable overrides the global value; the rest stay", () => {
    const root = freshRoot();
    writeCrewfile(root, JSON.stringify({ tunables: { workStaleMs: 12345 } }));
    const merged = repoConfig(root);
    expect(merged.workStaleMs).toBe(12345);
    expect(merged.staleMs).toBe(loadConfig().staleMs);
  });

  test("an invalid repo tunable falls back rather than poisoning the merge", () => {
    const root = freshRoot();
    writeCrewfile(root, JSON.stringify({ tunables: { workStaleMs: "long" } }));
    expect(repoConfig(root).workStaleMs).toBe(loadConfig().workStaleMs);
  });
});

describe("matchesAny: the pattern language hooks rely on", () => {
  test("an exact filename matches only at the root", () => {
    expect(matchesAny(["package.json"], "package.json")).toBe(true);
    expect(matchesAny(["package.json"], "apps/web/package.json")).toBe(false);
  });

  test("a dir glob covers everything under it", () => {
    expect(matchesAny(["dist/**"], "dist/index.js")).toBe(true);
    expect(matchesAny(["dist/**"], "dist/a/b/c.map")).toBe(true);
    expect(matchesAny(["dist/**"], "src/dist.ts")).toBe(false);
  });

  test("a `**/` prefix matches at any depth", () => {
    expect(matchesAny(["**/node_modules/**"], "apps/web/node_modules/x/y.js")).toBe(true);
    expect(matchesAny(["**/*.lock"], "apps/web/deep/some.lock")).toBe(true);
  });

  test("backslash input is normalised before matching", () => {
    expect(matchesAny(["dist/**"], "dist\\index.js")).toBe(true);
  });

  test("no patterns match nothing", () => {
    expect(matchesAny([], "anything.ts")).toBe(false);
  });

  test("a malformed pattern is a no-op, not a crash", () => {
    expect(() => matchesAny(["[", "dist/**"], "dist/x.js")).not.toThrow();
    expect(matchesAny(["[", "dist/**"], "dist/x.js")).toBe(true);
  });
});
