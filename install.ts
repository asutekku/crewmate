/**
 * Installs these hooks user-wide: copies the scripts to
 * `~/.claude/agent-presence/bin/` and registers them in `~/.claude/settings.json`.
 *
 *   bun .claude/hooks/presence/install.ts          # install or update scripts
 *   bun .claude/hooks/presence/install.ts --force  # re-register hooks too
 *   bun .claude/hooks/presence/install.ts --remove # uninstall
 *
 * WHY USER-WIDE AND NOT PER-PROJECT: hooks are read from the working tree, so a
 * git worktree pinned to an older commit never sees a project-level hook — and
 * worktrees are exactly where parallel agents run. Installing once outside every
 * checkout is what lets a worktree agent join the same roster as the main tree.
 *
 * The scripts are COPIED rather than referenced in place so that deleting or
 * moving a repo cannot break every other project's hooks. Re-run after changing
 * them; the repo copy is the source of truth.
 */

import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_IDS } from "./core/features.ts";

const HOME = homedir().replace(/\\/g, "/");
const BIN = `${HOME}/.claude/agent-presence/bin`;
const SETTINGS = `${HOME}/.claude/settings.json`;
// `fileURLToPath`, not `URL.pathname`: pathname is percent-ENCODED, so a home
// directory like `C:/Users/John Doe` arrives as `John%20Doe` and every read
// under it fails. Decoding is not optional on a path that came from a URL.
const HERE = `${dirname(fileURLToPath(import.meta.url)).replace(/\\/g, "/")}/`;

/**
 * Every module to deploy, as a path RELATIVE to this directory.
 *
 * DISCOVERED, NOT LISTED: a hardcoded list silently drops a newly added module,
 * and the failure lands at hook-run time as "Cannot find module" rather than at
 * install time. `test/` is skipped wholesale.
 */
async function scriptNames(): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  const walk = (rel: string): string[] =>
    readdirSync(`${HERE}${rel}`, { withFileTypes: true }).flatMap((e) => {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) return e.name === "test" ? [] : walk(path);
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) return [];
      return path === "install.ts" ? [] : [path];
    });
  return walk("").sort();
}

/**
 * A fingerprint of the installed code, so a session can report which version it
 * is running. Content-hashed rather than hand-bumped: a version number someone
 * must remember to raise is a version number that lies.
 */
async function codeVersion(names: readonly string[]): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for (const n of names) h.update(await Bun.file(`${HERE}${n}`).text());
  return h.digest("hex").slice(0, 8);
}

/**
 * What is installed, beside the code that is installed.
 *
 * `featureSet` is listed explicitly rather than derived from the file list: a
 * script can exist and its verb be unregistered. The list is what the build
 * CLAIMS to provide, and it is a claim someone must edit deliberately.
 */
function manifest(version: string, scripts: readonly string[]): Record<string, unknown> {
  return {
    installedAt: Date.now(),
    // The REPOSITORY revision, so an installed copy traces back to source. The
    // content hash answered a different question ("are these bytes the ones I
    // shipped?") and was labelled as if it answered this one -- fine until
    // somebody tries to find the commit a build came from. Empty outside a git
    // checkout, which is a real case: install.ts runs from wherever the source
    // happens to be.
    sourceRevision: headRevision(),
    // The BYTES, kept under its own name now that sourceRevision means what it
    // says. Still the value a session reports, still content-hashed.
    contentHash: version,
    schemaVersion: SCHEMA_VERSION,
    // Bumped when the MEANING of a feature name changes, so a consumer can tell
    // "this build lists injection-suppression" from "this build lists it and
    // means what you think". A list alone cannot express that.
    featureSetVersion: FEATURE_SET_VERSION,
    featureSet: FEATURE_SET,
    scripts: [...scripts],
  };
}

/** The commit this was installed from; empty outside a checkout. */
function headRevision(): string {
  try {
    const out = Bun.spawnSync(["git", "-C", HERE, "rev-parse", "HEAD"]);
    return out.success ? new TextDecoder().decode(out.stdout).trim() : "";
  } catch {
    return "";
  }
}

/** Raised when a name in FEATURE_SET starts meaning something different. */
const FEATURE_SET_VERSION = 2;

/**
 * Bumped by hand when the store's shape changes in a way a reader must know
 * about. Deliberately NOT content-hashed: this answers "can an older session
 * still read this db", which is a judgement, not a diff.
 */
const SCHEMA_VERSION = 3;

/**
 * Capabilities this build claims to provide, for exposure telemetry to compare
 * against. A feature absent here is one no session can be said to have been
 * given, however much of its code shipped.
 */
const FEATURE_SET = FEATURE_IDS;

interface HookEntry {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<{ readonly command?: string }>;
}

/**
 * EXEC FORM (`args` present), not a shell string. The shell form `bun ${BIN}/x.ts`
 * is unquoted, so a home directory with spaces tokenizes into two arguments and
 * EVERY hook fails on EVERY firing. `bun` resolves to a real executable on all
 * three platforms, which is what exec form requires on Windows.
 */
function entry(script: string, extra: Record<string, unknown> = {}): unknown {
  return {
    hooks: [
      // Every registered script is a hook entry point, so the folder is added
      // here rather than repeated at thirteen call sites where one could drift.
      { type: "command", command: "bun", args: [`${BIN}/hooks/${script}`], timeout: 15, ...extra },
    ],
  };
}

const REGISTRATIONS: ReadonlyArray<readonly [string, unknown]> = [
  ["SessionStart", entry("session-start.ts", { statusMessage: "Checking for other agents…" })],
  ["UserPromptSubmit", entry("prompt-submit.ts")],
  ["PreToolUse", { matcher: "Edit|Write|MultiEdit", ...(entry("pre-edit.ts") as object) }],
  // A SECOND PreToolUse, under a different matcher. Separate from `pre-edit`
  // because it answers a different question and must not pay that hook's db
  // read: this one only inspects the command string.
  ["PreToolUse", { matcher: "Bash", ...(entry("pre-bash.ts") as object) }],
  // Mid-turn delivery. Fires after every batch of tool calls, so the script's
  // own fast path (see tool-batch.ts) is what keeps it affordable.
  ["PostToolBatch", entry("tool-batch.ts")],
  // Commits, for the work board. Matched to Bash so an Edit never pays for it,
  // and it emits nothing back — the agent knows it just committed.
  ["PostToolUse", { matcher: "Bash", ...(entry("commit-landed.ts") as object) }],
  ["Stop", entry("turn-end.ts")],
  // Runs INSTEAD OF Stop when a turn dies, which is why it cannot be folded in.
  ["StopFailure", entry("turn-failed.ts")],
  // Only the notification types that say why a session is stuck.
  [
    "Notification",
    { matcher: "permission_prompt", ...(entry("notify.ts") as object) },
  ],
  ["SubagentStart", entry("subagent-start.ts")],
  // Closes the minion row. Reads no context back to the subagent — it is on the
  // way out — so it is pure bookkeeping for the operator's roster.
  ["SubagentStop", entry("subagent-stop.ts")],
  ["PostCompact", entry("compacted.ts")],
  ["CwdChanged", entry("cwd-changed.ts")],
  ["TaskCreated", entry("task-changed.ts")],
  ["TaskCompleted", entry("task-changed.ts")],
  // 1.5 s total budget for all SessionEnd hooks, so this one is kept tight.
  ["SessionEnd", entry("session-end.ts", { timeout: 5 })],
];

/**
 * Identifies OUR hook entries by checking both `args` and `command`: under
 * EXEC FORM the path lives in `args`, not `command`. Both fields must be checked
 * so either form is matched.
 */
function isOurs(e: unknown): boolean {
  const hooks = (e as HookEntry | null)?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    const args = Array.isArray((h as { args?: unknown }).args)
      ? ((h as { args: unknown[] }).args as unknown[]).join(" ")
      : "";
    return `${h.command ?? ""} ${args}`.includes("agent-presence/bin");
  });
}

async function readSettings(): Promise<Record<string, unknown>> {
  const f = Bun.file(SETTINGS);
  if (!(await f.exists())) return {};
  try {
    return JSON.parse(await f.text()) as Record<string, unknown>;
  } catch {
    console.error(`${SETTINGS} is not valid JSON — fix it before installing.`);
    process.exit(1);
  }
}

async function writeSettings(s: Record<string, unknown>, backup: string | null): Promise<void> {
  if (backup !== null) await Bun.write(`${SETTINGS}.bak-presence`, backup);
  await Bun.write(SETTINGS, `${JSON.stringify(s, null, 2)}\n`);
}

async function copyScripts(): Promise<void> {
  const scripts = await scriptNames();
  rmSync(BIN, { recursive: true, force: true });
  mkdirSync(BIN, { recursive: true });
  for (const s of scripts) {
    await Bun.write(`${BIN}/${s}`, Bun.file(`${HERE}${s}`));
  }
  const version = await codeVersion(scripts);
  await Bun.write(`${BIN}/VERSION`, version);
  await Bun.write(`${BIN}/manifest.json`, JSON.stringify(manifest(version, scripts), null, 1));
  console.log(`Copied ${scripts.length} scripts to ${BIN} (build ${version})`);
  console.log(`  ${scripts.join(", ")}`);
}

async function install(force: boolean): Promise<void> {
  await copyScripts();
  const settings = await readSettings();
  const raw = JSON.stringify(settings);
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;

  const script = (reg: unknown): string => {
    const h = (reg as { hooks?: Array<{ command?: string; args?: string[] }> }).hooks?.[0];
    return (h?.args?.[0] ?? h?.command ?? "").trim();
  };
  const installed = new Set(
    Object.values(hooks).flatMap((arr) =>
      (Array.isArray(arr) ? arr : []).filter((e) => isOurs(e)).map(script),
    ),
  );
  const missing = REGISTRATIONS.filter(([, reg]) => !installed.has(script(reg))).map(
    ([event]) => event,
  );
  if (raw.includes("agent-presence/bin") && !force && missing.length === 0) {
    console.log("Hooks already registered — scripts updated. Use --force to re-register.");
    return;
  }
  if (missing.length > 0 && !force) {
    console.log(`Registering ${missing.length} new event(s): ${missing.join(", ")}`);
  }
  const cleared = new Set<string>();
  for (const [event, reg] of REGISTRATIONS) {
    if (!cleared.has(event)) {
      hooks[event] = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isOurs(e));
      cleared.add(event);
    }
    hooks[event] = [...(hooks[event] as unknown[]), reg];
  }
  settings["hooks"] = hooks;
  await writeSettings(settings, raw === "{}" ? null : await Bun.file(SETTINGS).text());
  console.log(`Registered in ${SETTINGS} (backup: ${SETTINGS}.bak-presence)`);
  console.log("Restart your sessions for the hooks to take effect.");
}

async function remove(): Promise<void> {
  const settings = await readSettings();
  const before = await Bun.file(SETTINGS).text();
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const kept = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => {
      if (!isOurs(e)) return true;
      removed++;
      return false;
    });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) settings["hooks"] = hooks;
  else delete settings["hooks"];
  await writeSettings(settings, before);
  console.log(`Removed ${removed} hook registration(s). Scripts left in ${BIN}.`);
}

const args = new Set(Bun.argv.slice(2));
if (args.has("--remove")) await remove();
else await install(args.has("--force"));
