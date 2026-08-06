/**
 * The repo's shape, read from `<root>/.claude/crew.json`.
 *
 * THE FILE IS OPTIONAL, and read on hook paths — so parsing degrades per
 * FIELD, never throws, exactly like `core/config.ts`. A typo in `hot` must
 * not take a session's edit down with it. See plans/INIT_PLAN.md.
 */

import { readFileSync } from "node:fs";

import { DEFAULTS, loadConfig, type PresenceConfig } from "./config.ts";

export interface CrewChecks {
  /** Full-suite command, e.g. `bun test`. Empty when unknown. */
  readonly test: string;
  /** One-file form with a `{path}` placeholder. Empty when no honest form exists. */
  readonly testScoped: string;
  readonly lint: string;
}

export interface CodegenPair {
  readonly edits: string;
  readonly stales: string;
  readonly run: string;
}

export interface CrewFile {
  readonly v: number;
  readonly units: readonly string[];
  readonly generated: readonly string[];
  readonly hot: readonly string[];
  readonly sequenced: readonly string[];
  readonly checks: CrewChecks;
  /** Empty means "no policy" — never guessed. */
  readonly testPolicy: "" | "scoped-only" | "full-ok";
  readonly codegen: readonly CodegenPair[];
  /** Only valid PresenceConfig keys with finite positive values survive parsing. */
  readonly tunables: Partial<PresenceConfig>;
  /** Top-level keys that are neither schema nor reserved. Kept for `--check`. */
  readonly unknownKeys: readonly string[];
  /** Reserved keys found in the file. Init never writes them; `--check` reports. */
  readonly reservedKeys: readonly string[];
}

/** Names claimed for future consumers — see INIT_PLAN "Reserved keys". */
export const RESERVED_KEYS = ["topics", "roles", "protected", "injection"] as const;

const SCHEMA_KEYS = new Set([
  "v",
  "units",
  "generated",
  "hot",
  "sequenced",
  "checks",
  "testPolicy",
  "codegen",
  "tunables",
]);

export const EMPTY_CHECKS: CrewChecks = { test: "", testScoped: "", lint: "" };

export const EMPTY_CREWFILE: CrewFile = {
  v: 1,
  units: [],
  generated: [],
  hot: [],
  sequenced: [],
  checks: EMPTY_CHECKS,
  testPolicy: "",
  codegen: [],
  tunables: {},
  unknownKeys: [],
  reservedKeys: [],
};

export function crewfilePath(root: string): string {
  return `${root.replace(/\\/g, "/").replace(/\/$/, "")}/.claude/crew.json`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is string => typeof e === "string" && e.trim() !== "");
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseChecks(value: unknown): CrewChecks {
  if (typeof value !== "object" || value === null) return EMPTY_CHECKS;
  const o = value as Record<string, unknown>;
  return {
    test: stringField(o["test"]),
    testScoped: stringField(o["testScoped"]),
    lint: stringField(o["lint"]),
  };
}

function parseCodegen(value: unknown): CodegenPair[] {
  if (!Array.isArray(value)) return [];
  const pairs: CodegenPair[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const edits = stringField(o["edits"]);
    const run = stringField(o["run"]);
    // `stales` may be empty — an unknown output is a fact — but a pair with no
    // source or no command reconciles nothing and is dropped.
    if (edits === "" || run === "") continue;
    pairs.push({ edits, stales: stringField(o["stales"]), run });
  }
  return pairs;
}

function parseTunables(value: unknown): Partial<PresenceConfig> {
  if (typeof value !== "object" || value === null) return {};
  const given = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of Object.keys(DEFAULTS)) {
    const v = given[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out as Partial<PresenceConfig>;
}

/** Per-field parse of anything claiming to be a crew.json. Never throws. */
export function parseCrewFile(raw: unknown): CrewFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return EMPTY_CREWFILE;
  const o = raw as Record<string, unknown>;
  const policy = o["testPolicy"];
  const keys = Object.keys(o);
  return {
    v: typeof o["v"] === "number" && Number.isInteger(o["v"]) && o["v"] > 0 ? o["v"] : 1,
    units: stringList(o["units"]),
    generated: stringList(o["generated"]),
    hot: stringList(o["hot"]),
    sequenced: stringList(o["sequenced"]),
    checks: parseChecks(o["checks"]),
    testPolicy: policy === "scoped-only" || policy === "full-ok" ? policy : "",
    codegen: parseCodegen(o["codegen"]),
    tunables: parseTunables(o["tunables"]),
    unknownKeys: keys.filter(
      (k) => !SCHEMA_KEYS.has(k) && !(RESERVED_KEYS as readonly string[]).includes(k),
    ),
    reservedKeys: keys.filter((k) => (RESERVED_KEYS as readonly string[]).includes(k)),
  };
}

/**
 * Cached per ROOT, not per process: hooks resolve one root, but the CLI can be
 * asked about any directory, and one process must not serve stale answers for
 * a second repo because it read a first.
 */
const cache = new Map<string, CrewFile>();

export function loadCrewFile(root: string): CrewFile {
  const path = crewfilePath(root);
  const hit = cache.get(path);
  if (hit) return hit;
  const parsed = readCrewFile(path);
  cache.set(path, parsed);
  return parsed;
}

/** Test seam, mirroring `clearConfigCache`. */
export function clearCrewfileCache(): void {
  cache.clear();
}

function readCrewFile(path: string): CrewFile {
  try {
    return parseCrewFile(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return EMPTY_CREWFILE;
  }
}

/**
 * DEFAULTS ← global config.json ← repo tunables, per field.
 *
 * Lives here rather than in `loadConfig(root)` because that function takes no
 * root and its callers mostly have none; threading one through every call site
 * for the few that coordinate is the change INIT_PLAN argues against.
 */
export function repoConfig(root: string): PresenceConfig {
  return { ...loadConfig(), ...loadCrewFile(root).tunables };
}

/**
 * Compiled once per pattern per process — this runs on every edit, and
 * `Bun.Glob` construction is the expensive half.
 */
const globs = new Map<string, Bun.Glob>();

function glob(pattern: string): Bun.Glob {
  const hit = globs.get(pattern);
  if (hit) return hit;
  const g = new Bun.Glob(pattern);
  globs.set(pattern, g);
  return g;
}

/**
 * Does a PROJECT-RELATIVE, forward-slashed path match any pattern?
 *
 * A malformed pattern matches nothing rather than throwing: patterns arrive
 * from a hand-editable file on the hook path.
 */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  const p = path.replace(/\\/g, "/");
  for (const pattern of patterns) {
    try {
      if (glob(pattern).match(p)) return true;
    } catch {
      // A bad pattern is a no-op, not a crash.
    }
  }
  return false;
}
