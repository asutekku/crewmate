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

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir().replace(/\\/g, "/");
const BIN = `${HOME}/.claude/agent-presence/bin`;
const SETTINGS = `${HOME}/.claude/settings.json`;
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Everything except this installer, which has no business running as a hook.
 *
 * DISCOVERED, NOT LISTED: a hardcoded list silently drops a newly added module,
 * and the failure lands at hook-run time as "Cannot find module" rather than at
 * install time — which is exactly how `colour.ts` shipped broken once.
 */
async function scriptNames(): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && f !== "install.ts" && !f.endsWith(".test.ts"))
    .sort();
}

/**
 * A fingerprint of the installed code, so a session can report which version it
 * is running.
 *
 * Sessions load these scripts when they start and keep that copy until they are
 * restarted, so after an install the roster mixes old and new behaviour with no
 * way to tell which is which. The user had to infer it from the SHAPE of the
 * output ("some agents are running on older hooks i believe"); this makes it a
 * fact the roster states.
 *
 * Content-hashed rather than a hand-bumped constant: a version number someone
 * must remember to raise is a version number that lies.
 */
async function codeVersion(names: readonly string[]): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for (const n of names) h.update(await Bun.file(`${HERE}${n}`).text());
  return h.digest("hex").slice(0, 8);
}

interface HookEntry {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<{ readonly command?: string }>;
}

/**
 * `bun` from PATH rather than an absolute binary: the same settings file has to
 * work on Linux and macOS, where a Windows `bun.exe` path does not exist.
 */
function entry(script: string, extra: Record<string, unknown> = {}): unknown {
  return {
    hooks: [{ type: "command", command: `bun ${BIN}/${script}`, timeout: 15, ...extra }],
  };
}

const REGISTRATIONS: ReadonlyArray<readonly [string, unknown]> = [
  ["SessionStart", entry("session-start.ts", { statusMessage: "Checking for other agents…" })],
  ["UserPromptSubmit", entry("prompt-submit.ts")],
  ["PreToolUse", { matcher: "Edit|Write|MultiEdit", ...(entry("pre-edit.ts") as object) }],
  // Mid-turn delivery. Fires after every batch of tool calls, so the script's
  // own fast path (see tool-batch.ts) is what keeps it affordable.
  ["PostToolBatch", entry("tool-batch.ts")],
  ["Stop", entry("turn-end.ts")],
  // Runs INSTEAD OF Stop when a turn dies, which is why it cannot be folded in.
  ["StopFailure", entry("turn-failed.ts")],
  // Only the notification types that say why a session is stuck.
  [
    "Notification",
    { matcher: "permission_prompt", ...(entry("notify.ts") as object) },
  ],
  ["SubagentStart", entry("subagent-start.ts")],
  ["PostCompact", entry("compacted.ts")],
  ["CwdChanged", entry("cwd-changed.ts")],
  ["TaskCreated", entry("task-changed.ts")],
  ["TaskCompleted", entry("task-changed.ts")],
  // 1.5 s total budget for all SessionEnd hooks, so this one is kept tight.
  ["SessionEnd", entry("session-end.ts", { timeout: 5 })],
];

/** Identifies OUR hook entries, so removal never touches anyone else's. */
function isOurs(e: unknown): boolean {
  const hooks = (e as HookEntry | null)?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => (h.command ?? "").includes("agent-presence/bin"));
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
  mkdirSync(BIN, { recursive: true });
  const scripts = await scriptNames();
  for (const s of scripts) {
    await Bun.write(`${BIN}/${s}`, Bun.file(`${HERE}${s}`));
  }
  // Stamped beside the scripts, so a running session can report which build it
  // loaded. Sessions read these files at start and keep that copy until they
  // restart, so after an install the roster silently mixes versions.
  const version = await codeVersion(scripts);
  await Bun.write(`${BIN}/VERSION`, version);
  // Named, not just counted: a missing module is invisible in a bare number and
  // only surfaces when a hook fails to import it.
  console.log(`Copied ${scripts.length} scripts to ${BIN} (build ${version})`);
  console.log(`  ${scripts.join(", ")}`);
}

async function install(force: boolean): Promise<void> {
  await copyScripts();
  const settings = await readSettings();
  const raw = JSON.stringify(settings);
  const hooks = (settings["hooks"] ?? {}) as Record<string, unknown[]>;

  if (raw.includes("agent-presence/bin") && !force) {
    console.log("Hooks already registered — scripts updated. Use --force to re-register.");
    return;
  }
  for (const [event, reg] of REGISTRATIONS) {
    const existing = (Array.isArray(hooks[event]) ? hooks[event] : []).filter((e) => !isOurs(e));
    hooks[event] = [...existing, reg];
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
    // Drop the event entirely when it held only our entries, rather than
    // leaving an empty array behind.
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
