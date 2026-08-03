import { briefAgo } from "../core/board.ts";
import { bold, cyan, dim, green, red, yellow } from "../core/colour.ts";
import {
  checkNote,
  nearTopic,
  parseTags,
  type DiaryEntry,
  type DiaryKind,
} from "../core/diary.ts";
import { fit, pad, shortAge, terminalWidth, wrap } from "../core/layout.ts";
import { withStore } from "../core/store.ts";
import { takeFlag } from "./args.ts";
import { failUsage } from "./command.ts";
import { callerIdentity, notAnAgent } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

function entryLines(entry: DiaryEntry, nowMs: number, width: number): string[] {
  const age = shortAge(entry.tsMs, nowMs);
  const paint =
    entry.kind === "error"
      ? red
      : entry.kind === "warning"
        ? yellow
        : entry.kind === "optimization"
          ? green
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
  if (entry.body !== "") bits.push(dim(`(body: cli.ts note ${entry.id})`));
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
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) {
    context.error("usage: cli.ts note <id>");
    context.fail();
    return;
  }
  withStore(context.dbPath, (store) => {
    const now = context.now();
    const entry = store.diary.get(id);
    if (!entry) {
      context.error(`no diary entry #${id} in ${context.projectName}`);
      context.fail();
      return;
    }
    for (const line of entryLines(entry, now, terminalWidth()))
      context.log(line);
    if (entry.body !== "") {
      context.log("");
      for (const line of entry.body.split("\n")) context.log(`  ${line}`);
    }
  });
}

function recall(context: CliContext, args: string[]): void {
  const topic = takeFlag(args, "--topic");
  const tag = takeFlag(args, "--tag");
  const kind = takeFlag(args, "--kind");
  const scope = takeFlag(args, "--scope");
  const limit = Number(takeFlag(args, "--limit")) || 20;
  const allIndex = args.indexOf("--all");
  const all = allIndex >= 0;
  if (all) args.splice(allIndex, 1);
  const mineIndex = args.indexOf("--mine");
  const mine = mineIndex >= 0;
  if (mine) args.splice(mineIndex, 1);
  const query = args.join(" ").trim();
  withStore(context.dbPath, (store) => {
    const hits = store.diary.recall({
      query,
      topic,
      tag,
      ...(kind ? { kind: kind as DiaryKind } : {}),
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
    const now = context.now();
    for (const entry of hits)
      for (const line of entryLines(entry, now, terminalWidth()))
        context.log(line);
  });
}

export function createDiaryCommands(context: CliContext): CommandMap {
  return {
    note(args) {
      if (args.length === 1 && /^\d+$/.test(args[0] ?? ""))
        return show(context, args[0] ?? "");
      if (args.length === 0) {
        context.error(
          'usage: cli.ts note "<title>" --topic <t> [--body "<detail>"]',
        );
        context.error(
          dim(
            "             [--tags a,b] [--kind finding|warning|error|optimization]",
          ),
        );
        context.error(dim("             [--scope src/sim/water]"));
        context.error(
          dim("       cli.ts note <id>     # read one, body included"),
        );
        context.fail();
        return;
      }
      const topic = takeFlag(args, "--topic");
      const body = takeFlag(args, "--body");
      const tags = takeFlag(args, "--tags");
      const kind = takeFlag(args, "--kind");
      const scope = takeFlag(args, "--scope");
      const fixes = takeFlag(args, "--fixes");
      const check = checkNote({
        title: args.join(" ").trim(),
        body,
        topic,
        tags: parseTags(tags),
        ...(kind ? { kind: kind as DiaryKind } : {}),
        scope,
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
        const id = store.diary.write(
          context.sessionId,
          who.agentName,
          check.note,
          now,
        );
        context.log(`${green("✓")} ${bold(`#${id}`)} ${check.note.title}`);
        const where = check.note.scope !== "" ? ` in ${check.note.scope}` : "";
        context.log(
          dim(
            `  ${check.note.kind} · ${check.note.topic}${where} — peers find it with \`cli.ts recall\``,
          ),
        );
        if (check.note.scope === "")
          context.log(
            dim(
              "  no --scope, so this will not surface when someone edits a related file",
            ),
          );
        if (!fixes) return;
        const target = Number(fixes);
        const bug = Number.isFinite(target) ? store.diary.get(target) : null;
        if (!bug) context.error(`${red("✗")} --fixes: no entry #${fixes}`);
        else if (bug.kind !== "error")
          context.error(
            `${red("✗")} --fixes: #${target} is a ${bug.kind}, and only an error can be fixed`,
          );
        else if (!store.diary.fix(target, id, now))
          context.error(`${red("✗")} --fixes: #${target} is already fixed`);
        else
          context.log(`${green("✓")} fixed ${dim(`#${target} ${bug.title}`)}`);
      });
    },

    recall: (args) => recall(context, args),
    topics(args) {
      const stale = args.includes("--stale");
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const all = store.diary.topics();
        if (all.length === 0) {
          context.log(
            dim(
              `the ${context.projectName} diary is empty — write one with \`cli.ts note\`.`,
            ),
          );
          return;
        }
        const shown = stale
          ? all.filter((topic) => now - topic.lastMs > 30 * 24 * 60 * 60 * 1000)
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
    tags() {
      withStore(context.dbPath, (store) => {
        const cloud = store.diary.tagCloud();
        if (cloud.length === 0) {
          context.log(
            dim('no tags yet — `cli.ts note "…" --topic x --tags perf,flaky`'),
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
      const scope = takeFlag(args, "--scope");
      const limit = Number(takeFlag(args, "--limit")) || 20;
      withStore(context.dbPath, (store) => {
        const open = store.diary.openBugs(scope, limit);
        if (open.length === 0) {
          context.log(
            dim(scope ? `No open bugs under ${scope}.` : "No open bugs."),
          );
          return;
        }
        const now = context.now();
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
            '  Close one by filing the fix: `cli.ts note "<what fixed it>" --topic <t> --fixes <id>`',
          ),
        );
      });
    },
    "note-deprecate"(args) {
      const id = Number(args.shift());
      const why = args.join(" ");
      if (!Number.isFinite(id) || id <= 0 || !why.trim()) {
        failUsage(context, "note-deprecate");
        context.error(
          dim(
            "  The reason is required — it is usually worth more than the claim was.",
          ),
        );
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
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
      const id = Number(args[0]);
      const by = Number(args[1]);
      if (!Number.isFinite(id) || !Number.isFinite(by) || id <= 0 || by <= 0) {
        failUsage(context, "note-supersede");
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
        if (!store.diary.supersede(id, by, now)) {
          context.error(`${red("✗")} could not supersede #${id} with #${by}`);
          context.fail();
          return;
        }
        context.log(`${green("✓")} #${id} ${dim("→")} #${by}`);
      });
    },
    topic(args) {
      if (args[0] === "merge") {
        if (args.length !== 3) {
          context.error("usage: cli.ts topic merge <from> <into>");
          context.fail();
          return;
        }
        withStore(context.dbPath, (store) => {
          const count = store.diary.mergeTopic(args[1] ?? "", args[2] ?? "");
          if (count === 0) {
            context.error(
              `${red("✗")} nothing moved — check both names with \`cli.ts topics\``,
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
      const limit = Number(takeFlag(args, "--limit")) || 20;
      const name = args.join(" ").trim();
      if (!name) {
        context.error("usage: cli.ts topic <name> [--limit n]");
        context.fail();
        return;
      }
      recall(context, ["--topic", name, "--limit", String(limit)]);
    },
    diary(args) {
      if (args[0] !== "check") {
        failUsage(context, "diary");
        return;
      }
      withStore(context.dbPath, (store) => {
        const now = context.now();
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
