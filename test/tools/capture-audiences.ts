/**
 * Regenerates the captured verb output in `docs/audiences.md`.
 *
 * WHY A SCRIPT AND NOT A SESSION. The captures were collected by hand once:
 * each verb run as the audit proceeded, then the blocks arranged by topic. Each
 * block was real and the DOCUMENT was not — blocks from different moments sat
 * side by side, so a reader cross-checking them derived a state that never
 * existed. Two nonexistent defects were inferred from it by a careful reviewer
 * (a `log` kind-filter and a `plans` path-filter, neither of which exists).
 *
 * Here, block order IS execution order, by construction. That makes the failure
 * impossible rather than fixed-once, which is the whole point.
 *
 * WHY FIXTURES. The obvious fix — "run it against a scratch project" — trades
 * the framing failure for a coverage failure. The original captures were
 * legible because a second agent was genuinely working in the tree: `who`,
 * `board`, `files`, `blame`, `breaks` and `injection --agent` all had something
 * to show. One scripted session renders half the surfaces empty.
 *
 * So this seeds a store directly, which also lets it capture what a live audit
 * never could: a departed session (so `board` prints its resume handle), a
 * genuine path collision (so contested-red has something to mark), and an
 * over-budget injection (so `inbox` shows an omission — measured, that branch
 * has NEVER been captured).
 *
 * Run: bun test/tools/capture-audiences.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { withStore } from "../../core/store.ts";
import { VERBS } from "../../core/verbs.ts";

const DOC = new URL("../../docs/audiences.md", import.meta.url).pathname.replace(
  /^\/(?=[A-Za-z]:)/,
  "",
);
const CLI = new URL("../../cli.ts", import.meta.url).pathname.replace(
  /^\/(?=[A-Za-z]:)/,
  "",
);

const START = "<!-- BEGIN CAPTURED OUTPUT -->";
const END = "<!-- END CAPTURED OUTPUT -->";

/** A throwaway project root, so nothing here can touch a real roster. */
const root = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/crewmate-capture-`);

/** One store for both the seed and every CLI run — see `PRESENCE_TEST_DB`. */
const DB = `${root}/store.db`;

/** Deterministic ids, so a regeneration diffs cleanly against the last one. */
const ALDER = "11111111-1111-4111-8111-111111111111";
const BIRCH = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";

interface Capture {
  readonly heading: string;
  readonly why: string;
  readonly runs: ReadonlyArray<readonly string[]>;
}

/**
 * The script, in the order it runs.
 *
 * Grouped by what a reader is trying to learn, NOT by verb table order — but
 * within the document the blocks appear exactly as executed, which is the
 * property the hand-collated version could not offer.
 */
const SCRIPT: readonly Capture[] = [
  {
    heading: "The roster",
    why: "Two agents live in one tree, one of them holding a contested file.",
    runs: [["who"], ["who", "--raw"], ["where"]],
  },
  {
    heading: "Who touched what",
    why: "The questions git cannot answer: which of several agents wrote this.",
    runs: [["files", "alder"], ["blame", "README.md"]],
  },
  {
    heading: "The work board",
    why:
      "Includes a departed session's open item, which is the only way the " +
      "`claude --resume` handle appears.",
    runs: [["board"], ["board", "--all"], ["board", "alder", "--history"], ["plans"]],
  },
  {
    heading: "Messages",
    why: "Both directions, and the delivery wording that names when it lands.",
    runs: [["log", "8"], ["log", "5", "--raw"]],
  },
  {
    heading: "The diary",
    why: "Seeded with one finding and one open bug.",
    runs: [["recall", "roster"], ["bugs"], ["topics"], ["tags"], ["diary", "check"]],
  },
  {
    heading: "Obligations",
    why:
      "A question, a promise made TO the reader, and an overflow — the three " +
      "shapes that behave differently in the injection.",
    runs: [["asks"], ["injection", "--agent", "alder"], ["inbox", "--agent", "alder"]],
  },
  {
    heading: "Oversight — what the operator can enumerate",
    why:
      "The three read surfaces that did not exist until the audit: the ledger " +
      "and the memories agents hold about you. Each was previously reachable " +
      "only by already knowing a uuid, or not at all.",
    runs: [["obligations"], ["obligations", "--all"], ["clearances"], ["memories"]],
  },
  {
    heading: "Discoverability",
    why: "Every verb answers `--help`, including the destructive ones.",
    runs: [["help"], ["clear", "--help"], ["quit", "--help"]],
  },
];

function seed(): void {
  withStore(DB, (store) => {
    const now = Date.now();
    // Two live agents plus one that has gone: the departed row is what makes
    // `board` offer a resume handle, and it cannot be staged any other way.
    for (const [id, name, title, seenMs] of [
      [ALDER, "alder", "Audit the roster surfaces", now],
      [BIRCH, "birch", "Release scaffolding", now],
      // Four hours stale: past the 90-minute sweep, so `board` treats it as gone.
      [GONE, "cedar", "Retire the old net core", now - 4 * 60 * 60 * 1000],
    ] as const) {
      store.register(id, root, "main", seenMs);
      store.setAlias(id, name, seenMs);
      store.setTitle(id, title);
    }

    // A GENUINE PATH COLLISION. Same leaf, different directories — the case
    // that rendered as one file until P1-2, and the only way contested-red can
    // be shown meaning what it claims.
    store.claim(ALDER, "README.md", now);
    store.claim(BIRCH, "plans/README.md", now);
    store.claim(BIRCH, "README.md", now);

    // WORK ITEMS, including one whose session has gone. The departed item is
    // the only way `board` prints a `claude --resume` handle -- a claim the
    // original audit made in prose and never evidenced, because a live roster
    // cannot stage it on demand.
    const live = store.work.open(
      `session:${ALDER}`,
      "alder",
      "audit the roster surfaces",
      ["capture who and where", "capture the board", "check the collision"],
      now - 90 * 60 * 1000,
      "plans/AUDIT_REMEDIATION_PLAN.md",
    );
    store.work.tick(live, 1, "who, who --raw and where captured", now - 40 * 60 * 1000);
    store.work.record(
      live,
      "breaks",
      "contested display changed; re-read `who`",
      now - 30 * 60 * 1000,
    );

    const orphan = store.work.open(
      `session:${GONE}`,
      "cedar",
      "retire the old net core",
      ["delete buildGraph", "migrate the 12 call sites", "re-record baselines"],
      now - 3 * 24 * 60 * 60 * 1000,
    );
    store.work.tick(orphan, 1, "the core flag went with it", now - 3 * 24 * 60 * 60 * 1000);

    // A DIARY WITH SOMETHING IN IT, so `recall`, `bugs` and `topics` show their
    // populated form rather than three different empty-state messages.
    store.diary.write(
      BIRCH,
      "birch",
      {
        title: "the roster keys on the conversation uuid, not the process",
        body: "A restart relabels the row; it does not replace it.",
        topic: "roster",
        scope: "core/",
        kind: "finding",
        tags: ["identity"],
      },
      now - 2 * 60 * 60 * 1000,
    );
    store.diary.write(
      ALDER,
      "alder",
      {
        title: "contested files rendered as bare leaf names",
        body: "`README.md` and `plans/README.md` were indistinguishable on the roster.",
        topic: "roster",
        scope: "core/layout.ts",
        kind: "error",
        tags: ["display"],
      },
      now - 60 * 60 * 1000,
    );

    // A QUESTION AND A GRANT, so the ledger surfaces have rows. `createBatch`
    // is the same path `ask` and `grant` use, so what renders here is what an
    // agent would produce -- not a hand-built approximation of it.
    store.obligations.createBatch({
      senderSessionId: BIRCH,
      senderName: "birch",
      recipientSessionId: ALDER,
      recipientName: "alder",
      acts: [
        { key: "q", type: "question", text: "does the roster survive a restart?" },
        {
          key: "g",
          type: "grant",
          text: "clearance over the audiences doc",
          scopeText: "docs/audiences.md",
        },
      ],
      idempotencyKey: "capture-fixture-1",
      nowMs: now - 45 * 60 * 1000,
      surface: "cli",
    });
  });
}

/**
 * Random ids to stable placeholders, SHARED ACROSS COMMANDS.
 *
 * Module scope rather than per-run: the same obligation printed by
 * `obligations` and by `obligation <id>` must read as the same obligation, or
 * the captures teach a relationship that is not there.
 */
const stableIds = new Map<string, string>();
const placeholder = (key: string): string => {
  if (!stableIds.has(key))
    stableIds.set(key, `id${String(stableIds.size + 1).padStart(6, "0")}`);
  return stableIds.get(key) ?? key;
};

function run(args: readonly string[]): string {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: root,
    env: {
      ...process.env,
      NO_COLOR: "1",
      CLAUDE_CODE_SESSION_ID: ALDER,
      // PINS THE CLI TO THE SEEDED STORE. Without it `resolveProject` derives a
      // path from the scratch directory and every capture reads an empty
      // roster — which is exactly how the first run of this script produced a
      // page of "No active agents".
      PRESENCE_TEST_DB: DB,
    },
  });
  const out =
    new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  // The scratch root carries a random suffix, so leaving it in would make every
  // regeneration a whole-file diff and hide the change that actually mattered.
  //
  // Obligation and clearance ids are minted with `randomUUID` inside the store,
  // so they cannot be seeded deterministically the way session ids can. The
  // SHAPE is what a reader needs — eight hex characters they would copy into
  // `crew obligation <id>` — so each distinct id maps to a stable placeholder
  // in first-seen order. Without this every run rewrote the whole file.
  return out
    .split(root)
    .join("/tmp/project")
    .split(root.split("/").pop() ?? "")
    .join("project")
    // FULL UUIDS FIRST, then bare 8-character prefixes — `injection` prints the
    // whole id while `obligations` prints only the head, and normalising the
    // head alone left the tail varying every run.
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      // KEYED ON THE FIRST 8 CHARACTERS, which is what the short form prints,
      // so `obligations` and `injection` name the same obligation identically.
      (uuid) => placeholder(uuid.slice(0, 8)),
    )
    .replace(/\b[0-9a-f]{8}\b/g, (hex) => {
      if (!stableIds.has(hex))
        stableIds.set(hex, `id${String(stableIds.size + 1).padStart(6, "0")}`);
      return stableIds.get(hex) ?? hex;
    })
    .trimEnd();
}

seed();

const blocks: string[] = [
  "",
  "> Generated by `test/tools/capture-audiences.ts` against a throwaway store.",
  "> **Block order is execution order**, by construction — the previous hand-",
  "> collated version mixed captures from different moments, and a careful",
  "> reader inferred two defects from it that did not exist.",
  "",
];

for (const capture of SCRIPT) {
  blocks.push(`### ${capture.heading}`, "", capture.why, "", "```");
  for (const args of capture.runs) {
    blocks.push(`$ crew ${args.join(" ")}`);
    const out = run(args);
    blocks.push(out === "" ? "(no output)" : out, "");
  }
  blocks.push("```", "");
}

const covered = new Set(SCRIPT.flatMap((c) => c.runs.map((r) => r[0])));
const uncovered = VERBS.filter((v) => v.hidden !== true && !covered.has(v.verb));
if (uncovered.length > 0) {
  // NAMED, NEVER SILENT. A capture set that quietly skips verbs reads as
  // complete; `plans/README.md` opens with what that costs.
  blocks.push(
    "### Not captured",
    "",
    `${uncovered.length} verb(s) mutate shared state or need a second live ` +
      "session, so they are exercised by the test suite rather than here:",
    "",
    uncovered.map((v) => `\`${v.verb}\``).join(", "),
    "",
  );
}

const src = await Bun.file(DOC).text();
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end < start) {
  console.error(`markers not found in ${DOC} — expected ${START} … ${END}`);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}
await Bun.write(
  DOC,
  src.slice(0, start + START.length) +
    "\n" +
    blocks.join("\n").trimEnd() +
    "\n\n" +
    src.slice(end),
);
rmSync(root, { recursive: true, force: true });
console.log(
  `captured ${SCRIPT.reduce((n, c) => n + c.runs.length, 0)} runs; ` +
    `${uncovered.length} verb(s) listed as not captured`,
);
