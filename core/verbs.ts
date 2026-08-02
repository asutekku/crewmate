/**
 * Every command the CLI answers to, in one table.
 *
 * WHY A TABLE AND NOT A STRING. The usage text was a hand-maintained literal
 * and it drifted to 13 of 33 verbs -- `note`, `recall`, `remember`, `breaks`,
 * `needs`, `blame` and thirteen more existed, worked, and appeared in no help
 * output anywhere. That is worse here than in an ordinary CLI: this tool is
 * discovered at RUNTIME by agents rather than read as a manual, so the only
 * verbs an agent ever learns are the ones some hook happens to mention. Two
 * shipped features had, on measurement, been used by nobody but their author.
 *
 * Editing that string would have fixed the symptom until the next verb landed.
 * So the table is the source, `usage()` renders it, and `verbs.test.ts` asserts
 * every `case` label in cli.ts appears here -- the test is the part that keeps
 * this true, not the table.
 *
 * PER-VERB USAGE LIVES HERE TOO. cli.ts had 21 separate `usage: cli.ts <verb>`
 * literals for argument errors. They now read `usageFor(verb)`, so a verb's
 * arguments are stated once and the error you get for `did` with no number is
 * the same text `--help` shows you.
 */

/** Which section of the help a verb belongs under. Order here is display order. */
export type VerbGroup = "presence" | "work" | "diary" | "memory" | "identity";

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
  { verb: "who", args: "[--raw]", blurb: "the roster: who is live, on what, where", group: "presence" },
  { verb: "log", args: "[n] [--raw]", blurb: "recent messages from every agent", group: "presence" },
  { verb: "say", args: "<text>", blurb: "tell every agent something", group: "presence" },
  { verb: "msg", args: '<name> "<text>" [--from <name>]', blurb: "tell one agent something", group: "presence" },
  { verb: "where", args: "", blurb: "this session's repo, worktree, branch and drift from base", group: "presence" },
  { verb: "ask", args: '<name> "<question>"', blurb: "ask a peer something and record that a reply is owed", group: "presence" },
  { verb: "answer", args: '<id> "<answer>"', blurb: "answer a question asked of you", group: "presence" },
  { verb: "asks", args: "", blurb: "questions waiting on you, and what you are waiting for", group: "presence" },
  { verb: "files", args: "<agent> [--hours 24]", blurb: "every file an agent has touched, and why", group: "presence" },
  { verb: "blame", args: "<path>", blurb: "who has been in this file, newest first", group: "presence" },
  { verb: "quit", args: "<name>", blurb: "drop a dead session off the roster", group: "presence" },
  { verb: "clear", args: "", blurb: "wipe the roster and message log", group: "presence" },
  // `--help`/`-h` dispatch here too. They are flag SPELLINGS rather than verbs,
  // so they are aliases (recognised, never advertised) -- help offering three
  // ways to ask for help is help that wastes its first line on itself.
  { verb: "help", args: "", blurb: "this list", group: "presence", aliases: ["--help", "-h"] },

  // ---- work
  { verb: "doing", args: '"<subject>" [--plan "a; b; c"] [--plan-doc <path>]', blurb: "open a work item; --plan is optional", group: "work" },
  { verb: "did", args: '<n> ["<what changed>"] [--item <match>]', blurb: "tick a step off, with what actually changed", group: "work" },
  { verb: "step", args: '<n> "<status>" [--item <match>]', blurb: "note progress on a step without closing it", group: "work" },
  { verb: "add", args: '"<step>" [--item <match>]', blurb: "a phase the plan missed", group: "work" },
  { verb: "done", args: "[<subject match>] [--abandoned]", blurb: "close ONE item; --abandoned is the honest exit", group: "work" },
  { verb: "board", args: "[<agent>] [--history] [--all]", blurb: "what everyone is doing", group: "work" },
  { verb: "link", args: "<plan path> [--item <match>]", blurb: "say which plan document this item executes", group: "work" },
  { verb: "plans", args: "", blurb: "every plan with work against it, and what shipped", group: "work" },
  { verb: "mine", args: "", blurb: "my open items", group: "work" },
  { verb: "breaks", args: '"<what>" [--item <match>]', blurb: "record a breaking change; tells agents in the same files", group: "work" },
  { verb: "needs", args: '"<what>" [--item <match>]', blurb: "record what you are blocked on, and tell them", group: "work" },

  // ---- diary
  // The flag list is deliberately partial -- `--tags` and `--kind` are on the
  // verb's own usage line, which prints on an argument error and has the room.
  // A spec wide enough to name every flag is one that wraps on an 80-column
  // terminal, and a wrapped spec is harder to read than a short one plus a
  // pointer to the full form.
  // `--kind` earns its place in the spec despite the width: it is what makes a
  // note a BUG rather than a fact, and a flag missing from `help` is a feature
  // agents never reach. `--tags` and `--body` stay on the verb's own usage line.
  { verb: "note", args: '"<title>" --topic <t> [--scope <dir>] [--kind error] [--fixes <id>]', blurb: "file a finding, or a bug; `note <id>` reads one", group: "diary" },
  { verb: "recall", args: "<words> [--scope <dir>] [--limit n]", blurb: "search findings", group: "diary" },
  { verb: "bugs", args: "[--scope <dir>] [--limit n]", blurb: "errors nobody has fixed yet", group: "diary" },
  { verb: "topics", args: "", blurb: "every topic, with how much is under it", group: "diary" },
  { verb: "topic", args: "<name> [--limit n]  |  merge <from> <into>", blurb: "read one topic, or fold two together", group: "diary" },
  { verb: "tags", args: "", blurb: "every tag in use", group: "diary" },
  { verb: "note-deprecate", args: '<id> "<why it stopped being true>"', blurb: "mark a finding no longer true, keeping the history", group: "diary" },
  { verb: "note-supersede", args: "<old-id> <new-id>", blurb: "point an old finding at the one that replaced it", group: "diary" },
  { verb: "diary", args: "check", blurb: "findings that look stale, thin or duplicated", group: "diary" },

  // ---- memory
  { verb: "remember", args: '"<title>" [--body "<detail>"] [--tags a,b] [--global]', blurb: "keep something about the user across sessions", group: "memory" },
  { verb: "about-me", args: "[--all]", blurb: "what you have kept", group: "memory" },
  { verb: "forget", args: "<id>", blurb: "drop a memory outright -- a wrong one must not outlive you", group: "memory" },

  // ---- identity
  { verb: "call-me", args: "<name> [--agent <who>]", blurb: "take a different name; peers type it at msg", group: "identity", aliases: ["name"] },
  { verb: "call-you", args: '"<role>" [--agent <who>]', blurb: "say what you ARE: Keeper of Wet Things", group: "identity", aliases: ["role"] },
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
 * The `usage: cli.ts …` line for one verb, for argument errors.
 *
 * Returns a bare `usage: cli.ts <verb>` for anything absent from the table
 * rather than throwing: a mistyped verb name in an error path should not turn a
 * bad-arguments message into a crash.
 */
export function usageFor(verb: string): string {
  const found = findVerb(verb);
  const args = found?.args ?? "";
  return `usage: cli.ts ${verb}${args === "" ? "" : ` ${args}`}`;
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

  // THE COLUMN IS SET BY THE ROWS THAT SHARE IT, and a row too wide for the
  // pair stacks on its own without dragging the rest with it. Measured while
  // writing this: `note`'s 62-char spec padded all 33 verbs to 62, pushing the
  // worst pair to 126 columns, so the table never fired even on a 120-column
  // terminal and every verb stacked. Sizing to the outlier is what made one
  // long spec cost thirty other verbs their layout.
  //
  // Rows are chosen by fixed point: drop what cannot fit, re-measure, repeat.
  // Dropping a wide row shrinks the column, which can let a previously-dropped
  // row back in -- one pass would settle on a column wider than necessary.
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

  const lines: string[] = ["usage: cli.ts <command> [args]", ""];
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
