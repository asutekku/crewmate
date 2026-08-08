/**
 * `crew init` — reads the repo's shape, writes the three repo files.
 *
 * NEVER PROMPTS. Bare `init` applies detection plus defaults, so it works the
 * same from a terminal, a script, or an agent's shell; flags override, and
 * `--check` previews without writing. See plans/INIT_PLAN.md.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { bold, cyan, dim, green, red, yellow } from "../core/colour.ts";
import {
  crewfilePath,
  parseCrewFile,
  RESERVED_KEYS,
  clearCrewfileCache,
} from "../core/crewfile.ts";
import { detect, fsAccess, type Detected } from "../core/detect.ts";
import {
  applyBlock,
  findClaudeMd,
  markersDamaged,
  renderBlock,
  BLOCK_BEGIN,
} from "../core/initBlock.ts";
import { installedVersion } from "../core/repo.ts";
import { booleanFlag, parseArguments, parseEnum, stringFlag } from "./args.ts";
import { failCommand } from "./command.ts";
import type { CliContext, CommandMap } from "./types.ts";

export interface InitOptions {
  readonly crewSize?: string;
  readonly taskLength?: "short" | "long";
  readonly overnight: boolean;
  readonly testPolicy?: "scoped-only" | "full-ok";
  readonly baseRef: string;
  /** `--sign` / `--no-sign`; undefined keeps whatever the file already says. */
  readonly sign?: boolean;
  readonly sessionUrl?: boolean;
}

/** The headline's N. Free integers pass through; the default names a range. */
export function crewSizeLabel(flag: string | undefined): string {
  if (flag === undefined) return "3–10";
  if (flag === "2-3") return "2–3";
  if (flag === "4-8") return "4–8";
  if (flag === "more") return "8+";
  return /^\d+$/.test(flag) ? flag : "3–10";
}

/**
 * Only the tunables a flag can defend — see INIT_PLAN's table. No flag, no
 * key: an empty answer set writes nothing and the defaults stay in force.
 */
export function deriveTunables(options: InitOptions): Record<string, number> {
  const tunables: Record<string, number> = {};
  const size = options.crewSize ?? "";
  if (size === "more" || (/^\d+$/.test(size) && Number(size) > 8)) {
    tunables["injectionTargetChars"] = 9000;
  }
  if (options.taskLength === "long") {
    tunables["claimTtlMs"] = 4 * 60 * 60 * 1000;
    tunables["workStaleMs"] = 3 * 60 * 60 * 1000;
  }
  if (options.overnight) tunables["staleMs"] = 12 * 60 * 60 * 1000;
  return tunables;
}

/** Keys whose consumers have shipped — the only ones init itself writes. */
const WRITTEN_KEYS = ["generated", "hot", "checks", "testPolicy", "commit", "tunables"] as const;

/** Detected keys whose consumers are still pending (INIT_PLAN P4). */
const PENDING_KEYS = ["units", "sequenced", "codegen"] as const;

function union(a: readonly unknown[], b: readonly string[]): string[] {
  const merged = [...a.filter((e): e is string => typeof e === "string"), ...b];
  return [...new Set(merged)];
}

/**
 * The object to write: fresh detection layered over the existing file.
 *
 * ARRAYS UNION rather than replace, so a hand-added `hot` entry survives a
 * re-run; hand-written pending, reserved and unknown keys pass through
 * verbatim. Flags beat hand values beat detection for the scalar keys.
 */
export function deriveCrewJson(
  detected: Detected,
  existingRaw: Record<string, unknown> | null,
  options: InitOptions,
): Record<string, unknown> {
  const existing = existingRaw ?? {};
  const parsed = parseCrewFile(existing);

  const out: Record<string, unknown> = { v: 1 };
  const units = union(Array.isArray(existing["units"]) ? existing["units"] : [], []);
  if (units.length > 0) out["units"] = units;

  const generated = union(
    Array.isArray(existing["generated"]) ? existing["generated"] : [],
    detected.generated,
  );
  if (generated.length > 0) out["generated"] = generated;

  const hot = union(Array.isArray(existing["hot"]) ? existing["hot"] : [], detected.hot);
  if (hot.length > 0) out["hot"] = hot;

  if (Array.isArray(existing["sequenced"]) && existing["sequenced"].length > 0) {
    out["sequenced"] = existing["sequenced"];
  }

  const checks = {
    test: parsed.checks.test !== "" ? parsed.checks.test : detected.checks.test,
    testScoped:
      parsed.checks.testScoped !== "" ? parsed.checks.testScoped : detected.checks.testScoped,
    lint: parsed.checks.lint !== "" ? parsed.checks.lint : detected.checks.lint,
  };
  if (checks.test !== "" || checks.testScoped !== "" || checks.lint !== "") {
    out["checks"] = checks;
  }

  const policy =
    options.testPolicy ??
    (parsed.testPolicy !== "" ? parsed.testPolicy : checks.testScoped !== "" ? "scoped-only" : "");
  if (policy !== "") out["testPolicy"] = policy;

  // WRITTEN ONLY WHEN ON, so a repo that never asked for signing keeps a
  // crew.json with no opinion about it rather than an explicit `false`.
  const commit = {
    sign: options.sign ?? parsed.commit.sign,
    sessionUrl: options.sessionUrl ?? parsed.commit.sessionUrl,
  };
  if (commit.sign || commit.sessionUrl) out["commit"] = commit;

  if (Array.isArray(existing["codegen"]) && existing["codegen"].length > 0) {
    out["codegen"] = existing["codegen"];
  }

  const tunables = {
    ...(typeof existing["tunables"] === "object" && existing["tunables"] !== null
      ? (existing["tunables"] as Record<string, unknown>)
      : {}),
    ...deriveTunables(options),
  };
  if (Object.keys(tunables).length > 0) out["tunables"] = tunables;

  const handled = new Set<string>([...WRITTEN_KEYS, ...PENDING_KEYS, "v"]);
  for (const key of Object.keys(existing)) {
    if (!(key in out) && !handled.has(key)) out[key] = existing[key];
  }
  return out;
}

/**
 * Sets `worktree.baseRef`, leaving every other key byte-preserving in intent:
 * the file is reserialized, but no other value is changed or dropped. Invalid
 * JSON is an ABORT, not an overwrite.
 */
export function mergeSettings(
  rawText: string | null,
  baseRef: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  let settings: Record<string, unknown> = {};
  if (rawText !== null && rawText.trim() !== "") {
    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: "settings.json is not a JSON object" };
      }
      settings = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, error: "settings.json is not valid JSON — fix it before init writes" };
    }
  }
  const worktree =
    typeof settings["worktree"] === "object" && settings["worktree"] !== null
      ? (settings["worktree"] as Record<string, unknown>)
      : {};
  settings["worktree"] = { ...worktree, baseRef };
  return { ok: true, text: `${JSON.stringify(settings, null, 2)}\n` };
}

function readRaw(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const HOME = homedir().replace(/\\/g, "/");

function shimInstalled(): boolean {
  return existsSync(`${HOME}/.local/bin/crew`) || existsSync(`${HOME}/.local/bin/crew.cmd`);
}

export function createInitCommands(context: CliContext): CommandMap {
  return {
    init(args) {
      const parsed = parseArguments(args, {
        booleanFlags: [
          "--check", "--repo", "--yes", "--claude-md", "--no-claude-md", "--overnight",
          "--sign", "--no-sign", "--session-url",
        ],
        valueFlags: ["--crew-size", "--task-length", "--test-policy", "--base-ref"],
        maxPositionals: 0,
      });
      if (!parsed.ok) return failCommand(context, `init: ${parsed.error}`);
      const check = booleanFlag(parsed.value, "--check");
      const repoOnly = booleanFlag(parsed.value, "--repo");
      if (repoOnly && !check) {
        return failCommand(context, "init: --repo only narrows --check");
      }
      const taskLength = parseEnum(stringFlag(parsed.value, "--task-length"), "--task-length", [
        "short",
        "long",
      ] as const);
      if (!taskLength.ok) return failCommand(context, `init: ${taskLength.error}`);
      const testPolicy = parseEnum(stringFlag(parsed.value, "--test-policy"), "--test-policy", [
        "scoped-only",
        "full-ok",
      ] as const);
      if (!testPolicy.ok) return failCommand(context, `init: ${testPolicy.error}`);

      const options: InitOptions = {
        ...(stringFlag(parsed.value, "--crew-size") !== undefined
          ? { crewSize: stringFlag(parsed.value, "--crew-size") as string }
          : {}),
        ...(taskLength.value !== undefined ? { taskLength: taskLength.value } : {}),
        overnight: booleanFlag(parsed.value, "--overnight"),
        ...(testPolicy.value !== undefined ? { testPolicy: testPolicy.value } : {}),
        baseRef: stringFlag(parsed.value, "--base-ref") ?? "head",
        ...(booleanFlag(parsed.value, "--sign")
          ? { sign: true }
          : booleanFlag(parsed.value, "--no-sign")
            ? { sign: false }
            : {}),
        ...(booleanFlag(parsed.value, "--session-url") ? { sessionUrl: true } : {}),
      };

      const root = context.projectRoot;
      const detected = detect(fsAccess(root));
      const crewPath = crewfilePath(root);
      const existingRaw = readRaw(crewPath);
      const derived = deriveCrewJson(detected, existingRaw, options);

      const claudePath = findClaudeMd(root);
      const claudeText = existsSync(claudePath) ? readFileSync(claudePath, "utf8") : null;
      const hasBlock = claudeText !== null && claudeText.includes(BLOCK_BEGIN);
      const installed = installedVersion() !== "";

      const reserved = existingRaw
        ? Object.keys(existingRaw).filter((k) =>
            (RESERVED_KEYS as readonly string[]).includes(k),
          )
        : [];
      const unknown = existingRaw ? parseCrewFile(existingRaw).unknownKeys : [];
      const pendingDetected = PENDING_KEYS.filter((k) => {
        const v = detected[k];
        return Array.isArray(v) && v.length > 0;
      });

      if (check) {
        let missing = false;
        const mark = (ok: boolean, okText: string, missingText: string): string => {
          if (!ok) missing = true;
          return ok ? `${green("✓")} ${okText}` : `${red("✗")} ${missingText}`;
        };
        if (!repoOnly) {
          context.log(bold("machine"));
          context.log(
            `  ${mark(installed, `hooks installed (build ${installedVersion()})`, "hooks not installed — run `bun install.ts`")}`,
          );
          context.log(
            `  ${mark(shimInstalled(), "`crew` shim on ~/.local/bin", "no `crew` shim — `bun install.ts` writes it")}`,
          );
        }
        context.log(bold("repo"));
        context.log(
          `  ${mark(existingRaw !== null, `${crewPath} present`, `${crewPath} missing — \`crew init\` writes it`)}`,
        );
        context.log(
          `  ${mark(hasBlock, `CLAUDE.md block present (${claudePath})`, `no crew block in ${claudePath}`)}`,
        );
        context.log(bold("derived crew.json"));
        for (const line of JSON.stringify(derived, null, 2).split("\n")) {
          context.log(`  ${dim(line)}`);
        }
        if (pendingDetected.length > 0) {
          context.log(
            `  ${yellow("◌")} detected but not written (consumer pending, INIT_PLAN P4): ` +
              pendingDetected.map((k) => `${k}=${JSON.stringify(detected[k])}`).join(", "),
          );
        }
        if (reserved.length > 0) {
          context.log(`  ${yellow("◌")} reserved keys present, nothing reads them yet: ${reserved.join(", ")}`);
        }
        if (unknown.length > 0) {
          context.log(`  ${yellow("◌")} unknown keys, nothing reads them: ${unknown.join(", ")}`);
        }
        if (missing) context.fail();
        return;
      }

      // ---- write mode
      mkdirSync(`${root}/.claude`, { recursive: true });
      writeFileSync(crewPath, `${JSON.stringify(derived, null, 2)}\n`);
      clearCrewfileCache();
      context.log(
        `${green("✓")} ${cyan(crewPath)} ${dim(existingRaw === null ? "written" : "updated — hand-added keys kept")}`,
      );

      if (!booleanFlag(parsed.value, "--no-claude-md")) {
        if (markersDamaged(claudeText)) {
          failCommand(
            context,
            `init: ${claudePath} has one crew marker without its pair — repair it, then re-run`,
          );
        } else {
          const written = parseCrewFile(derived);
          const policy = typeof derived["testPolicy"] === "string" ? derived["testPolicy"] : "";
          const block = renderBlock({
            crewSize: crewSizeLabel(options.crewSize),
            isGit: context.isGit,
            baseRef: options.baseRef,
            testScoped: written.checks.testScoped,
            testPolicy: policy,
            sign: written.commit.sign,
            sessionUrl: written.commit.sessionUrl,
          });
          writeFileSync(claudePath, applyBlock(claudeText, block));
          context.log(
            `${green("✓")} ${cyan(claudePath)} ${dim(hasBlock ? "block replaced in place" : "block appended")}`,
          );
        }
      }

      if (context.isGit) {
        const settingsPath = `${root}/.claude/settings.json`;
        const rawText = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
        const merged = mergeSettings(rawText, options.baseRef);
        if (!merged.ok) {
          failCommand(context, `init: ${settingsPath}: ${merged.error}`);
        } else {
          writeFileSync(settingsPath, merged.text);
          context.log(
            `${green("✓")} ${cyan(settingsPath)} ${dim(`worktree.baseRef = "${options.baseRef}"`)}`,
          );
        }
      }

      if (pendingDetected.length > 0) {
        context.log(
          dim(`  detected but not written (consumer pending): ${pendingDetected.join(", ")}`),
        );
      }
      if (!installed) {
        context.log(`${yellow("!")} hooks are not installed on this machine — run \`bun install.ts\``);
      }
      context.log(dim("  re-run `crew init` whenever; it re-derives and keeps hand edits."));
    },
  };
}
