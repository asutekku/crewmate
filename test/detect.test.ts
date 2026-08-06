/**
 * Detection: manifests in, partial config out.
 *
 * Every detector is a pure function over `FileAccess`, so these run against an
 * in-memory tree — no fixtures on disk except the `fsAccess` describe, which
 * pins the one adapter that touches the real filesystem.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import {
  detect,
  detectChecks,
  detectCodegen,
  detectGenerated,
  detectHot,
  detectSequenced,
  detectUnits,
  fsAccess,
  type FileAccess,
} from "../core/detect.ts";

/** An in-memory tree: `files` maps rel path → content, `dirs` lists dirs. */
function mem(files: Record<string, string>, dirs: string[] = []): FileAccess {
  const dirSet = new Set(dirs);
  return {
    exists: (rel) => rel in files || dirSet.has(rel),
    read: (rel) => files[rel] ?? null,
    dirs: (rel) =>
      [...dirSet]
        .filter((d) => (rel === "" ? !d.includes("/") : d.startsWith(`${rel}/`)))
        .map((d) => (rel === "" ? d : d.slice(rel.length + 1)))
        .filter((d) => !d.includes("/")),
  };
}

const pkg = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("checks: node", () => {
  test("a bun repo with a test dir gets the scoped form", () => {
    const fa = mem({ "package.json": pkg({}), "bun.lock": "" }, ["test"]);
    expect(detectChecks(fa)).toEqual({ test: "bun test", testScoped: "bun test {path}", lint: "" });
  });

  test("a `bun test` script is recognised whatever the lockfile", () => {
    const fa = mem({ "package.json": pkg({ scripts: { test: "bun test" } }) });
    expect(detectChecks(fa).testScoped).toBe("bun test {path}");
  });

  test("vitest under pnpm: scoped via `pnpm exec vitest run`", () => {
    const fa = mem({
      "package.json": pkg({ scripts: { test: "vitest" } }),
      "pnpm-lock.yaml": "",
    });
    expect(detectChecks(fa)).toEqual({
      test: "pnpm test",
      testScoped: "pnpm exec vitest run {path}",
      lint: "",
    });
  });

  test("jest under yarn: scoped via npx", () => {
    const fa = mem({
      "package.json": pkg({ scripts: { test: "jest --ci" } }),
      "yarn.lock": "",
    });
    expect(detectChecks(fa)).toEqual({ test: "yarn test", testScoped: "npx jest {path}", lint: "" });
  });

  test("an unknown runner claims no scoped form — a guessed command would lie", () => {
    const fa = mem({
      "package.json": pkg({ scripts: { test: "node run-tests.js" } }),
      "package-lock.json": "",
    });
    expect(detectChecks(fa)).toEqual({ test: "npm test", testScoped: "", lint: "" });
  });

  test("npm's placeholder script is not a test command", () => {
    const fa = mem({
      "package.json": pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    });
    expect(detectChecks(fa).test).toBe("");
  });

  test("a lint script is reported through the detected package manager", () => {
    const fa = mem({
      "package.json": pkg({ scripts: { lint: "eslint .", test: "bun test" } }),
      "bun.lock": "",
    });
    expect(detectChecks(fa).lint).toBe("bun run lint");
  });

  test("no package.json, no node answer", () => {
    expect(detectChecks(mem({ "bun.lock": "" }))).toEqual({ test: "", testScoped: "", lint: "" });
  });

  test("malformed package.json is absent, not fatal", () => {
    expect(() => detectChecks(mem({ "package.json": "{oops" }))).not.toThrow();
    expect(detectChecks(mem({ "package.json": "{oops" })).test).toBe("");
  });
});

describe("checks: other ecosystems", () => {
  test("pyproject with [tool.pytest] means pytest, path-scoped", () => {
    const fa = mem({ "pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-q'" });
    expect(detectChecks(fa)).toEqual({ test: "pytest", testScoped: "pytest {path}", lint: "" });
  });

  test("pytest.ini and setup.cfg [tool:pytest] count as configured", () => {
    expect(detectChecks(mem({ "pytest.ini": "" })).test).toBe("pytest");
    expect(detectChecks(mem({ "setup.cfg": "[tool:pytest]\n" })).test).toBe("pytest");
  });

  test("a pyproject with no pytest section claims nothing", () => {
    expect(detectChecks(mem({ "pyproject.toml": "[tool.poetry]" })).test).toBe("");
  });

  test("go.mod means `go test`, package-scoped", () => {
    expect(detectChecks(mem({ "go.mod": "module x" }))).toEqual({
      test: "go test ./...",
      testScoped: "go test {path}",
      lint: "",
    });
  });

  test("cargo gets no scoped form — `cargo test <arg>` filters by NAME, not path", () => {
    expect(detectChecks(mem({ "Cargo.toml": "[package]" }))).toEqual({
      test: "cargo test",
      testScoped: "",
      lint: "",
    });
  });

  test("node wins over a python sidecar in one repo", () => {
    const fa = mem({
      "package.json": pkg({ scripts: { test: "bun test" } }),
      "pyproject.toml": "[tool.pytest.ini_options]",
    });
    expect(detectChecks(fa).test).toBe("bun test");
  });

  test("an empty repo yields empty checks", () => {
    expect(detectChecks(mem({}))).toEqual({ test: "", testScoped: "", lint: "" });
  });
});

describe("units: workspace boundaries", () => {
  test("package.json workspaces, array form", () => {
    const fa = mem({ "package.json": pkg({ workspaces: ["apps/*", "packages/*"] }) });
    expect(detectUnits(fa)).toEqual(["apps/*", "packages/*"]);
  });

  test("package.json workspaces, object form", () => {
    const fa = mem({ "package.json": pkg({ workspaces: { packages: ["libs/*"] } }) });
    expect(detectUnits(fa)).toEqual(["libs/*"]);
  });

  test("pnpm-workspace.yaml list entries", () => {
    const fa = mem({ "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - \"tools/cli\"\n" });
    expect(detectUnits(fa)).toEqual(["apps/*", "tools/cli"]);
  });

  test("Cargo workspace members", () => {
    const fa = mem({ "Cargo.toml": '[workspace]\nmembers = ["crates/core", "crates/cli"]\n' });
    expect(detectUnits(fa)).toEqual(["crates/core", "crates/cli"]);
  });

  test("go.work use directives, bare and parenthesised lines", () => {
    const fa = mem({ "go.work": "go 1.22\n\nuse ./svc/api\nuse (\n\t./svc/worker\n)\n" });
    expect(detectUnits(fa)).toEqual(["svc/api", "svc/worker"]);
  });

  test("duplicates collapse and `.` is dropped", () => {
    const fa = mem({
      "package.json": pkg({ workspaces: ["apps/*"] }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - .\n",
    });
    expect(detectUnits(fa)).toEqual(["apps/*"]);
  });

  test("no workspace config means no units — never a guessed boundary", () => {
    expect(detectUnits(mem({ "package.json": pkg({}) }))).toEqual([]);
  });
});

describe("generated: build outputs", () => {
  test("a conventional dir that exists is covered", () => {
    expect(detectGenerated(mem({}, ["dist"]))).toEqual(["dist/**"]);
  });

  test("a dir promised by .gitignore is covered before it first appears", () => {
    expect(detectGenerated(mem({ ".gitignore": "target/\n" }))).toEqual(["target/**"]);
  });

  test("gitignore slashes and comments are tolerated", () => {
    const fa = mem({ ".gitignore": "# build\n/dist/\n\n.next\n" });
    expect(detectGenerated(fa)).toEqual(["dist/**", ".next/**"]);
  });

  test("node repos exclude node_modules at any depth", () => {
    expect(detectGenerated(mem({ "package.json": pkg({}) }))).toEqual(["**/node_modules/**"]);
  });

  test("__generated__ is covered when gitignored", () => {
    expect(detectGenerated(mem({ ".gitignore": "__generated__\n" }))).toEqual([
      "**/__generated__/**",
    ]);
  });

  test("an empty repo generates nothing", () => {
    expect(detectGenerated(mem({}))).toEqual([]);
  });
});

describe("hot: files where concurrent edits always conflict", () => {
  test("every present lockfile and root manifest is hot", () => {
    const fa = mem({ "bun.lock": "", "package.json": pkg({}), "Cargo.lock": "" });
    expect(detectHot(fa).sort()).toEqual(["Cargo.lock", "bun.lock", "package.json"]);
  });

  test("a prisma schema is hot", () => {
    expect(detectHot(mem({ "prisma/schema.prisma": "" }))).toEqual(["prisma/schema.prisma"]);
  });

  test("nothing present, nothing hot", () => {
    expect(detectHot(mem({}))).toEqual([]);
  });
});

describe("sequenced and codegen", () => {
  test("known migration dirs are sequenced when they exist", () => {
    expect(detectSequenced(mem({}, ["prisma/migrations", "db/migrate", "prisma", "db"]))).toEqual([
      "prisma/migrations",
      "db/migrate",
    ]);
    expect(detectSequenced(mem({}))).toEqual([]);
  });

  test("prisma, buf and graphql-codegen each yield a pair", () => {
    const fa = mem({ "prisma/schema.prisma": "", "buf.gen.yaml": "", "codegen.yml": "" });
    expect(detectCodegen(fa).map((p) => p.run)).toEqual([
      "prisma generate",
      "buf generate",
      "graphql-codegen",
    ]);
  });
});

describe("detect: the composite", () => {
  test("a realistic bun monorepo", () => {
    const fa = mem(
      {
        "package.json": pkg({ workspaces: ["apps/*"], scripts: { test: "bun test" } }),
        "bun.lock": "",
        ".gitignore": "dist/\nnode_modules\n",
      },
      ["test"],
    );
    const detected = detect(fa);
    expect(detected.units).toEqual(["apps/*"]);
    expect(detected.generated).toEqual(["dist/**", "**/node_modules/**"]);
    expect([...detected.hot].sort()).toEqual(["bun.lock", "package.json"]);
    expect(detected.checks.testScoped).toBe("bun test {path}");
    expect(detected.sequenced).toEqual([]);
    expect(detected.codegen).toEqual([]);
  });

  test("an empty directory detects nothing at all", () => {
    expect(detect(mem({}))).toEqual({
      units: [],
      generated: [],
      hot: [],
      sequenced: [],
      checks: { test: "", testScoped: "", lint: "" },
      codegen: [],
    });
  });
});

describe("fsAccess: the one adapter that touches disk", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("exists, read and dirs answer over a real tree", () => {
    const root = `${tmpdir().replace(/\\/g, "/")}/detect-fs-${process.pid}`;
    roots.push(root);
    mkdirSync(`${root}/prisma/migrations`, { recursive: true });
    writeFileSync(`${root}/package.json`, "{}");
    const fa = fsAccess(root);
    expect(fa.exists("package.json")).toBe(true);
    expect(fa.exists("prisma/migrations")).toBe(true);
    expect(fa.exists("nope.txt")).toBe(false);
    expect(fa.read("package.json")).toBe("{}");
    expect(fa.read("nope.txt")).toBeNull();
    expect(fa.dirs("")).toEqual(["prisma"]);
    expect(fa.dirs("prisma")).toEqual(["migrations"]);
    expect(fa.dirs("missing")).toEqual([]);
  });
});
