/**
 * PreToolUse(Bash): refuse a loop that polls for work the harness announces.
 *
 * DENY, NOT WARN — a warning arrives beside a command that then runs for ten
 * minutes, and the reason names the replacement. NARROW BY CONSTRUCTION: a
 * loop, a wait and a task-output path must ALL appear, so polling something
 * external stays allowed. See docs/design-notes.md, "The poll-loop guard", and
 * `test/prebash.test.ts` for the cases held open on purpose.
 */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { loadCrewFile, type CrewFile } from "../core/crewfile.ts";
import { resolveProject } from "../core/repo.ts";
import { emit, readPayload } from "../core/shared.ts";
import { lineageName, withStore } from "../core/store.ts";

/** A shell loop. `until` counts: `until [ -s f ]; do sleep 5; done` is the same bug. */
const LOOP = /\b(?:for|while|until)\b/;

/** Something that waits. `timeout` alone is not a wait -- it BOUNDS one. */
const WAIT = /\bsleep\s+[\d.]/;

/**
 * A path under the harness's own task directory.
 *
 * This is the whole discriminator. `tasks/<id>.output` is written by the
 * background-task machinery, which is exactly the machinery that also sends the
 * notification -- so a loop watching one is a loop waiting for an event it has
 * already been promised.
 */
const TASK_OUTPUT = /tasks[/\\][A-Za-z0-9_-]+\.output/;

export interface Verdict {
  readonly deny: boolean;
  readonly reason: string;
}

/**
 * Strips regions where a poll loop is DATA rather than something the shell runs
 * — a heredoc or a `bun -e` script quoting the pattern.
 *
 * Deliberately crude, and errs toward ALLOWING: a missed poll costs ten
 * minutes, a false denial teaches agents to route around the hook.
 */
function executableParts(command: string): string {
  return (
    command
      // Heredoc bodies: `<<'J' ... J`, quoted or not.
      .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, " ")
      // An inline script passed to an interpreter: `-e '...'` / `-e "..."`.
      // NOT `-c`: `sh -c '<poll>'` is a shell that really will wait, and
      // `test/prebash.test.ts` pins that it stays denied.
      .replace(/-e\s+(['"])[\s\S]*?\1/g, " ")
      // A comment is data. Stripped from `#` to end of line, and only where `#`
      // opens a word -- `$#`, `a#b` and a `#` inside a path are not comments.
      .replace(/(^|\s)#[^\n]*/g, "$1")
      // `echo "<poll>" > poll.sh` WRITES the pattern; it does not run it. The
      // heredoc form of exactly this was already allowed, and an agent that
      // reaches for `echo` instead should not get a different answer.
      .replace(/\becho\s+(['"])[\s\S]*?\1/g, " ")
  );
}

export function checkCommand(command: string): Verdict {
  const runnable = executableParts(command);
  const polls = LOOP.test(runnable) && WAIT.test(runnable) && TASK_OUTPUT.test(runnable);
  if (!polls) return { deny: false, reason: "" };
  return {
    deny: true,
    reason:
      "This polls a background task's output file, and the harness already tells you when " +
      "that task finishes — a <task-notification> arrives on its own. Launch the agent, do " +
      "other work, and handle the result when it lands.\n\n" +
      "It is also unsound: `-s` tests NON-EMPTY, not finished, so a task that streams output " +
      "trips the check on its first byte and the `cat` reads a PARTIAL file — which looks " +
      "exactly like a complete short answer.\n\n" +
      "If you must block on something the harness cannot see (CI, a deploy, a port opening), " +
      "use Monitor with an until-loop instead of a sleep chain.",
  };
}

/**
 * WARN, NOT DENY — the poll guard denies because the denied thing is strictly
 * wasteful, where a full-suite run is sometimes right (a cross-cutting change
 * before a commit). Facts plus the alternative, and the agent decides.
 */
export function checkTestPolicy(command: string, crew: CrewFile): string {
  if (crew.testPolicy !== "scoped-only") return "";
  const test = crew.checks.test.trim();
  if (test === "") return "";
  const runnable = executableParts(command);
  const escaped = test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // The command, standing alone in its statement: at a statement boundary, and
  // followed only by flags until the next one. A non-flag token after it is a
  // path — that IS the scoped form, and the warning must not fire on it.
  const statement = new RegExp(`(?:^|[;&|(\\n])\\s*${escaped}(?=\\s|$)([^;&|\\n]*)`, "g");
  for (const match of runnable.matchAll(statement)) {
    const rest = (match[1] ?? "").trim();
    // A bare integer is a flag's VALUE (`--timeout 10000`), not a path; every
    // real scope argument has a name. Numbers must not read as scoped.
    const scoped = rest
      .split(/\s+/)
      .some((token) => token !== "" && !token.startsWith("-") && !/^\d+$/.test(token));
    if (!scoped) {
      const scopedForm = crew.checks.testScoped !== "" ? crew.checks.testScoped : `${test} <path>`;
      return (
        `This runs the full test suite (\`${test}\`), and this repo's crew.json sets ` +
        `\`testPolicy: scoped-only\`. A scoped run covers a self-contained change: ` +
        `\`${scopedForm}\` with the files you touched. Full runs cost minutes, and other ` +
        `agents' in-flight edits can make unrelated failures look like yours. If the ` +
        `change is genuinely cross-cutting, the full run is still yours to make.`
      );
    }
  }
  return "";
}

/** A `git commit` anywhere in the command, the same cheap filter `commit-landed` uses. */
const GIT_COMMIT = /\bgit\b[\s\S]*?\bcommit\b/;

/** `-m "…"`, `-m '…'`, and the `-m "$(cat <<'EOF' … EOF)"` form agents favour. */
const DASH_M = /-m\s+(?:"((?:[^"\\]|\\[\s\S])*)"|'([^']*)')/g;

/** `-F <path>` / `--file=<path>`, quoted or bare. `-` is stdin, not a path. */
const DASH_F = /(?:-F|--file)[\s=]+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/;

/**
 * Does this same command WRITE the file it commits from?
 *
 * `printf … > msg && git commit -F msg` is the form this repo's own rules
 * teach, and PreToolUse runs BEFORE the write — so the bytes on disk are the
 * PREVIOUS commit's message. Measured 2026-08-08: a correctly signed commit
 * was warned about, because the file still held the unsigned test before it.
 * Matched on the basename, since the redirect and the flag rarely spell the
 * path the same way.
 */
function writesItsOwnMessage(command: string, path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  if (base === "") return false;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A redirect into it, or a heredoc/tee naming it. Either way the content
  // this hook can see is not the content git will read.
  return new RegExp(`(?:>>?\\s*|\\btee\\s+(?:-a\\s+)?)["']?[^\\s"';&|]*${escaped}`).test(command);
}

/**
 * The commit message, from wherever this command keeps it.
 *
 * Returns "" when the message is genuinely unreadable — `-F -` reads stdin,
 * `--amend` with no flag reuses the old message, and a file this command has
 * yet to write holds someone else's text. UNREADABLE MUST NOT WARN: a hook
 * that fires on commits it never saw is one an agent learns to route around.
 */
export function commitMessage(command: string, readFile: (p: string) => string): string {
  const file = DASH_F.exec(command);
  if (file) {
    const path = file[1] ?? file[2] ?? file[3] ?? "";
    if (path === "" || path === "-") return "";
    if (writesItsOwnMessage(command, path)) return "";
    try {
      return readFile(path);
    } catch {
      // Not written yet, or outside this tree. Silence beats a guess.
      return "";
    }
  }
  // Every `-m`, because git concatenates repeated ones into paragraphs and the
  // trailer is conventionally in the last.
  const parts = [...command.matchAll(DASH_M)].map((m) => m[1] ?? m[2] ?? "");
  return parts.join("\n\n");
}

/** `Co-Authored-By: Aoi (Claude Opus 5) <…>` -> `aoi`. "" when unsigned. */
function trailerName(message: string): string {
  const lines = message.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*Co-Authored-By:\s*(.+?)\s*(?:\(|<|$)/i.exec(lines[i] ?? "");
    if (m) return (m[1] ?? "").trim().toLowerCase();
  }
  return "";
}

/**
 * DENY a commit whose message this hook READ and found wrong.
 *
 * Deny rather than warn because the artifact is permanent and the fix is
 * free — an unsigned commit is only repairable by rewriting history, where a
 * denied one costs the agent one retry. The poll guard reasons the same way.
 *
 * WHAT MAKES DENYING SAFE HERE is that an unreadable message yields "" from
 * `commitMessage` and never reaches this function, so the strict answer is
 * only ever given about text actually seen. `expected` is the agent's own
 * display name, already resolved by the caller.
 */
export function checkCommitSignature(
  command: string,
  crew: CrewFile,
  expected: string,
  message: string,
): Verdict {
  const allow = { deny: false, reason: "" };
  if (!crew.commit.sign || expected === "") return allow;
  if (!GIT_COMMIT.test(executableParts(command))) return allow;
  if (message.trim() === "") return allow;

  if (!crew.commit.sessionUrl && /^\s*Claude-Session:/im.test(message)) {
    return {
      deny: true,
      reason:
        "This commit carries a `Claude-Session:` trailer, and this repo's crew.json sets" +
        " `commit.sessionUrl: false`. The link is permanent and points at a private" +
        " transcript, which does not belong in a public history. Drop the line and commit again.",
    };
  }

  const signed = trailerName(message);
  if (signed === "") {
    return {
      deny: true,
      reason:
        `This commit does not say which agent wrote it. You are ${expected} — add` +
        ` \`Co-Authored-By: ${expected} (<your model>) <noreply@anthropic.com>\` to the message` +
        ` and commit again. \`git log\` outlives this session, and a bare model name cannot` +
        ` tell you apart from the other agents in this tree.`,
    };
  }
  // Compared on the GIVEN NAME only: the model in parentheses is the agent's to
  // state and a disciple's suffix is prose this must not parse.
  const given = signed.split(/[\s,]+/)[0] ?? "";
  if (given !== "" && given !== expected.split(/[\s,]+/)[0]?.toLowerCase()) {
    return {
      deny: true,
      reason:
        `This commit is signed \`${signed}\`, but you are ${expected}. A trailer naming another` +
        ` agent points \`git blame\` at the wrong conversation — sign your own name, or drop the` +
        ` trailer if this really is someone else's work you are landing.`,
    };
  }
  return allow;
}

/** The one shape that stops a tool call. Both guards here speak it. */
function refuse(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

async function main(): Promise<void> {
  const payload = await readPayload();
  const command = payload?.tool_input?.command ?? "";
  if (command === "") return;

  const verdict = checkCommand(command);
  if (verdict.deny) return refuse(verdict.reason);

  const cwd = payload?.cwd;
  if (!cwd) return;
  const project = resolveProject(cwd);
  const crew = loadCrewFile(project.root);
  const warning = checkTestPolicy(command, crew);
  if (warning !== "") emit("PreToolUse", warning, "presence: crew.json testPolicy is scoped-only");

  // Guarded by the cheap regex FIRST: the db open and the message read must not
  // sit on every `ls` this hook already sees.
  if (!crew.commit.sign || !GIT_COMMIT.test(command)) return;
  const message = commitMessage(command, (p) =>
    readFileSync(isAbsolute(p) ? p : `${cwd}/${p}`, "utf8"),
  );
  if (message.trim() === "") return;
  const sessionId = payload?.session_id;
  if (!sessionId) return;
  const me = withStore(project.dbPath, (store) => {
    const self = store.findBySession(sessionId);
    return self ? lineageName(self) : "";
  });
  const signature = checkCommitSignature(command, crew, me, message);
  if (signature.deny) refuse(signature.reason);
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A guard that crashes must not block a shell; a
  // silent catch would turn a programmer error into a hook that exits 0 having
  // checked nothing, which is indistinguishable from "this command is fine".
  console.error(`[presence] ${import.meta.file} failed:`, err);
}
