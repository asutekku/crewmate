import { briefAgo } from "../core/board.ts";
import { blue, bold, cyan, dim, green, red, yellow } from "../core/colour.ts";
import {
  checkNote,
  DIARY_KINDS,
  nearTopic,
  parseTags,
  type DiaryEntry,
} from "../core/diary.ts";
import { fit, pad, shortAge, terminalWidth, wrap } from "../core/layout.ts";
import { withStore } from "../core/store.ts";
import {
  booleanFlag,
  parseArguments,
  parseEnum,
  parseSafeInteger,
  requireSafeInteger,
  stringFlag,
  type ParsedArguments,
} from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { callerIdentity, notAnAgent } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

const DEFAULT_DIARY_LIMIT = 20;
const MAX_DIARY_LIMIT = 1_000;
const STALE_TOPIC_MS = 30 * 24 * 60 * 60 * 1000;

function diaryArguments(
  context: CliContext,
  command: string,
  args: readonly string[],
  schema: Parameters<typeof parseArguments>[1],
): ParsedArguments | undefined {
  const parsed = parseArguments(args, schema);
  if (parsed.ok) return parsed.value;
  failCommand(context, `${command}: ${parsed.error}`);
  return undefined;
}

function diaryLimit(
  context: CliContext,
  command: string,
  input: ParsedArguments,
): number | undefined {
  const parsed = parseSafeInteger(stringFlag(input, "--limit"), "limit", {
    min: 1,
    max: MAX_DIARY_LIMIT,
  });
  if (!parsed.ok) {
    failCommand(context, `${command}: ${parsed.error}`);
    return undefined;
  }
  return parsed.value ?? DEFAULT_DIARY_LIMIT;
}

function entryLines(entry: DiaryEntry, nowMs: number, width: number): string[] {
  const age = shortAge(entry.tsMs, nowMs);
  const paint =
    entry.kind === "error"
      ? red
      : entry.kind === "warning"
        ? yellow
        : entry.kind === "optimization"
          ? green
          : entry.kind === "decision"
            ? blue
            : dim;
  const prefix = `#${entry.id} ${entry.kind.padEnd(12)} ${pad(age, 4)}  `;
  const head = `${dim(`#${entry.id}`)} ${paint(entry.kind.padEnd(12))} ${dim(pad(age, 4))}  `;
  const lines = wrap(entry.title, Math.max(20, width - prefix.length)).map(
    (line, index) =>
      index === 0 ? head + bold(line) : " ".repeat(prefix.length) + bold(line),
  );
  const bits = [cyan(entry.topic), ...entry.tags.map((tag) => dim(`#${tag}`))];
  if (entry.scope !== "") bits.push(dim(entry.scope));
  bits.push(dim(`— ${entry.agent}`));
  if (entry.body !== "") bits.push(dim(`(body: crew note ${entry.id})`));
  lines.push(" ".repeat(prefix.length) + bits.join(" "));
  if (entry.deprecatedMs !== 0) {
    const why = entry.deprecatedWhy !== "" ? `: ${entry.deprecatedWhy}` : "";
    const superseded =
      entry.supersededBy !== 0 ? ` → see #${entry.supersededBy}` : "";
    lines.push(
      " ".repeat(prefix.length) +
        red(fit(`✗ no longer true${why}${superseded}`, width - prefix.length)),
    );
  }
  return lines;
}

function show(context: CliContext, idRaw: string): void {
  const parsed = requireSafeInteger(idRaw, "diary entry id", {
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (!parsed.ok) return failCommand(context, parsed.error);
  const id = parsed.value;
  const now = context.now();
  const width = terminalWidth();
  withStore(context.dbPath, (store) => {
    const entry = store.diary.get(id);
    if (!entry) {
      context.error(`no diary entry #${id} in ${context.projectName}`);
      context.fail();
      return;
    }
    for (const line of entryLines(entry, now, width))
      context.log(line);
    if (entry.body !== "") {
      context.log("");
      for (const line of entry.body.split("\n")) context.log(`  ${line}`);
    }
  });
}

function recall(context: CliContext, args: readonly string[]): void {
  const input = diaryArguments(context, "recall", args, {
    valueFlags: ["--topic", "--tag", "--kind", "--scope", "--limit"],
    booleanFlags: ["--all", "--mine"],
  });
  if (!input) return;
  const kind = parseEnum(stringFlag(input, "--kind"), "kind", DIARY_KINDS);
  if (!kind.ok) return failCommand(context, `recall: ${kind.error}`);
  const limit = diaryLimit(context, "recall", input);
  if (limit === undefined) return;
  const topic = stringFlag(input, "--topic") ?? "";
  const tag = stringFlag(input, "--tag") ?? "";
  const scope = stringFlag(input, "--scope") ?? "";
  const all = booleanFlag(input, "--all");
  const mine = booleanFlag(input, "--mine");
  const query = input.positionals.join(" ").trim();
  const now = context.now();
  const width = terminalWidth();
  withStore(context.dbPath, (store) => {
    const hits = store.diary.recall({
      query,
      topic,
      tag,
      ...(kind.value ? { kind: kind.value } : {}),
      scope,
      ...(mine ? { sessionId: context.sessionId } : {}),
      all,
      limit,
    });
    if (hits.length === 0) {
      context.log(
        dim(`nothing in the diary matches${query ? ` "${query}"` : ""}.`),
      );
      const topics = store.diary.topics();
      if (topics.length > 0)
        context.log(
          dim(
            `  topics: ${topics
              .slice(0, 8)
              .map((item) => item.topic)
              .join(", ")}`,
          ),
        );
      return;
    }
    for (const entry of hits)
      for (const line of entryLines(entry, now, width))
        context.log(line);
  });
}

export function createDiaryCommands(context: CliContext): CommandMap {
  return {
    note(args) {
      const input = diaryArguments(context, "note", args, {
        valueFlags: ["--topic", "--body", "--tags", "--kind", "--scope", "--fixes"],
      });
      if (!input) return;
      if (input.positionals.length === 1 && input.flags.size === 0)
        return show(context, input.positionals[0] ?? "");
      if (input.positionals.length === 0) {
        context.error(
          'usage: crew note "<title>" --topic <t> [--body "<detail>"]',
        );
        context.error(
          dim(`             [--tags a,b] [--kind ${DIARY_KINDS.join("|")}]`),
        );
        context.error(
          dim("             [--scope src/sim/water] [--fixes <id>]"),
        );
        context.error(
          dim("       crew note <id>     # read one, body included"),
        );
        context.fail();
        return;
      }
      const kind = parseEnum(stringFlag(input, "--kind"), "kind", DIARY_KINDS);
      if (!kind.ok) return failCommand(context, `note: ${kind.error}`);
      const fixes = parseSafeInteger(stringFlag(input, "--fixes"), "fixes id", {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      if (!fixes.ok) return failCommand(context, `note: ${fixes.error}`);
      const check = checkNote({
        title: input.positionals.join(" ").trim(),
        body: stringFlag(input, "--body") ?? "",
        topic: stringFlag(input, "--topic") ?? "",
        tags: parseTags(stringFlag(input, "--tags") ?? ""),
        ...(kind.value ? { kind: kind.value } : {}),
        scope: stringFlag(input, "--scope") ?? "",
      });
      if (!check.ok) {
        context.error(`${red("✗")} ${check.why}`);
        context.fail();
        return;
      }
      withStore(context.dbPath, (store) => {
        const who = callerIdentity(context, store);
        if (!who) return notAnAgent(context, "`note`");
        const now = context.now();
        let id: number;
        if (fixes.value !== undefined) {
          const result = store.diary.writeAndFix(
            context.sessionId,
            who.agentName,
            check.note,
            fixes.value,
            now,
          );
          if (!result.ok) {
            const detail =
              result.reason === "missing"
                ? `no entry #${fixes.value}`
                : result.reason === "not-error"
                  ? `#${fixes.value} is a ${result.target?.kind ?? "non-error"}`
                  : `#${fixes.value} is already fixed`;
            failCommand(context, `--fixes: ${detail}`);
            return;
          }
          id = result.entryId;
        } else {
          id = store.diary.write(
            context.sessionId,
            who.agentName,
            check.note,
            now,
          );
        }
        context.log(`${green("✓")} ${bold(`#${id}`)} ${check.note.title}`);
        const where = check.note.scope !== "" ? ` in ${check.note.scope}` : "";
        context.log(
          dim(
            `  ${check.note.kind} · ${check.note.topic}${where} — peers find it with \`crew recall\``,
          ),
        );
        if (check.note.scope === "")
          context.log(
            dim(
              "  no --scope, so this will not surface when someone edits a related file",
            ),
          );
        if (fixes.value !== undefined) {
          context.log(`${green("fixed")} ${dim(`#${fixes.value}`)}`);
          return;
        }
      });
    },

    recall: (args) => recall(context, args),
    topics(args) {
      const input = diaryArguments(context, "topics", args, {
        booleanFlags: ["--stale"],
        maxPositionals: 0,
      });
      if (!input) return;
      const stale = booleanFlag(input, "--stale");
      const now = context.now();
      withStore(context.dbPath, (store) => {
        const all = store.diary.topics();
        if (all.length === 0) {
          context.log(
            dim(
              `the ${context.projectName} diary is empty — write one with \`crew note\`.`,
            ),
          );
          return;
        }
        const shown = stale
          ? all.filter((topic) => now - topic.lastMs > STALE_TOPIC_MS)
          : all;
        const width = Math.max(...shown.map((topic) => topic.topic.length), 5);
        context.log(bold(`${all.length} topics in ${context.projectName}`));
        for (const topic of shown) {
          const near = all.find(
            (other) =>
              other.topic !== topic.topic &&
              nearTopic(other.topic, topic.topic),
          );
          context.log(
            `  ${cyan(pad(topic.topic, width))} ${dim(String(topic.count).padStart(3))}  ${dim(shortAge(topic.lastMs, now))}${near ? dim(`  (near \`${near.topic}\` — merge?)`) : ""}`,
          );
        }
      });
    },
    tags(args) {
      const input = diaryArguments(context, "tags", args, { maxPositionals: 0 });
      if (!input) return;
      withStore(context.dbPath, (store) => {
        const cloud = store.diary.tagCloud();
        if (cloud.length === 0) {
          context.log(
            dim('no tags yet — `crew note "…" --topic x --tags perf,flaky`'),
          );
          return;
        }
        context.log(bold(`${cloud.length} tags in ${context.projectName}`));
        const width = Math.max(...cloud.map((item) => item.tag.length), 5);
        for (const item of cloud)
          context.log(
            `  ${dim("#")}${cyan(pad(item.tag, width))} ${dim(String(item.count).padStart(3))}`,
          );
      });
    },
    bugs(args) {
      const input = diaryArguments(context, "bugs", args, {
        valueFlags: ["--scope", "--limit"],
        maxPositionals: 0,
      });
      if (!input) return;
      const limit = diaryLimit(context, "bugs", input);
      if (limit === undefined) return;
      const scope = stringFlag(input, "--scope") ?? "";
      const now = context.now();
      withStore(context.dbPath, (store) => {
        const open = store.diary.openBugs(scope, limit);
        if (open.length === 0) {
          context.log(
            dim(scope ? `No open bugs under ${scope}.` : "No open bugs."),
          );
          return;
        }
        for (const bug of open) {
          context.log(`${red("●")} ${bold(`#${bug.id}`)} ${bug.title}`);
          context.log(
            dim(
              `    ${bug.topic}${bug.scope ? ` ${bug.scope}` : ""} — ${bug.agent}, ${briefAgo(bug.tsMs, now)}`,
            ),
          );
        }
        context.log(
          dim(
            '  Close one by filing the fix: `crew note "<what fixed it>" --topic <t> --fixes <id>`',
          ),
        );
      });
    },
    "note-deprecate"(args) {
      const input = diaryArguments(context, "note-deprecate", args, {});
      if (!input) return;
      const parsedId = requireSafeInteger(input.positionals[0], "diary entry id", {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      const why = input.positionals.slice(1).join(" ");
      if (!parsedId.ok || !why.trim()) {
        failUsage(context, "note-deprecate");
        context.error(
          dim(
            "  The reason is required — it is usually worth more than the claim was.",
          ),
        );
        return;
      }
      const id = parsedId.value;
      const now = context.now();
      withStore(context.dbPath, (store) => {
        const entry = store.diary.get(id);
        if (!entry) {
          context.error(`no diary entry #${id} in ${context.projectName}`);
          context.fail();
          return;
        }
        if (!store.diary.deprecate(id, why, now)) {
          if (
            entry.deprecatedWhy === "" &&
            store.diary.explainDeprecation(id, why)
          ) {
            context.log(`${green("✓")} #${id} ${dim("— reason recorded")}`);
            return;
          }
          context.error(`${red("✗")} #${id} is already marked no longer true`);
          context.fail();
          return;
        }
        context.log(`${green("✓")} #${id} ${dim("marked no longer true")}`);
      });
    },
    "note-supersede"(args) {
      const input = diaryArguments(context, "note-supersede", args, {
        maxPositionals: 2,
      });
      if (!input) return;
      const parsedId = requireSafeInteger(input.positionals[0], "diary entry id", {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      const parsedBy = requireSafeInteger(input.positionals[1], "replacement entry id", {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });
      if (!parsedId.ok || !parsedBy.ok) return failUsage(context, "note-supersede");
      const id = parsedId.value;
      const by = parsedBy.value;
      const now = context.now();
      withStore(context.dbPath, (store) => {
        if (!store.diary.supersede(id, by, now)) {
          context.error(`${red("✗")} could not supersede #${id} with #${by}`);
          context.fail();
          return;
        }
        context.log(`${green("✓")} #${id} ${dim("→")} #${by}`);
      });
    },
    topic(args) {
      const input = diaryArguments(context, "topic", args, {
        valueFlags: ["--limit"],
      });
      if (!input) return;
      if (input.positionals[0] === "merge") {
        if (input.positionals.length !== 3 || input.flags.size !== 0) {
          context.error("usage: crew topic merge <from> <into>");
          context.fail();
          return;
        }
        const from = input.positionals[1] ?? "";
        const into = input.positionals[2] ?? "";
        withStore(context.dbPath, (store) => {
          const count = store.diary.mergeTopic(from, into);
          if (count === 0) {
            context.error(
              `${red("✗")} nothing moved — check both names with \`crew topics\``,
            );
            context.fail();
            return;
          }
          context.log(
            `${green("✓")} moved ${count} ${count === 1 ? "entry" : "entries"} from ${bold(args[1] ?? "")} to ${bold(args[2] ?? "")}`,
          );
        });
        return;
      }
      const limit = diaryLimit(context, "topic", input);
      if (limit === undefined) return;
      const name = input.positionals.join(" ").trim();
      if (!name) {
        context.error("usage: crew topic <name> [--limit n]");
        context.fail();
        return;
      }
      recall(context, ["--topic", name, "--limit", String(limit)]);
    },
    diary(args) {
      const input = diaryArguments(context, "diary", args, { maxPositionals: 1 });
      if (!input) return;
      if (input.positionals[0] !== "check") {
        failUsage(context, "diary");
        return;
      }
      const now = context.now();
      withStore(context.dbPath, (store) => {
        const problems = store.diary.check(now);
        if (problems.length === 0) {
          context.log(
            `${green("✓")} the ${context.projectName} diary looks healthy`,
          );
          return;
        }
        context.log(
          bold(
            `${problems.length} thing(s) worth a look in ${context.projectName}`,
          ),
        );
        for (const problem of problems) {
          context.log(`  ${yellow("•")} ${problem.detail}`);
          if (problem.fix) context.log(dim(`      ${problem.fix}`));
        }
      });
    },
  };
}
