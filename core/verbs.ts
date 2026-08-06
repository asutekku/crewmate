/**
 * Every command the CLI answers to, in one table.
 *
 * The table is the source: `usage()` renders it and `verbs.test.ts` asserts
 * every `case` label in cli.ts appears here. Per-verb usage lives here too,
 * read through `usageFor(verb)`. See docs/design-notes.md, "The verb table".
 */

/**
 * How an agent is told to invoke this tool, in ONE place.
 *
 * Hints read `${CLI} note "..."` so a rename touches one line.
 * `verbs.test.ts` asserts no bare `cli.ts` literal comes back.
 */
export const CLI = "crew";

/** Which section of the help a verb belongs under. Order here is display order. */
export type VerbGroup = "presence" | "work" | "diary" | "memory" | "identity";

/**
 * Who a verb is for. Orthogonal to `VerbGroup`, which says what it is ABOUT.
 *
 * - `agent`     reached from an injection, a hook, or peer coordination
 * - `human`     an operator surface; built for a terminal window
 * - `shared`    symmetric — both parties do the same thing (`msg`, `say`)
 * - `oversight` asymmetric — agents write it, the operator audits it
 */
export type VerbAudience = "agent" | "human" | "shared" | "oversight";

export interface Verb {
  /** The literal typed at the CLI -- must match a `case` label in cli.ts. */
  readonly verb: string;
  /** Argument spec as shown in help, e.g. `<name> "<text>" [--from <name>]`. */
  readonly args: string;
  /** One line, lowercase, no trailing period. Says what it DOES, not what it is. */
  readonly blurb: string;
  readonly group: VerbGroup;
  /**
   * Alternate spellings dispatching to the same handler (`name` for `call-me`).
   * Listed so the drift test recognises them, but never shown -- help offering
   * two ways to type one thing is help that has to be read twice.
   */
  readonly aliases?: readonly string[];
  /**
   * True when the verb exists but should not be advertised. Nothing sets this
   * today; it is here so a future internal verb has somewhere to go OTHER than
   * being quietly missing from the table, which is the failure this file exists
   * to prevent.
   */
  readonly hidden?: boolean;
  /** False when the command records its own richer feature-use event. */
  readonly trackUse?: boolean;
  /**
   * Who this verb is FOR — see `docs/audiences.md`.
   *
   * NOT A PERMISSION MODEL: nothing is gated by caller. It records who is TOLD
   * the verb exists. REQUIRED, so the audience tables are generated rather than
   * hand-maintained — every hand-kept count in this repo has drifted.
   */
  readonly audience: VerbAudience;
}

export const VERB_GROUPS: ReadonlyArray<{ group: VerbGroup; title: string }> = [
  { group: "presence", title: "who is here" },
  { group: "work", title: "what you are doing" },
  { group: "diary", title: "findings that outlive the session" },
  { group: "memory", title: "what you remember about the user" },
  { group: "identity", title: "names and roles" },
];

export const VERBS: readonly Verb[] = [
  // ---- presence
  { verb: "who", audience: "human", args: "[--raw]", blurb: "the roster: who is live, on what, where", group: "presence" },
  { verb: "log", audience: "shared", args: "[n] [--raw]", blurb: "recent messages from every agent", group: "presence" },
  { verb: "say", audience: "shared", args: "<text>", blurb: "tell every agent something", group: "presence" },
  { verb: "msg", audience: "shared", args: '<name> "<text>" [--from <name>]', blurb: "tell one agent something", group: "presence" },
  { verb: "where", audience: "human", args: "", blurb: "this session's repo, worktree, branch and drift from base", group: "presence" },
  { verb: "stats", audience: "human", args: "", blurb: "what the store holds, over how large a sample", group: "presence" },
  { verb: "injection", audience: "oversight", args: "[--agent <name> | --session <id>]", blurb: "what session start puts in context, and what it left out", group: "presence" },
  { verb: "inbox", audience: "oversight", args: "[--agent <name> | --session <id>]", blurb: "items omitted from your context for length", group: "presence" },
  { verb: "ask", audience: "agent", args: '<name> "<question>"', blurb: "ask a peer something and record that a reply is owed", group: "presence", trackUse: false },
  // `<id>` is an obligation uuid PREFIX, not an integer: `ask` writes to the
  // obligation ledger, and `answer` used to demand an id from a separate
  // `questions` table that `ask` never populated.
  { verb: "answer", audience: "agent", args: '<id> "<answer>"', blurb: "answer a question asked of you (id from `asks`)", group: "presence" },
  { verb: "asks", audience: "agent", args: "", blurb: "questions waiting on you, and what you are waiting for", group: "presence" },
  { verb: "request", audience: "agent", args: '<name> "<text>"', blurb: "record a proposed obligation for a peer", group: "presence", trackUse: false },
  { verb: "promise", audience: "agent", args: '<name> "<text>" [--refrain --until 4h|<text>]', blurb: "bind yourself to perform or refrain", group: "presence", trackUse: false },
  { verb: "handoff", audience: "agent", args: '<name> "<subject>"', blurb: "propose moving responsibility to a peer", group: "presence", trackUse: false },
  { verb: "grant", audience: "agent", args: '<name> "<scope>"', blurb: "grant explicit clearance over opaque scope text", group: "presence", trackUse: false },
  { verb: "correct", audience: "agent", args: '<name> <self|peer|implementation> "<text>"', blurb: "record an explicit typed correction", group: "presence", trackUse: false },
  { verb: "hazard", audience: "agent", args: '<name> "<subject>" "<warning>"', blurb: "record a warning independently of obligations", group: "presence", trackUse: false },
  { verb: "act", audience: "agent", args: '<name> --json <file>', blurb: "atomically create a compound structured message", group: "presence", trackUse: false },
  { verb: "obligation", audience: "oversight", args: '<id> [event] [flags]', blurb: "inspect or append a versioned obligation event", group: "presence" },
  { verb: "obligations", audience: "oversight", args: "[--agent <name>] [--all]", blurb: "everything outstanding across the ledger", group: "presence" },
  { verb: "clearance", audience: "oversight", args: '<id> [revoke|expire] [flags]', blurb: "inspect, revoke or expire a clearance", group: "presence" },
  { verb: "clearances", audience: "oversight", args: "[--all]", blurb: "every clearance still in force", group: "presence" },
  { verb: "files", audience: "human", args: "<agent> [--hours 24]", blurb: "every file an agent has touched, and why", group: "presence" },
  { verb: "blame", audience: "human", args: "<path>", blurb: "who has been in this file, newest first", group: "presence" },
  // "dead" was a PROMISE THE CODE DOES NOT KEEP: there is no liveness check, so
  // `quit <live peer>` deregisters a working agent mid-task. `docs/views.md` is
  // honest about this at length ("deregisters, it does not kill", and why
  // liveness cannot be detected); this one line was not.
  { verb: "quit", audience: "human", args: "<name> [--force]", blurb: "drop a session off the roster; no liveness check", group: "presence" },
  // MEASURED, because the old blurb was wrong in both directions: `clear`
  // deletes sessions and claims only (`cli/admin.ts`) and prints "(Message log
  // is kept; it self-prunes.)" -- it never touched the log, and an audit
  // avoided running it on the strength of a blast radius it does not have.
  { verb: "clear", audience: "human", args: "[--force]", blurb: "wipe the roster and claims; the log is kept", group: "presence" },
  { verb: "export", audience: "human", args: "[path]", blurb: "copy the store somewhere safe before anything destructive", group: "presence" },
  // The flag list is partial like `note`'s: `--no-claude-md`, `--crew-size`,
  // `--task-length` and `--overnight` live in the plan and the README; the
  // spec carries the flags an operator reaches for first.
  { verb: "init", audience: "human", args: "[--check [--repo]] [--test-policy <p>] [--base-ref <ref>]", blurb: "set this repo up: crew.json, the CLAUDE.md block, settings", group: "presence" },
  // `--help`/`-h` dispatch here too. They are flag SPELLINGS rather than verbs,
  // so they are aliases (recognised, never advertised) -- help offering three
  // ways to ask for help is help that wastes its first line on itself.
  { verb: "help", audience: "human", args: "", blurb: "this list", group: "presence", aliases: ["--help", "-h"] },

  // ---- work
  { verb: "doing", audience: "agent", args: '"<subject>" [--plan "a; b; c"] [--plan-doc <path>]', blurb: "open a work item; --plan is optional", group: "work" },
  { verb: "did", audience: "agent", args: '<n> ["<what changed>"] [--item <match>]', blurb: "tick a step off, with what actually changed", group: "work" },
  { verb: "undo", audience: "agent", args: "<n> [--item <match>]", blurb: "take a tick back; the step goes outstanding again", group: "work" },
  { verb: "step", audience: "agent", args: '<n> "<status>" [--item <match>]', blurb: "note progress on a step without closing it", group: "work" },
  { verb: "add", audience: "agent", args: '"<step>" [--item <match>]', blurb: "a phase the plan missed", group: "work" },
  { verb: "done", audience: "agent", args: "[<subject match>] [--abandoned]", blurb: "close ONE item; --abandoned is the honest exit", group: "work" },
  { verb: "board", audience: "human", args: "[<agent>] [--history] [--all]", blurb: "what everyone is doing", group: "work" },
  { verb: "link", audience: "agent", args: "<plan path> [--item <match>]", blurb: "say which plan document this item executes", group: "work" },
  { verb: "plans", audience: "human", args: "", blurb: "every plan with work against it, and what shipped", group: "work" },
  { verb: "mine", audience: "agent", args: "", blurb: "my open items", group: "work" },
  { verb: "breaks", audience: "agent", args: '"<what>" [--item <match>]', blurb: "record a breaking change; tells agents in the same files", group: "work" },
  { verb: "needs", audience: "agent", args: '"<what>" [--item <match>]', blurb: "record what you are blocked on, and tell them", group: "work" },

  // ---- diary
  // `note` is the WIDEST spec and so sets the two-column width for every verb.
  // Its flag list is deliberately partial: `--tags`, `--body` and `--fixes`
  // live on the usage line, which prints on an argument error and has room.
  // `--kind` earns its width, being what makes a note a bug or a decision.
  { verb: "note", audience: "agent", args: '"<title>" --topic <t> [--scope <dir>] [--kind error|decision]', blurb: "file a finding, a bug, or a decision; `note <id>` reads one", group: "diary" },
  { verb: "recall", audience: "agent", args: "<words> [--scope <dir>] [--limit n]", blurb: "search findings", group: "diary" },
  { verb: "bugs", audience: "agent", args: "[--scope <dir>] [--limit n]", blurb: "errors nobody has fixed yet", group: "diary" },
  { verb: "topics", audience: "agent", args: "", blurb: "every topic, with how much is under it", group: "diary" },
  { verb: "topic", audience: "agent", args: "<name> [--limit n]  |  merge <from> <into>", blurb: "read one topic, or fold two together", group: "diary" },
  { verb: "tags", audience: "agent", args: "", blurb: "every tag in use", group: "diary" },
  { verb: "note-deprecate", audience: "agent", args: '<id> "<why it stopped being true>"', blurb: "mark a finding no longer true, keeping the history", group: "diary" },
  { verb: "note-supersede", audience: "agent", args: "<old-id> <new-id>", blurb: "point an old finding at the one that replaced it", group: "diary" },
  { verb: "diary", audience: "oversight", args: "check", blurb: "findings that look stale, thin or duplicated", group: "diary" },

  // ---- memory
  { verb: "remember", audience: "agent", args: '"<title>" [--body "<detail>"] [--tags a,b] [--global]', blurb: "keep something about the user across sessions", group: "memory" },
  { verb: "about-me", audience: "oversight", args: "[--all]", blurb: "what you have kept", group: "memory" },
  // `about-me` answers "what have I kept?"; this answers "what does ANYONE
  // hold about me?" -- the operator's question, and one no verb could ask.
  { verb: "memories", audience: "oversight", args: "[--agent <name>] [--all-projects]", blurb: "every memory every agent holds about you", group: "memory" },
  { verb: "forget", audience: "oversight", args: "<id>", blurb: "drop a memory outright -- a wrong one must not outlive you", group: "memory" },
  { verb: "inherit", audience: "agent", args: "[<name>]", blurb: "take up a departed agent's knowledge; bare lists them", group: "memory" },

  // ---- identity
  { verb: "call-me", audience: "agent", args: "<name> [--agent <who>]", blurb: "take a different name; peers type it at msg", group: "identity", aliases: ["name"] },
  { verb: "set-role", audience: "agent", args: '"<role>" [--agent <who>]', blurb: "set your role: Keeper of Wet Things", group: "identity", aliases: ["call-you", "role"] },
  { verb: "release", audience: "agent", args: "[--agent <who>]", blurb: "give up your name so a successor can take it", group: "identity" },
];

/** Every spelling that must appear as a `case` label, aliases included. */
export function allVerbSpellings(): readonly string[] {
  return VERBS.flatMap((v) => [v.verb, ...(v.aliases ?? [])]);
}

/** The table row for a verb or one of its aliases. */
export function findVerb(verb: string): Verb | undefined {
  return VERBS.find((v) => v.verb === verb || (v.aliases ?? []).includes(verb));
}

/**
 * The `usage: crew …` line for one verb. An unknown verb yields the bare form
 * rather than throwing: a typo in an error path must not become a crash.
 */
export function usageFor(verb: string): string {
  const found = findVerb(verb);
  // THE PRIMARY NAME, not the alias the caller typed. Echoing the input taught
  // the deprecated spelling back to whoever used it, so an alias kept teaching
  // itself and nothing ever moved to the advertised name.
  const name = found?.verb ?? verb;
  const args = found?.args ?? "";
  return `usage: ${CLI} ${name}${args === "" ? "" : ` ${args}`}`;
}

/**
 * The full help, grouped.
 *
 * Width is a parameter rather than read from the terminal so the golden test
 * can pin the layout -- a help text whose shape depends on the window is one
 * nobody can assert anything about.
 */
export function usage(width = 100): string {
  const rendered = VERBS.filter((v) => v.hidden !== true).map((v) => ({
    ...v,
    call: `${v.verb}${v.args === "" ? "" : ` ${v.args}`}`,
  }));

  // THE COLUMN IS SET BY THE ROWS THAT SHARE IT: a row too wide stacks on its
  // own rather than padding every other verb to its width, which is what made
  // one long spec cost the whole table its layout.
  //
  // Chosen by FIXED POINT — drop what cannot fit, re-measure, repeat. Dropping
  // a wide row shrinks the column and can let a dropped row back in.
  let shared = rendered;
  let column = 0;
  for (;;) {
    const next = shared.reduce((w, v) => Math.max(w, v.call.length), 0);
    const fits = shared.filter((v) => 4 + next + 2 + v.blurb.length <= width);
    if (fits.length === shared.length) {
      column = next;
      break;
    }
    if (fits.length === 0) break;
    shared = fits;
  }
  const inTable = new Set(shared.map((v) => v.verb));
  const twoColumn = column > 0;

  const lines: string[] = [`usage: ${CLI} <command> [args]`, ""];
  for (const { group, title } of VERB_GROUPS) {
    const rows = rendered.filter((v) => v.group === group);
    if (rows.length === 0) continue;
    lines.push(`  ${title}`);
    for (const v of rows) {
      // Never truncated in either form: an argument spec that is cut off reads
      // as complete and is wrong, where a wrapped one is merely wide.
      if (twoColumn && inTable.has(v.verb)) {
        lines.push(`    ${v.call.padEnd(column)}  ${v.blurb}`);
      } else {
        lines.push(`    ${v.call}`, `        ${v.blurb}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
