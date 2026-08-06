/**
 * Reads a repo's manifests and derives its shape for crew.json.
 *
 * PER FORMAT, NOT PER ECOSYSTEM: each detector is a pure function over a
 * `FileAccess`, and an unknown ecosystem simply yields less. Absence of a key
 * means "no boundary known", never "no boundary". See plans/INIT_PLAN.md.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";

import type { CodegenPair, CrewChecks } from "./crewfile.ts";
import { EMPTY_CHECKS } from "./crewfile.ts";

/** The whole filesystem surface detection is allowed to touch. */
export interface FileAccess {
  exists(rel: string): boolean;
  /** Null when missing or unreadable — a detector treats both as absent. */
  read(rel: string): string | null;
  /** Immediate subdirectory names of a relative dir; [] when unreadable. */
  dirs(rel: string): string[];
}

export function fsAccess(root: string): FileAccess {
  const base = root.replace(/\\/g, "/").replace(/\/$/, "");
  const abs = (rel: string): string => (rel === "" ? base : `${base}/${rel}`);
  return {
    exists: (rel) => existsSync(abs(rel)),
    read: (rel) => {
      try {
        return readFileSync(abs(rel), "utf8");
      } catch {
        return null;
      }
    },
    dirs: (rel) => {
      try {
        return readdirSync(abs(rel), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    },
  };
}

export interface Detected {
  readonly units: readonly string[];
  readonly generated: readonly string[];
  readonly hot: readonly string[];
  readonly sequenced: readonly string[];
  readonly checks: CrewChecks;
  readonly codegen: readonly CodegenPair[];
}

/** Lockfile → package manager, in the order a repo with several is trusted. */
const NODE_LOCKFILES: ReadonlyArray<readonly [string, string]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

function nodePackageManager(fa: FileAccess): string {
  for (const [file, pm] of NODE_LOCKFILES) if (fa.exists(file)) return pm;
  return "npm";
}

/** How `npx`-style execution is spelled per package manager. */
function execFor(pm: string): string {
  if (pm === "bun") return "bunx";
  if (pm === "pnpm") return "pnpm exec";
  return "npx";
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Node checks. `testScoped` is claimed only for runners whose one-file form is
 * KNOWN — a guessed scoped command that fails teaches agents to distrust all
 * of crew.json, which costs more than the missing key.
 */
function nodeChecks(fa: FileAccess): CrewChecks {
  const pkg = parseJson(fa.read("package.json"));
  if (pkg === null) return EMPTY_CHECKS;
  const pm = nodePackageManager(fa);
  const scripts =
    typeof pkg["scripts"] === "object" && pkg["scripts"] !== null
      ? (pkg["scripts"] as Record<string, unknown>)
      : {};
  const testScript = typeof scripts["test"] === "string" ? scripts["test"] : "";
  const lint = typeof scripts["lint"] === "string" ? `${pm} run lint` : "";

  if (testScript.includes("bun test") || (testScript === "" && pm === "bun" && hasTests(fa))) {
    return { test: "bun test", testScoped: "bun test {path}", lint };
  }
  if (testScript === "" || testScript.includes("no test specified")) {
    return { test: "", testScoped: "", lint };
  }
  const test = pm === "npm" ? "npm test" : `${pm} test`;
  if (testScript.includes("vitest")) {
    return { test, testScoped: `${execFor(pm)} vitest run {path}`, lint };
  }
  if (testScript.includes("jest")) {
    return { test, testScoped: `${execFor(pm)} jest {path}`, lint };
  }
  return { test, testScoped: "", lint };
}

/** A `test/` dir or a bunfig is evidence that `bun test` has something to run. */
function hasTests(fa: FileAccess): boolean {
  return fa.exists("test") || fa.exists("tests") || fa.exists("bunfig.toml");
}

function pythonChecks(fa: FileAccess): CrewChecks {
  const pyproject = fa.read("pyproject.toml");
  const pytestConfigured =
    (pyproject !== null && pyproject.includes("[tool.pytest")) ||
    fa.exists("pytest.ini") ||
    (fa.read("setup.cfg") ?? "").includes("[tool:pytest]");
  if (!pytestConfigured) return EMPTY_CHECKS;
  return { test: "pytest", testScoped: "pytest {path}", lint: "" };
}

function goChecks(fa: FileAccess): CrewChecks {
  if (!fa.exists("go.mod")) return EMPTY_CHECKS;
  return { test: "go test ./...", testScoped: "go test {path}", lint: "" };
}

function rustChecks(fa: FileAccess): CrewChecks {
  if (!fa.exists("Cargo.toml")) return EMPTY_CHECKS;
  // No scoped form: `cargo test <filter>` filters by NAME, not path, and a
  // `{path}` placeholder that is really a name filter would lie.
  return { test: "cargo test", testScoped: "", lint: "" };
}

/** First ecosystem that answers wins; a polyglot repo edits crew.json by hand. */
export function detectChecks(fa: FileAccess): CrewChecks {
  for (const detector of [nodeChecks, pythonChecks, goChecks, rustChecks]) {
    const checks = detector(fa);
    if (checks.test !== "" || checks.lint !== "") return checks;
  }
  return EMPTY_CHECKS;
}

export function detectUnits(fa: FileAccess): string[] {
  const units: string[] = [];
  const pkg = parseJson(fa.read("package.json"));
  const workspaces = pkg?.["workspaces"];
  if (Array.isArray(workspaces)) {
    units.push(...workspaces.filter((w): w is string => typeof w === "string"));
  } else if (typeof workspaces === "object" && workspaces !== null) {
    const packages = (workspaces as Record<string, unknown>)["packages"];
    if (Array.isArray(packages)) {
      units.push(...packages.filter((w): w is string => typeof w === "string"));
    }
  }

  const pnpm = fa.read("pnpm-workspace.yaml");
  if (pnpm !== null) {
    for (const m of pnpm.matchAll(/^\s*-\s*["']?([^"'#\n]+?)["']?\s*$/gm)) {
      units.push((m[1] ?? "").trim());
    }
  }

  const cargo = fa.read("Cargo.toml");
  if (cargo !== null && cargo.includes("[workspace]")) {
    const members = /members\s*=\s*\[([^\]]*)\]/.exec(cargo)?.[1] ?? "";
    for (const m of members.matchAll(/["']([^"']+)["']/g)) units.push(m[1] ?? "");
  }

  const gowork = fa.read("go.work");
  if (gowork !== null) {
    for (const m of gowork.matchAll(/^\s*(?:use\s+)?\.\/(\S+)\s*$/gm)) units.push(m[1] ?? "");
  }

  return unique(units.filter((u) => u !== "" && u !== "."));
}

/** Conventional build-output directory names, matched at the repo root. */
const GENERATED_DIRS = [
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
] as const;

export function detectGenerated(fa: FileAccess): string[] {
  const ignore = fa.read(".gitignore") ?? "";
  const ignored = new Set(
    ignore
      .split("\n")
      .map((l) => l.trim().replace(/^\//, "").replace(/\/$/, ""))
      .filter((l) => l !== "" && !l.startsWith("#")),
  );
  const generated: string[] = [];
  for (const dir of GENERATED_DIRS) {
    // Existing now, or promised by .gitignore — an output dir a clean checkout
    // has not built yet still must not be claimed when it appears.
    if (fa.exists(dir) || ignored.has(dir)) generated.push(`${dir}/**`);
  }
  if (fa.exists("package.json") || ignored.has("node_modules")) {
    generated.push("**/node_modules/**");
  }
  if (ignored.has("__generated__")) generated.push("**/__generated__/**");
  return generated;
}

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
] as const;

const ROOT_MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pnpm-workspace.yaml",
] as const;

export function detectHot(fa: FileAccess): string[] {
  const hot: string[] = [];
  for (const f of [...LOCKFILES, ...ROOT_MANIFESTS]) if (fa.exists(f)) hot.push(f);
  if (fa.exists("prisma/schema.prisma")) hot.push("prisma/schema.prisma");
  return hot;
}

const SEQUENCED_DIRS = [
  "prisma/migrations",
  "db/migrate",
  "migrations",
  "alembic/versions",
  "supabase/migrations",
] as const;

export function detectSequenced(fa: FileAccess): string[] {
  return SEQUENCED_DIRS.filter((d) => fa.exists(d));
}

export function detectCodegen(fa: FileAccess): CodegenPair[] {
  const pairs: CodegenPair[] = [];
  if (fa.exists("prisma/schema.prisma")) {
    pairs.push({ edits: "prisma/schema.prisma", stales: "", run: "prisma generate" });
  }
  if (fa.exists("buf.gen.yaml")) {
    pairs.push({ edits: "**/*.proto", stales: "", run: "buf generate" });
  }
  if (fa.exists("codegen.yml") || fa.exists("codegen.ts")) {
    pairs.push({ edits: "**/*.graphql", stales: "", run: "graphql-codegen" });
  }
  return pairs;
}

export function detect(fa: FileAccess): Detected {
  return {
    units: detectUnits(fa),
    generated: detectGenerated(fa),
    hot: detectHot(fa),
    sequenced: detectSequenced(fa),
    checks: detectChecks(fa),
    codegen: detectCodegen(fa),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
