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

const HOME = homedir().replace(/\\/g, "/");
const BIN = `${HOME}/.claude/agent-presence/bin`;
const SETTINGS = `${HOME}/.claude/settings.json`;
// `fileURLToPath`, not `URL.pathname`: pathname is percent-ENCODED, so a home
// directory like `C:/Users/John Doe` arrives as `John%20Doe` and every read
// under it fails. Decoding is not optional on a path that came from a URL.
const HERE = `${dirname(fileURLToPath(import.meta.url)).replace(/\\/g, "/")}/`;

/**
 * Every module to deploy, as a path RELATIVE to this directory — so `core/…`
 * and `hooks/…` keep their folders in `bin/` and the relative imports that ship
 * resolve exactly as they do in source.
 *
 * DISCOVERED, NOT LISTED: a hardcoded list silently drops a newly added module,
 * and the failure lands at hook-run time as "Cannot find module" rather than at
 * install time — which is exactly how `colour.ts` shipped broken once.
 *
 * `test/` is skipped wholesale: tests are not hooks, and copying them would put
 * `bun:test` imports in the deployed tree.
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
 *
 * EXEC FORM (`args` present), not a shell string. HOOKS.MD: with `args` set,
 * "each element is one argument exactly as written" and "no shell tokenization
 * happens on any platform". The shell form `bun ${BIN}/x.ts` is unquoted, so a
 * home directory containing a space — `C:/Users/John Doe/…` — tokenizes into
 * two arguments and EVERY hook fails on EVERY firing. Because the hooks fail
 * open, such a user sees nothing at all and believes the tool is installed.
 * `bun` resolves to a real executable on all three platforms, which is what
 * exec form requires on Windows.
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
 * Identifies OUR hook entries, so removal never touches anyone else's: ours iff
 * the path points into our bin, wherever in the entry it appears.
 *
 * Under EXEC FORM the path lives in `args` and `command` is just `bun`, so
 * checking `command` alone stopped recognising our own registrations the moment
 * exec form shipped — leaving `--remove` unable to clean up and re-registration
 * duplicating entries. Both fields are checked so either form is matched.
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
  // Replaced, not merged: a module that moved or was deleted would otherwise
  // linger in `bin/` forever. After the source was split into core/ and hooks/,
  // the previous flat copies sat beside the new ones — same names, older code,
  // and nothing to say which a reader was looking at.
  rmSync(BIN, { recursive: true, force: true });
  mkdirSync(BIN, { recursive: true });
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

  // Compared as an EVENT SET, not as "is the string present anywhere". Any
  // registration at all used to satisfy the check, so an update that ADDED an
  // event copied the new script and never registered it — while `VERSION`
  // advanced, so the roster reported this machine as current. The documented
  // update command was the broken path.
  // Compared per SCRIPT, not per event. An event can hold several of our
  // registrations, so "does PreToolUse have one of ours" answers yes while a
  // newly added PreToolUse(Bash) guard is still absent -- the same class of
  // false-positive as the event-set bug above, one level down.
  // The SCRIPT PATH, which lives in `args` -- `command` is the interpreter and
  // is `"bun"` for every one of ours, so comparing on it makes all fifteen
  // registrations look identical and any newly added hook look installed.
  // (Written that way first; it silently registered nothing.)
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
  // ACCUMULATE PER EVENT, never assign. One event can carry SEVERAL of our
  // registrations under different matchers -- `PreToolUse` has both the
  // Edit|Write guard and the Bash one -- and assigning inside the loop made the
  // last entry for an event silently discard every earlier one. Clearing our
  // own entries once, before the loop, keeps the reinstall idempotent without
  // dropping siblings.
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
