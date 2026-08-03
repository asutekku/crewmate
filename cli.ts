/**
 * Human-facing view of the presence store, and a way to post into it by hand.
 *
 *   bun cli.ts who               # roster + claims        [--raw] for typeable names
 *   bun cli.ts log [n]           # recent messages       [--raw]
 *   bun cli.ts msg <name> "..."  # send to ONE agent  [--from <name>]
 *   bun cli.ts say <text>        # broadcast to every agent
 *   bun cli.ts clear             # wipe roster
 *   bun cli.ts where             # which project/db this directory maps to
 *   bun cli.ts call-me <name>    # name yourself  [--agent <who>] to rename another
 *   bun cli.ts call-you "<role>" # what you ARE, for the operator's roster
 *   bun cli.ts files <agent>     # every file they have touched  [--hours 24]
 *   bun cli.ts blame <path>      # who has been in this file, newest first
 *
 * And the diary — findings agents leave for each other, which OUTLIVE the
 * board and are shared by every worktree of this repo:
 *
 *   bun cli.ts note "<title>" --topic <t> [--body "…"] [--tags a,b]
 *                             [--kind finding|warning|error|optimization]
 *                             [--scope src/sim/water]
 *   bun cli.ts note <id>         # one entry in full, body included
 *   bun cli.ts recall <query>    # search  [--topic] [--tag] [--kind]
 *                                #         [--scope] [--mine] [--all]
 *   bun cli.ts topics [--stale]  # what exists, counts, last write
 *   bun cli.ts topic <name>      # everything under one topic
 *   bun cli.ts tags              # tag cloud
 *
 * And the work board — what each agent is doing, as a timeline:
 *
 *   bun cli.ts doing "<subject>" [--plan "a; b; c"]   # open an item
 *   bun cli.ts did <n> ["<what changed>"]             # tick step n off
 *   bun cli.ts step <n> "<status>"                    # in progress, not finished
 *   bun cli.ts add "<step>"                           # a phase the plan missed
 *   bun cli.ts breaks "<what>" [--item <match>]       # …and tell affected peers
 *   bun cli.ts needs  "<what>" [--item <match>]       # a blocker, for the board
 *   bun cli.ts done [<subject match>] [--abandoned]   # close ONE item
 *   bun cli.ts board [<agent>] [--history] [--all]    # read the board  [--raw]
 *   bun cli.ts mine                                   # my open items
 *
 * Commits attach themselves (`PostToolUse` on Bash), and an agent that never
 * runs `doing` still gets a placeholder row from its conversation title.
 *
 * The project is resolved from the CWD exactly as the hooks resolve it, so
 * running this from any worktree reads that repo's roster.
 *
 * `say` exists because you are the only participant who can see all four
 * sessions at once; it is how you tell them something without retyping it four
 * times. It posts under a fixed handle so agents can tell it from a peer.
 */

import type { Session, Store } from "./core/store.ts";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ActorRef, ObligationEvent, StructuredActInput } from "./core/obligations.ts";
import {
  agoText,
  claimName,
  displayName,
  operatorNames,
  rosterName,
  withStore,
} from "./core/store.ts";
import { featureForVerb, helpFeatures } from "./core/features.ts";
import {
  baseBranch,
  baseDistance,
  currentBranch,
  installedVersion,
  resolveProject,
  worktreeRoot,
} from "./core/repo.ts";
import { baseStalenessLines } from "./core/shared.ts";
import { pack } from "./core/injection.ts";
// One source with the hook: see core/sessionBlock.ts for why it is not in the
// hook module itself. Rebuilding the list here would drift from what ships.
import { sessionEnvelope } from "./core/sessionBlock.ts";
import { listAgents } from "./core/agents.ts";
import { refreshSummary, SUMMARY_TTL_MS } from "./core/summary.ts";
import {
  backgroundProcesses,
  fit,
  pad,
  renderFileLine,
  shortAge,
  summarizeFiles,
  terminalWidth,
  wrap,
} from "./core/layout.ts";
import {
  agentKey,
  BOARD_OPEN_SHOWN,
  foldEvents,
  normalisePlanPath,
  parsePlan,
  progress,
} from "./core/work.ts";
import { validateAlias, validateRole } from "./core/topic.ts";
import { loadConfig } from "./core/config.ts";
import { discipleName, minionName } from "./core/names.ts";
import { usage, usageFor } from "./core/verbs.ts";
import { checkNote, nearTopic, parseTags } from "./core/diary.ts";
import { checkMemory, lineageKey, withPersonal } from "./core/personal.ts";
import type { DiaryEntry, DiaryKind } from "./core/diary.ts";
import { dirtyFiles } from "./core/dirty.ts";
import { sizeText, spanText, usageFlag } from "./core/stats.ts";
import { agentTally, briefAge, briefAgo, itemLines } from "./core/board.ts";
import type { BoardPaint } from "./core/board.ts";
import {
  activityColour,
  bold,
  cyan,
  dim,
  green,
  handleColour,
  red,
  rosterColours,
  yellow,
} from "./core/colour.ts";

const HUMAN_HANDLE = "human";

/**
 * The summary worker resolved beside THIS file. `import.meta.dir` so the
 * installed copy under `~/.claude/agent-presence/bin/` spawns its own, not
 * the source tree's.
 */
function summaryWorkerPath(): string {
  return `${import.meta.dir}/core/summarize-worker.ts`;
}

/**
 * Set by Claude Code in every process it spawns, so an agent shelling out to
 * this CLI identifies itself without being asked to.
 *
 * WHY THIS IS NOT LEFT TO `--from`: an optional flag that an agent must
 * remember to pass fails silently and forges the operator. Live, traffic-4b
 * replied to a direct question without it; the message stored as `human` and
 * reached its recipient reading `human to traffic-c9`, so the agent had typed
 * "traffic-4b:" into the body by hand to say who it was. Provenance cannot
 * depend on remembering a flag — the environment already knows.
 */
const ENV_SESSION = process.env["CLAUDE_CODE_SESSION_ID"] ?? "";

/**
 * Resolved from the CWD, so running this from any worktree reads that repo's
 * roster — the same key the hooks use.
 */
const PROJECT = resolveProject(process.cwd());

/**
 * The roster, built for a terminal rather than for an agent's context.
 * Does NOT colourise `formatRoster`: the two audiences want different text.
 */
function who(raw: boolean): void {
  const agents = listAgents();
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    store.pruneStale(now);
    if (agents.length > 0) store.syncAgents(agents);
    const sessions = store.liveSessions(now);
    const claims = store.allClaims(now);
    store.pruneMinions(now);
    const minions = store.liveMinions(now);
    if (sessions.length === 0) {
      console.log(dim(`No active agents in ${PROJECT.name}.`));
      return;
    }

    const trees = new Set(sessions.map((s) => s.worktree).filter((w) => w !== ""));
    const showTree = trees.size > 1;
    const counts = new Map<string, number>();
    for (const c of claims) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);

    const palette = rosterColours(sessions, (s) => displayName(s));
    const taskCounts = store.taskCounts();
    const current = installedVersion();
    const versions = store.codeVersions();
    for (const stale of store.staleSummarySessions(now, SUMMARY_TTL_MS)) {
      refreshSummary(summaryWorkerPath(), stale.sessionId, stale.path, PROJECT.dbPath);
    }
    const contestedPaths = new Set(
      [...counts]
        .filter(([, n]) => n > 1)
        .map(([p]) => p)
        .filter((p) => {
          const holders = claims.filter((c) => c.path === p);
          // Unknown (git failed) counts as contested: silence must not be the
          // default when we cannot tell.
          return holders.some((h) => {
            const dirty = dirtyFiles(h.worktree !== "" ? h.worktree : PROJECT.root);
            return dirty === null || dirty.has(h.path);
          });
        }),
    );

    const ordered = [...sessions].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    const treeCounts = new Map<string, number>();
    for (const s of ordered) treeCounts.set(s.worktree, (treeCounts.get(s.worktree) ?? 0) + 1);
    const mainTree = [...treeCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

    const groups = new Map<string, typeof ordered>();
    for (const s of ordered) {
      const key = showTree && s.worktree !== mainTree ? s.worktree : "";
      const group = groups.get(key);
      if (group) group.push(s);
      else groups.set(key, [s]);
    }
    const sortedGroups = [...groups].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : 0));

    const width = terminalWidth();
    const nameW = Math.min(
      34,
      Math.max(...ordered.map((s) => [...(raw ? displayName(s) : rosterName(s))].length)),
    );
    const AGE_W = 4;
    const gutter = 2 + 1 + 1 + nameW + 1 + AGE_W + 2;
    const descW = Math.max(20, width - gutter - 1);

    const behind = ordered.filter((s) => {
      const ver = versions.get(s.sessionId) ?? "";
      return current !== "" && ver !== "" && ver !== current;
    });
    const treeNote = treeCounts.size > 1 ? ` · ${treeCounts.size} trees` : "";
    console.log(bold(`${sessions.length} agents in ${PROJECT.name}${dim(treeNote)}`));
    if (behind.length > 0) {
      const which = behind.length === ordered.length ? "all" : `${behind.length}`;
      console.log(dim(`  ⟲ ${which} running older hooks — restart to pick up changes`));
    }

    for (const [tree, group] of sortedGroups) {
      console.log("");
      if (tree !== "") {
        const leaf = tree.split("/").pop() ?? tree;
        const branch = group[0]?.branch ?? "";
        console.log(dim(`  worktree ${leaf}${branch !== "" ? ` (${branch})` : ""}`));
      }
      for (const s of group) {
        const paint = palette.get(displayName(s)) ?? handleColour(s.handle);
        const mark = s.blocked !== "" ? red("●") : s.status === "busy" ? green("●") : dim("○");
        const seen = activityColour(now - s.lastSeenMs)(pad(shortAge(s.lastSeenMs, now), AGE_W));
        const t = taskCounts.get(s.sessionId);
        const prog = t && t.open + t.done > 0 ? dim(` [${t.done}/${t.open + t.done}]`) : "";

        const headline = s.title !== "" ? s.title : s.intent;
        const desc =
          headline !== ""
            ? fit(headline, descW - [...prog].length)
            : dim(fit("(no stated task)", descW));
        const shown = raw ? displayName(s) : rosterName(s);
        console.log(`  ${mark} ${paint(bold(pad(fit(shown, nameW), nameW)))} ${seen}  ${desc}${prog}`);

        if (s.blocked !== "") console.log(`${" ".repeat(gutter)}${red(fit(s.blocked, descW))}`);
        if (s.summary !== "") console.log(`${" ".repeat(gutter)}${cyan(fit(s.summary, descW))}`);

        const mySpawn = minions.get(s.sessionId) ?? [];
        const labels = mySpawn.map((m) =>
          raw ? `${displayName(s)}#${m.seq}` : minionName(displayName(s), m.seq),
        );
        const labelW = Math.max(0, ...labels.map((l) => [...l].length));
        for (const [i, m] of mySpawn.entries()) {
          const what = m.task !== "" ? m.task : m.agentType !== "" ? m.agentType : "(running)";
          console.log(
            `${" ".repeat(gutter - 2)}${dim("↳")} ${paint(pad(labels[i] ?? "", labelW))} ${dim(fit(what, Math.max(12, descW - labelW - 1)))}`,
          );
        }

        const mine = claims.filter((c) => c.handle === s.handle).map((c) => c.path);
        if (mine.length === 0) continue;
        const pieces = summarizeFiles(mine, { contested: contestedPaths });
        if (pieces.length === 0) continue;
        const line = renderFileLine(pieces, descW - 2, { contested: red, normal: dim });
        if (line === "") continue;
        console.log(`${" ".repeat(gutter)}${dim("✎")} ${line}`);
      }
    }

    const contested = [...contestedPaths].map((path) => {
      const holders = claims.filter((c) => c.path === path);
      const trees = new Set(holders.map((c) => c.worktree));
      return { path, holders, sameTree: trees.size === 1 };
    });
    const sameTree = contested.filter((c) => c.sameTree);
    const crossTree = contested.filter((c) => !c.sameTree);

    const show = (
      group: typeof contested,
      paint: (s: string) => string,
      note: string,
    ): void => {
      for (const { path, holders } of group) {
        // Two lines rather than one: path, then holders indented under it. The
        // single-line form reached 103 characters and wrapped, which put the
        // agent names on a ragged continuation exactly where the eye is looking
        // for them.
        const who = holders.map((c) => handleColour(c.handle)(claimName(c)));
        console.log(`    ${paint(fit(path, width - 6))}`);
        console.log(`      ${who.join(dim(", "))} ${dim(note)}`);
      }
    };

    // Processes with no roster row: a closed terminal leaves `claude.exe`
    // running, and nothing else in the system reports them. Listed rather than
    // acted on — see `quit` for why nothing here is ever killed.
    const known = new Set(sessions.map((s) => s.sessionId));
    // Only when the sample SUCCEEDED: an empty `agents --json` (an old CLI, a
    // timeout) would otherwise read as "every process is a stray".
    const background = agents.length > 0 ? backgroundProcesses(agents, known, PROJECT.root) : [];
    if (background.length > 0) {
      console.log();
      console.log(
        dim(`${background.length} background process(es) — no window, not on the roster:`),
      );
      for (const b of background.slice(0, 8)) {
        const age = b.startedAtMs > 0 ? agoText(b.startedAtMs, now) : "unknown";
        const leaf = b.cwd === PROJECT.root ? "" : ` ${b.cwd.split("/").pop() ?? ""}`;
        console.log(dim(`    pid ${String(b.pid).padEnd(7)} ${b.name || "(unnamed)"}${leaf}  started ${age}`));
      }
      if (background.length > 8) console.log(dim(`    … ${background.length - 8} more`));
    }

    if (sameTree.length > 0) {
      console.log();
      console.log(red(`⚠ ${sameTree.length} file(s) held by two agents in ONE tree:`));
      show(sameTree, (s) => s, "— uncommitted work would collide");
    }
    if (crossTree.length > 0) {
      console.log();
      console.log(dim(`${crossTree.length} file(s) edited in separate worktrees:`));
      show(crossTree, dim, "— different checkouts, merge later");
    }
  });
}

/**
 * The message log. Deliberate messages (`say`, `note`) are shown in full colour
 * with a `from → to` arrow; the agents' own bookkeeping is dimmed, because when
 * you are scanning for what was actually said, claims are background.
 */
function log(limit: number, raw: boolean): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const msgs = store.recent(limit);
    if (msgs.length === 0) {
      console.log(dim("Log is empty."));
      return;
    }
    // Sender names are FROZEN at send time, so the log holds `terrain-perf` and
    // has no session to resolve. Mapping them through the live roster is what
    // stops one agent reading as three different people across who/log/board.
    const show = raw ? (n: string) => n : operatorNames(store.liveSessions(now));
    for (const m of msgs) {
      // Right-aligned and bracket-free: `[1m ago]` reads as a stray ANSI code
      // (ESC[1m is bold), which is genuinely confusing in a colourised log.
      const when = dim(agoText(m.tsMs, now).padStart(9));
      const paint = handleColour(m.from);
      if (m.kind === "note") {
        console.log(`${when} ${yellow(bold("you → everyone"))}: ${m.body}`);
      } else if (m.kind === "say") {
        // The arrow is the point of this view: who spoke, and to whom.
        const to = m.to !== "" ? bold(handleColour(m.to)(show(m.to))) : dim("everyone");
        console.log(`${when} ${paint(bold(show(m.from)))} ${dim("→")} ${to}: ${m.body}`);
      } else if (m.kind === "claim") {
        console.log(`${when} ${paint(show(m.from))} ${red("claim")} ${dim(m.body)}`);
      } else {
        console.log(`${when} ${paint(show(m.from))} ${dim(`${m.kind}: ${m.body}`)}`);
      }
    }
  });
}

/**
 * Broadcast to every agent. An agent calling this speaks as ITSELF, not as you:
 * `note` carries the operator's words and outranks peer text, so a session
 * posting one could issue instructions in your voice.
 */
function say(text: string): void {
  const from = withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const self = ENV_SESSION !== "" ? store.findBySession(ENV_SESSION) : null;
    if (ENV_SESSION !== "" && !self) {
      const handle = store.handleForOrRegister(ENV_SESSION, PROJECT.root, "", now);
      store.post(handle, "say", text, now);
      return handle;
    }
    if (self) {
      store.post(self.handle, "say", text, now);
      return displayName(self);
    }
    store.post(HUMAN_HANDLE, "note", text, now);
    return null;
  });
  const who = from === null ? "you" : from;
  console.log(`${yellow("broadcast")} to ${bold(PROJECT.name)} ${dim(`as ${who}`)}: ${text}`);
  console.log(dim(`Every agent sees this on its next turn, marked as from ${who}.`));
}

/**
 * Sends to ONE agent. `--from <name>` lets a session send as itself; without it
 * the message is from you, the operator. Delivery is scoped, not secret.
 */
function msg(target: string, text: string, from: string | undefined): void {
  const result = withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const to = store.findByName(target, now);
    if (!to) return { ok: false as const, live: store.liveSessions(now) };

    let handle = HUMAN_HANDLE;
    let fromLabel = "you";
    if (from !== undefined) {
      const sender = store.findByName(from, now);
      if (!sender) return { ok: false as const, live: store.liveSessions(now), badFrom: true };
      handle = sender.handle;
      fromLabel = displayName(sender);
    } else if (ENV_SESSION !== "") {
      const self = store.findBySession(ENV_SESSION);
      handle = self ? self.handle : store.handleForOrRegister(ENV_SESSION, PROJECT.root, "", now);
      fromLabel = self ? displayName(self) : handle;
    }
    store.post(handle, "say", text, now, { sessionId: to.sessionId, name: displayName(to) });
    return { ok: true as const, to, fromLabel };
  });

  if (!result.ok) {
    const what = result.badFrom ? `sender "${from}"` : `agent "${target}"`;
    console.error(red(`No live ${what} in ${PROJECT.name}.`));
    if (result.live.length > 0) {
      console.error(dim("Live agents: ") + result.live.map((s) => displayName(s)).join(", "));
    }
    process.exit(1);
  }
  const state = result.to.status === "busy" ? " (busy — will see it after this turn)" : "";
  console.log(`${cyan(result.fromLabel)} ${dim("→")} ${bold(displayName(result.to))}: ${text}`);
  console.log(dim(`Delivered on their next turn${state}.`));
}

function clear(): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    for (const s of store.liveSessions(now)) store.unregister(s.sessionId);
  });
  console.log("Cleared sessions and claims. " + dim("(Message log is kept; it self-prunes.)"));
}

/**
 * Where this session is, including how far its checkout has drifted.
 *
 * NO THRESHOLD HERE, unlike the session-start line: `where` was asked a direct
 * question, and a verb that withholds a fact because it judged it small is one
 * that has to be double-checked.
 */
function where(): void {
  const note = PROJECT.isGit ? "" : dim("  (no git repo — keyed on directory)");
  console.log(`${dim("project:")} ${bold(PROJECT.name)}`);
  console.log(`${dim("key:    ")} ${cyan(PROJECT.key)}${note}`);
  console.log(`${dim("root:   ")} ${PROJECT.root}`);
  console.log(`${dim("db:     ")} ${PROJECT.dbPath}`);
  if (!PROJECT.isGit) return;

  const cwd = process.cwd();
  const tree = worktreeRoot(cwd);
  const inWorktree = tree !== PROJECT.root;
  console.log(`${dim("tree:   ")} ${tree}${inWorktree ? "" : dim("  (main tree)")}`);
  const branch = currentBranch(cwd);
  if (branch !== "") console.log(`${dim("branch: ")} ${branch}`);
  const base = baseBranch(cwd);
  if (!inWorktree && branch === base) return;
  const distance = baseDistance(cwd, base);
  if (base === "" || distance === null) {
    console.log(`${dim("base:   ")} ${dim("unknown")}`);
    return;
  }
  const own = distance.ahead > 0 ? `${distance.ahead} of its own` : "nothing of its own";
  const drift =
    distance.behind === 0 ? `up to date with ${base}` : `${distance.behind} behind ${base}`;
  console.log(`${dim("base:   ")} ${drift}, ${own}`);
}


/**
 * Which session a report is ABOUT, stated rather than assumed.
 * Calls the SAME builder the hook calls, so this reports the real envelope
 * rather than a reimplementation that drifts from it.
 */
function resolveSubject(store: Store, nowMs: number, args: readonly string[]): Session {
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : "";
  };
  const live = store.liveSessions(nowMs);

  // EXPLICIT BEATS AMBIENT. The env var used to win, which meant an agent
  // running inside a session could not inspect a peer at all: `--agent adela`
  // was read, then silently discarded in favour of the caller's own id.
  const wanted = flag("--session");
  if (wanted !== "") {
    // VALIDATED, not trusted. An unknown id produced a fully plausible report
    // about nobody: `(unregistered)`, every session counted as a peer, no
    // suppression state, and the caller's own worktree.
    const hit = live.find((s) => s.sessionId === wanted);
    if (hit) return hit;
    console.log(red(`no live session with id ${wanted}`));
    process.exit(1);
  }

  const named = flag("--agent").toLowerCase();
  if (named !== "") {
    const hit = live.find((s) => displayName(s).toLowerCase() === named || s.handle === named);
    if (hit) return hit;
    console.log(red(`no live session named ${named}`));
    process.exit(1);
  }

  const fromEnv = process.env["CLAUDE_CODE_SESSION_ID"] ?? "";
  if (fromEnv !== "") {
    const hit = live.find((s) => s.sessionId === fromEnv);
    if (hit) return hit;
    console.log(red("this session is not on the roster") + dim(" — pass --agent <name>"));
    process.exit(1);
  }

  // Unambiguous only when there is one candidate. Guessing among several would
  // report on an arbitrary agent and look authoritative doing it.
  if (live.length === 1 && live[0]) return live[0];
  console.log(
    red("cannot tell which session to report on") +
      dim(` — pass --agent <name> or --session <id> (${live.length} live)`),
  );
  process.exit(1);
}

/**
 * What did not fit in the session-start block. THE OTHER HALF OF A PROMISE THE
 * BLOCK MAKES: nothing an agent is expected to act on can vanish silently.
 */
function inbox(args: readonly string[]): void {
  withStore(PROJECT.dbPath, (store) => {
    const owed = store.injectionOmissions(resolveSubject(store, Date.now(), args).sessionId);
    if (owed.length === 0) {
      console.log(dim("nothing was omitted from your session-start context"));
      return;
    }
    console.log(bold(`${owed.length} item(s) omitted for length:\n`));
    for (const o of owed) {
      console.log(`${bold(o.key)} ${dim(`(${o.reason})`)}`);
      console.log(`${o.text}\n`);
    }
  });
}

function injection(args: readonly string[]): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const self = resolveSubject(store, now, args);
    const sessionId = self.sessionId;
    const me = displayName(self);

    // THE SUBJECT'S WORKTREE, NOT THE CALLER'S. These were read from
    // `process.cwd()` before the subject was even resolved, so inspecting a
    // peer in another checkout spliced that peer's identity and exposure onto
    // this terminal's git state — a report of a block nobody received.
    const subjectCwd = self.worktree !== "" ? self.worktree : process.cwd().replace(/\\/g, "/");
    const tree = worktreeRoot(subjectCwd);
    const inWorktree = PROJECT.isGit && tree !== PROJECT.root;
    const base = inWorktree ? baseBranch(subjectCwd) : "";
    const distance = inWorktree ? baseDistance(subjectCwd, base) : null;

    const env = sessionEnvelope(store, {
      me,
      projectName: PROJECT.name,
      sessionId,
      tree,
      now,
      staleness: baseStalenessLines(distance, base, inWorktree),
      lineageFrom: self.lineageFrom,
    });
    // The SAME suppression state the hook would read, or the report describes a
    // block nobody would ever be sent.
    const packed = pack(env, store.injectionExposures(sessionId));

    // WHOSE block this is. Without it a report run by hand looks like it
    // describes the reader, and the numbers quietly belong to someone else.
    console.log(`${dim("recipient")} ${me} ${dim(sessionId.slice(0, 8))}`);
    console.log(bold("\nmandatory"));
    for (const line of env.mandatoryHeader.filter((l) => l !== "")) {
      console.log(`  ${green("✓")} ${dim(clip(line))} ${dim(`${line.length}`)}`);
    }
    const framed = packed.selected.some((s) => s.candidate.requiresPeerFraming);
    for (const line of env.peerFraming) {
      const mark = framed ? green("✓") : dim("–");
      const why = framed ? "" : dim(" (no peer text selected)");
      console.log(`  ${mark} ${dim(clip(line))} ${dim(`${line.length}`)}${why}`);
    }

    console.log(bold("\nselected"));
    if (packed.selected.length === 0) console.log(dim("  nothing"));
    for (const s of packed.selected) {
      const form = s.form === "compact" ? yellow(" compact") : "";
      console.log(
        `  ${green("✓")} ${s.candidate.key.padEnd(18)} ${dim(`p${s.candidate.priority}`)}` +
          ` ${dim(`${s.text.length}`)}${form}`,
      );
    }

    console.log(bold("\nomitted"));
    if (packed.omitted.length === 0) console.log(dim("  nothing"));
    for (const o of packed.omitted) {
      console.log(
        `  ${dim("–")} ${o.candidate.key.padEnd(18)} ${dim(`p${o.candidate.priority}`)}` +
          ` ${red(o.reason)}`,
      );
    }

    // WHAT WAS ACTUALLY DELIVERED, as opposed to everything above it — which is
    // a block recomputed from current state, i.e. what this session WOULD get
    // now. Debugging "why did that agent not know about X" needs the delivery,
    // and state has usually moved by the time anybody asks.
    const history = store.injectionHistory(sessionId, 40);
    if (history.length > 0) {
      // Grouped by DELIVERY, not timestamp: two hook runs inside one
      // millisecond would otherwise merge into a block that never existed.
      const last = history[0]?.deliveryId ?? 0;
      const latest = history.filter((h) => h.deliveryId === last);
      // The delivery's TIMESTAMP, not its id — grouping and age are different
      // questions and an id read as a clock renders an absurd age.
      console.log(bold(`\nlast delivered ${dim(briefAgo(latest[0]?.tsMs ?? now, now))}`));
      for (const h of latest) {
        const mark = h.outcome === "selected" ? green("✓") : dim("–");
        const tail =
          h.outcome === "selected"
            ? `${h.form === "compact" ? yellow(" compact") : ""} ${dim(`${h.chars}`)}`
            : ` ${red(h.reason)}`;
        console.log(`  ${mark} ${h.key.padEnd(18)} ${dim(`p${h.priority}`)}${tail}`);
      }
      const deliveries = new Set(history.map((h) => h.deliveryId)).size;
      if (deliveries > 1) console.log(dim(`  (${deliveries} deliveries in history)`));
    }

    console.log(bold("\nbudget"));
    console.log(`  ${dim("target  ")} ${env.targetChars}`);
    console.log(`  ${dim("rendered")} ${packed.renderedChars}`);
    console.log(`  ${dim("reserved")} ${packed.reservedChars} ${dim("(header + framing)")}`);
    // Stated rather than implied: `targetChars` is what CANDIDATES compete for,
    // and the header is allowed to exceed it. A reader comparing the two
    // numbers deserves to be told that is by design.
    if (packed.mandatoryOverflow) {
      console.log(
        `  ${red("mandatory overflow")} — the header alone exceeds the target and renders anyway`,
      );
    }
  });
}

/** One line's worth, so a 700-char paragraph does not own the report. */
function clip(text: string, max = 52): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * What this tool has actually accumulated, and which of its features are dead.
 *
 * A DIAGNOSTIC, NOT A DASHBOARD. It exists because answering "how much is in
 * here?" previously meant hand-written SQL against a db filename you had to
 * guess, and two of six such attempts failed — one on the path, one on a column
 * that does not exist. Every number below was reachable before; none of it was
 * reachable without guessing.
 *
 * The unused flags are the point. A feature with no rows has never been used by
 * anybody, which is the only evidence that can retire it — and it is invisible
 * from inside a session, where every feature looks equally available.
 */
function stats(): void {
  // Counted separately because personal memories are the one store that is NOT
  // per-project: `personal.db` sits beside every project db rather than inside
  // one. A missing file reads as zero, never as a crash — an agent that has
  // never run `remember` has no such db, and that is a valid answer.
  let memories = 0;
  try {
    memories = withPersonal((personal) => personal.count());
  } catch {
    memories = 0;
  }

  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const s = store.stats(memories);

    console.log(bold("store"));
    console.log(`  ${dim("project")}  ${PROJECT.name}`);
    console.log(`  ${dim("db     ")}  ${PROJECT.dbPath}`);
    console.log(`  ${dim("size   ")}  ${sizeText(dbBytes(PROJECT.dbPath))}`);

    // ABOVE THE TABLES, NOT BELOW THEM. Everything that follows is one
    // operator's sample, and a number read without its window becomes a
    // property of the system — which is how "peak 5 agents in 14 hours" got
    // quoted as a ceiling on what the tool should support. A footnote is read
    // second and quoted never, so the window goes first.
    console.log(bold("\nsample"));
    if (s.sample.activeHours === 0) {
      console.log(dim("  no activity recorded"));
    } else {
      console.log(
        `  ${dim("window ")} ${s.sample.activeHours} active hours` +
          ` over ${spanText(0, s.sample.spanMs)}`,
      );
      console.log(
        dim("  a low count here measures this sample, not what the tool supports:"),
      );
      console.log(dim("  feature age and whether agents were told it exists are NOT recorded."));
    }

    console.log(bold("\nrows"));
    const widest = s.tables.reduce((w, t) => Math.max(w, t.table.length), 0);
    for (const t of s.tables) {
      console.log(`  ${t.table.padEnd(widest)}  ${String(t.rows).padStart(6)}`);
    }

    // The four disagree, and the disagreement is what the section is for: every
    // agent edits, a fraction ever message, fewer open work, fewer still write
    // a finding. One number would have to pick a source and be wrong elsewhere.
    console.log(bold("\nagents seen"));
    console.log(`  ${dim("by edits   ")} ${s.agents.edits}`);
    // Marked inline because the gap between this and `by edits` reads as name
    // churn and is not: `handle` keeps every session that ever spoke, including
    // those swept at 90 minutes, so it is cumulative where the others are live.
    console.log(
      `  ${dim("by messages")} ${s.agents.messages}` +
        ` ${dim("(cumulative — keeps swept sessions; not comparable to edits)")}`,
    );
    console.log(`  ${dim("by work    ")} ${s.agents.work}`);
    console.log(`  ${dim("by diary   ")} ${s.agents.diary}`);

    if (s.activity.length > 0) {
      console.log(bold("\nbusiest agents"));
      const nameCol = s.activity.reduce((w, a) => Math.max(w, a.agent.length), 0);
      for (const a of s.activity) {
        const span = spanText(a.firstMs, a.lastMs);
        console.log(
          `  ${handleColour(a.agent)(a.agent.padEnd(nameCol))}` +
            `  ${String(a.edits).padStart(5)} edits` +
            `  ${dim(`lived ${span.padStart(6)}`)}` +
            `  ${dim(`last ${briefAgo(a.lastMs, now)}`)}`,
        );
      }
    }

    // THE NUMBER THIS COMMAND IS MOST WORTH RUNNING FOR. Much of the tool is
    // built for a crowd; whether the crowd ever existed is only answerable
    // from history, and it decides whether the next crowd feature is worth it.
    console.log(bold("\nconcurrency"));
    if (s.concurrency.activeHours === 0) {
      console.log(dim("  no edits recorded"));
    } else {
      for (const b of s.concurrency.buckets) {
        const label = `${b.agents} agent${b.agents === 1 ? "" : "s"}`;
        const hours = `${b.hours} hour${b.hours === 1 ? "" : "s"}`;
        console.log(`  ${label.padEnd(9)} ${hours}`);
      }
      console.log(
        dim(`  ${s.concurrency.activeHours} active hours, peak ${s.concurrency.peak} at once`),
      );
      // The one number most likely to be quoted out of its window, and the one
      // that was: co-presence is bounded by how many sessions the operator ran,
      // which is a budget, not a property of the design.
      console.log(dim("  bounded by how many sessions were run, not by what the tool supports"));
    }

    console.log(bold("\nmessages"));
    if (s.messages.byKind.length === 0) {
      console.log(dim("  none"));
    } else {
      const kindCol = s.messages.byKind.reduce((w, k) => Math.max(w, k.kind.length), 0);
      for (const k of s.messages.byKind) {
        console.log(`  ${k.kind.padEnd(kindCol)}  ${String(k.count).padStart(5)}`);
      }
      console.log(
        dim(`  say: ${s.messages.directedSays} directed, ${s.messages.broadcastSays} broadcast`),
      );
    }

    console.log(bold("\nfeature usage"));
    const featCol = s.features.reduce((w, f) => Math.max(w, f.feature.length), 0);
    for (const f of s.features) {
      const flag = usageFlag(f.rows, f.exposure.opportunities);
      // Dim, not red. Red reads as a fault, and a zero here is an OBSERVATION
      // with an unknown cause — the feature may be new, or never surfaced to a
      // single session. It is still the row a reader came for, so it carries
      // the longest label in the table; it just does not carry an alarm.
      const tail = flag !== "" ? ` ${dim(flag)}` : f.detail !== "" ? ` ${dim(f.detail)}` : "";
      console.log(`  ${f.feature.padEnd(featCol)}  ${String(f.rows).padStart(6)}${tail}`);
      console.log(dim(`    availability ${f.availability.observations}/${f.availability.opportunities}  exposure ${f.exposure.observations}/${f.exposure.opportunities}  use ${f.use.observations}/${f.use.opportunities}`));
      if(f.exposure.surfaces.length>0)console.log(dim(`    surfaces ${f.exposure.surfaces.map(x=>`${x.surface}:${x.observations}/${x.sessions}`).join("  ")}`));
    }
  });
}

/**
 * The db plus its WAL sidecars — real bytes on disk, and the WAL can dwarf the
 * db itself between checkpoints.
 *
 * `Bun.file().size` reads 0 for a file that is not there, so an absent sidecar
 * needs no guard: WAL is checkpointed away on a clean close, and its absence is
 * the normal case rather than an error.
 */
function dbBytes(path: string): number {
  return ["", "-wal", "-shm"].reduce((total, suffix) => total + Bun.file(path + suffix).size, 0);
}

/**
 * Every file an agent has touched — the context behind an overlap warning.
 *
 * The warning names ONE file, which is the one you were about to edit. This
 * answers the question that follows: what else are they in, and is my change
 * going to meet theirs somewhere I have not looked yet?
 *
 * Reads the edit HISTORY, not live claims, so it still answers after that agent
 * has exited — measured: a session ended mid-conversation here and its six
 * claims vanished with it, leaving no record it had been in the file at all.
 */
function filesOf(target: string, hours: number): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const sinceMs = now - hours * 60 * 60 * 1000;
    // A live session first, then anyone in the edit history — an agent that has
    // GONE is exactly the one you want to ask about, and it has no roster row.
    const live = store.findByName(target, now);
    const past = store.editAgents(sinceMs);
    const q = target.toLowerCase();
    const historical = past.find(
      (a) => a.agent.toLowerCase() === q || a.agent.toLowerCase().startsWith(q),
    );
    const sessionId = live?.sessionId ?? historical?.sessionId ?? "";
    const name = live ? displayName(live) : (historical?.agent ?? "");
    if (sessionId === "") {
      console.error(`no agent named ${bold(target)} has edited anything in ${hours}h`);
      const seen = [...new Set(past.map((a) => a.agent))].slice(0, 8);
      if (seen.length > 0) console.error(dim(`  seen recently: ${seen.join(", ")}`));
      process.exitCode = 1;
      return;
    }
    const edits = store.editsBy(sessionId, sinceMs);
    if (edits.length === 0) {
      console.log(dim(`${name} has edited nothing in the last ${hours}h.`));
      return;
    }

    const width = terminalWidth();
    const gone = live === null ? dim("  (session ended — this is history)") : "";
    console.log(`${bold(handleColour(name)(name))} ${dim(`— ${edits.length} file(s) in ${hours}h`)}${gone}`);
    // Their open work says WHY, which is the half a file list cannot carry.
    for (const item of store.work.openItems(agentKey("", sessionId))) {
      const p = progress(store.work.steps(item.workId));
      const count = p.total > 0 ? ` ${p.done}/${p.total}` : "";
      console.log(`  ${cyan("▸")} ${item.subject}${dim(count)}`);
      if (p.current) console.log(`    ${dim("now")}  ${p.current.text}`);
    }
    const trees = new Set(edits.map((e) => e.worktree).filter((w) => w !== ""));
    for (const e of edits) {
      const when = dim(briefAgo(e.tsMs, now).padStart(9));
      const times = e.count > 1 ? dim(` ×${e.count}`) : "";
      // The tree is only worth printing when they worked in more than one.
      const tree = trees.size > 1 && e.worktree !== "" ? dim(` [${e.worktree.split("/").pop()}]`) : "";
      console.log(`  ${when}  ${fit(e.path, width - 26)}${times}${tree}`);
    }
  });
}

/**
 * Who has touched a file — blame at file granularity.
 *
 * Git cannot answer this: 95 commits landed in this repo in one day and every
 * one is authored by the same person, so `git blame` names the human and never
 * the agent. This names the agent, and the commit correlation that would turn it
 * into line granularity is P3 of the work-records plan.
 */
function blame(path: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    // Accept an absolute path, a repo-relative one, or a suffix — you will
    // usually paste whatever your editor gave you.
    const rel = path.replace(/\\/g, "/").replace(`${PROJECT.root}/`, "");
    const rows = store.editsOf(rel);
    if (rows.length === 0) {
      console.log(dim(`No recorded edits to ${rel}.`));
      console.log(dim("  Only files edited through Claude Code's tools are tracked."));
      return;
    }
    console.log(bold(rel));
    const width = terminalWidth();
    for (const r of rows) {
      const when = dim(briefAgo(r.tsMs, now).padStart(9));
      const tree = r.worktree !== "" ? dim(` [${r.worktree.split("/").pop()}]`) : "";
      const tool = r.tool !== "" ? dim(` ${r.tool}`) : "";
      const who = r.agent !== "" ? r.agent : dim(r.sessionId.slice(0, 8));
      console.log(`  ${when}  ${fit(handleColour(who)(who), width - 30)}${tool}${tree}`);
    }
  });
}

/**
 * Sets what an agent IS — its role, in words.
 *
 * The given name stays put while this moves, which is the whole point:
 * "Luna — Tooling Master" becoming "Luna — Tooling Intern" reads as a demotion
 * rather than as a stranger appearing on the roster.
 */
function callYou(role: string, target: string): void {
  const check = validateRole(role);
  if (!check.ok) {
    console.error(`${red("✗")} ${check.why}`);
    process.exitCode = 1;
    return;
  }
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const self = resolveSelf(store, target, now, "`call-you`");
    if (!self) return;
    store.setRole(self.sessionId, check.role);
    const name = displayName(self);
    // Formatted by `rosterName`, never by hand: this line built its own
    // "<role> <name>" string and so kept printing the old word order for a
    // release after the roster had moved to "<name> — <role>".
    console.log(`${green("✓")} ${bold(handleColour(name)(rosterName({ ...self, role: check.role })))}`);
    console.log(dim(`  Peers still reach them at \`${name}\` — the role is for you to read.`));
  });
}

/**
 * Renames an agent.
 *
 * A given name is assigned at registration and is usually fine; this is for
 * when it isn't — an agent that wants to be `tooling`, or an operator who finds
 * one name easier to remember than another.
 */
function callMe(name: string, target: string): void {
  const check = validateAlias(name);
  if (!check.ok) {
    console.error(`${red("✗")} ${check.why}`);
    process.exitCode = 1;
    return;
  }
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const self = resolveSelf(store, target, now, "`call-me`");
    if (!self) return;
    const was = displayName(self);
    if (store.setAlias(self.sessionId, check.alias, now) === null) {
      console.error(`${red("✗")} another live agent already answers to ${bold(check.alias)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${green("✓")} ${dim(was)} ${dim("→")} ${bold(handleColour(check.alias)(check.alias))}`);
    console.log(dim(`  Peers reach you at this name; \`msg ${check.alias} "…"\` works now.`));
  });
}

/** The agent a naming command acts on: a named one, else the caller. */
function resolveSelf(
  store: StoreHandle,
  target: string,
  nowMs: number,
  verb: string,
): ReturnType<StoreHandle["findBySession"]> {
  const self =
    target !== ""
      ? store.findByName(target, nowMs)
      : ENV_SESSION !== ""
        ? store.findBySession(ENV_SESSION)
        : null;
  if (!self) {
    if (target !== "") console.error(`no agent named ${bold(target)} in ${PROJECT.name}`);
    else {
      console.error(`${verb} acts on the agent that runs it.`);
      console.error(dim("  From a plain terminal, pass `--agent <who>`."));
    }
    process.exitCode = 1;
  }
  return self;
}

/**
 * Who is calling, as an agent identity that survives a restart.
 *
 * Returns null for a genuine terminal — no Claude session around it — because
 * the operator has no work record of their own and should be told so rather
 * than silently opening one under a synthetic key.
 */
function callerIdentity(store: StoreHandle): { agentId: string; agentName: string } | null {
  if (ENV_SESSION === "") return null;
  const self = store.findBySession(ENV_SESSION);
  // A session whose roster row was reaped is still an agent — the same reasoning
  // `say` uses. Falling back to the operator here would file its work under a
  // key no restart of that conversation could ever find again.
  const title = self?.title ?? "";
  // The HANDLE, not a slice of the session id: a work record outlives the
  // session that opened it, and `e2e-sess` on a board read next week names
  // nobody. `displayName` prefers Claude Code's own `traffic-a0` and falls back
  // to the handle, both of which a reader recognises.
  // "" rather than a slice of the session id when nothing names this session.
  // A frozen `c5ce05bc` names nobody and never will; an empty string lets the
  // READ side resolve it — from the roster if that agent comes back, and to
  // "someone" if it does not. That matters most for the diary, whose entries
  // outlive their author by a year where a board item expires in a week.
  const name = self ? displayName(self) : (store.handleFor(ENV_SESSION) ?? "");
  return { agentId: agentKey(title, ENV_SESSION), agentName: name };
}

/** `withStore`'s callback argument, named so helpers can take one. */
type StoreHandle = Parameters<Parameters<typeof withStore>[1]>[0];

/** The paint set the board uses in a terminal. */
const BOARD_PAINT: BoardPaint = { bold, dim, green, red, cyan, name: cyan };

/** Prints the "you are not an agent" refusal every write command shares. */
function notAnAgent(verb: string): void {
  console.error(`${verb} records work for the agent that runs it.`);
  console.error(
    dim("  No CLAUDE_CODE_SESSION_ID here, so there is no agent to record it against."),
  );
  console.error(dim("  Read the board with `cli.ts board`."));
  process.exitCode = 1;
}

/**
 * Opens a work item, optionally with a checklist.
 *
 * `--plan` is OPTIONAL by ruling: the agent judges whether the work has phases
 * worth tracking, and an item with no steps is a legitimate end state rather
 * than a half-filled form.
 */
function doing(subject: string, plan: string, planDoc = ""): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`doing`");
    const now = Date.now();
    const steps = parsePlan(plan);
    // The agent has said what it is doing, so the hook's guess stops earning
    // its place — two rows for one piece of work is worse than none, and this
    // subject is always better than a conversation title.
    store.work.closeAuto(me.agentId, now);
    const linkPath = normalisePlanPath(planDoc);
    const workId = store.work.open(me.agentId, me.agentName, subject, steps, now, linkPath);
    console.log(`${cyan("▸")} ${bold(subject)} ${dim(`— work #${workId}`)}`);
    for (const [i, s] of steps.entries()) console.log(`    ${dim(String(i + 1))}  ${s}`);
    if (steps.length === 0) {
      console.log(dim("    no checklist — `cli.ts add \"<step>\"` if phases appear"));
    }
    if (linkPath !== "") console.log(dim(`    executing ${linkPath}`));
    console.log(dim(`  Peers see it with \`cli.ts board\`. Close it with \`cli.ts done\`.`));
  });
}

/** Errors nobody has fixed. The diary was already a bug list; this is its state. */
function bugs(scope: string, limit: number): void {
  withStore(PROJECT.dbPath, (store) => {
    const open = store.diary.openBugs(scope, limit);
    if (open.length === 0) {
      console.log(dim(scope !== "" ? `No open bugs under ${scope}.` : "No open bugs."));
      return;
    }
    const now = Date.now();
    for (const b of open) {
      console.log(`${red("●")} ${bold(`#${b.id}`)} ${b.title}`);
      const where = b.scope !== "" ? ` ${b.scope}` : "";
      console.log(dim(`    ${b.topic}${where} — ${b.agent}, ${briefAgo(b.tsMs, now)}`));
    }
    console.log(dim(`  Close one by filing the fix: \`cli.ts note "<what fixed it>" --topic <t> --fixes <id>\``));
  });
}

/** Asks a peer something, and records that an answer is owed. */
function ask(target: string, text: string): void {
  structured(target,[{key:"question",type:"question",text}]);
  return;
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`ask`");
    const to = store.findByName(target, now);
    if (!to) {
      console.error(`no agent matching "${target}".`);
      for (const s of store.liveSessions(now)) console.error(dim(`  ${displayName(s)}`));
      process.exitCode = 1;
      return;
    }
    if (to.sessionId === ENV_SESSION) {
      // Cheap to allow and confusing to read: an agent answering itself puts a
      // question on its own board that only it can clear.
      console.error("that is you — ask a peer.");
      process.exitCode = 1;
      return;
    }
    const id = store.questions.ask(ENV_SESSION, me.agentName, to.sessionId, displayName(to), text, now);
    console.log(`${cyan("?")} asked ${bold(displayName(to))} ${dim(`— question #${id}`)}`);
    console.log(dim("  They see it at their next turn. Nothing waits for a reply."));
  });
}

/** Answers a question aimed at this session. */
function answerQuestion(idRaw: string, text: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const id = Number(idRaw);
    if (!Number.isFinite(id) || id <= 0) {
      console.error(usageFor("answer"));
      process.exitCode = 1;
      return;
    }
    const q = store.questions.get(id);
    if (!q) {
      console.error(`no question #${id}`);
      process.exitCode = 1;
      return;
    }
    if (q.targetSession !== ENV_SESSION) {
      console.error(`question #${id} was asked of ${q.targetName || "someone else"}.`);
      process.exitCode = 1;
      return;
    }
    if (!store.questions.answer(id, text, Date.now())) {
      console.error(`question #${id} is already answered.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${green("✓")} answered ${bold(q.askerName || "the asker")}`);
  });
}

/** Open questions on this session, and what it is still waiting to hear back on. */
function asks(): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    store.questions.expireStale(now, loadConfig().staleMs);
    const mine = store.questions.openFor(ENV_SESSION);
    const waiting = store.questions.pendingFrom(ENV_SESSION);
    if (mine.length === 0 && waiting.length === 0) {
      console.log(dim("No open questions."));
      return;
    }
    for (const q of mine) {
      console.log(`${cyan("?")} ${bold(`#${q.id}`)} from ${q.askerName} ${dim(briefAgo(q.askedMs, now))}`);
      for (const line of wrap(q.text, Math.max(40, terminalWidth() - 6))) console.log(`    ${line}`);
      console.log(dim(`    cli.ts answer ${q.id} "<your answer>"`));
    }
    for (const q of waiting) {
      console.log(dim(`… #${q.id} to ${q.targetName}: ${q.text}`));
    }
  });
}

/** Points an open item at the plan document it is executing. */
function link(planDoc: string, match: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`link`");
    const item = store.work.target(me.agentId, match);
    if (!item) return noOpenItem(match);
    const path = normalisePlanPath(planDoc);
    if (!store.work.link(item.workId, path, Date.now())) {
      console.error(`no work item #${item.workId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${green("✓")} ${bold(item.subject)} ${dim("→")} ${path}`);
    console.log(dim("  `cli.ts plans` shows what each plan's work has actually shipped."));
  });
}

/**
 * Every plan any work item references, with what shipped against it.
 *
 * WHY THIS EXISTS: 82 plan documents in this repo, 56 declaring no status at
 * all, and the 26 that do declare one are the WEAKER signal — a plan carried
 * four "[x] IMPLEMENTED" markers for phases nobody had written. Deriving state
 * from the plan file's git history fails for the opposite reason: an agent
 * writes a plan, implements it, and never touches the file again.
 *
 * So the state is read off the WORK, and the shas are the part that cannot be
 * wished true.
 */
function plans(): void {
  withStore(PROJECT.dbPath, (store) => {
    const rollups = store.work.planRollups();
    if (rollups.length === 0) {
      console.log(dim("No work item names a plan document yet."));
      console.log(dim('  `cli.ts doing "<subject>" --plan-doc <path>` opens one against a plan,'));
      console.log(dim("  `cli.ts link <path>` points an item that is already open at one."));
      return;
    }
    const now = Date.now();
    for (const p of rollups) {
      const progressText = p.stepsTotal > 0 ? `${p.stepsDone}/${p.stepsTotal}` : "no steps";
      const state = p.openItems > 0 ? cyan("open") : p.shas.length > 0 ? green("shipped") : dim("closed");
      console.log(`${bold(p.planDoc)}  ${state} ${dim(`· ${progressText} · ${briefAgo(p.updatedMs, now)}`)}`);
      console.log(dim(`    ${p.agents.join(", ")} — ${p.items.length} item(s)`));
      // Shas are the only line here that is evidence rather than assertion, so
      // they are printed in full rather than counted.
      if (p.shas.length > 0) console.log(`    ${green("landed")} ${p.shas.join(" ")}`);
    }
  });
}

/** Ticks step `n` off, optionally recording what actually happened. */
function did(n: number, note: string, match: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`did`");
    const now = Date.now();
    const item = store.work.target(me.agentId, match);
    if (!item) return noOpenItem(match);
    if (!store.work.tick(item.workId, n, note, now)) {
      const steps = store.work.steps(item.workId);
      console.error(`${bold(item.subject)} has no step ${n}.`);
      for (const s of steps) console.error(dim(`  ${s.idx}  ${s.text}`));
      if (steps.length === 0) console.error(dim("  (no checklist — `cli.ts add \"<step>\"`)"));
      process.exitCode = 1;
      return;
    }
    printProgress(store, item.workId, item.subject);
  });
}

/** Says which step is in progress, without claiming it is finished. */
function step(n: number, status: string, match: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`step`");
    const now = Date.now();
    const item = store.work.target(me.agentId, match);
    if (!item) return noOpenItem(match);
    store.work.record(item.workId, "step", status, now, String(n));
    console.log(`${cyan("▪")} ${bold(item.subject)} ${dim(`step ${n}`)}: ${status}`);
  });
}

/** Appends a phase the original plan missed. */
function addStep(text: string, match: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`add`");
    const now = Date.now();
    const item = store.work.target(me.agentId, match);
    if (!item) return noOpenItem(match);
    const idx = store.work.addStep(item.workId, text, now);
    console.log(`${green("+")} ${bold(item.subject)} ${dim(`step ${idx}`)}: ${text}`);
  });
}

/** Closes one item, leaving any other open item alone. */
function doneWork(match: string, abandoned: boolean, body: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`done`");
    const now = Date.now();
    const item = store.work.target(me.agentId, match);
    if (!item) return noOpenItem(match);
    const outcome = abandoned ? "abandoned" : "done";
    const p = progress(store.work.steps(item.workId));
    store.work.close(item.workId, outcome, body, now);
    const mark = abandoned ? red("✗") : green("✓");
    console.log(`${mark} ${bold(item.subject)} ${dim(outcome)}`);
    // Closing with steps outstanding is allowed and worth SAYING: it is the
    // honest exit from a plan that turned out wrong, and the record should show
    // that the remaining phases were dropped rather than silently completed.
    if (!abandoned && p.outstanding.length > 0) {
      console.log(dim(`  ${p.outstanding.length} step(s) were still outstanding`));
    }
    const rest = store.work.openItems(me.agentId);
    if (rest.length > 0) {
      console.log(dim(`  still open: ${rest.map((i) => i.subject).join(", ")}`));
    }
  });
}

function noOpenItem(match: string): void {
  if (match !== "") console.error(`no open work item matching ${bold(match)}.`);
  else console.error("no open work item.");
  console.error(dim('  Open one with `cli.ts doing "<subject>" --plan "a; b; c"`.'));
  process.exitCode = 1;
}

function printProgress(store: StoreHandle, workId: number, subject: string): void {
  const steps = store.work.steps(workId);
  const p = progress(steps);
  console.log(`${green("✓")} ${bold(subject)} ${dim(`${p.done}/${p.total}`)}`);
  if (p.current) console.log(`  ${dim("next")}  ${p.current.idx}  ${p.current.text}`);
  else if (p.total > 0) console.log(dim("  every step ticked — `cli.ts done` to close it"));
}

/** MY open items and what is still outstanding on them. */
function mine(): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`mine`");
    const now = Date.now();
    const items = store.work.openItems(me.agentId);
    if (items.length === 0) {
      console.log(dim("No open work items."));
      console.log(dim('  `cli.ts doing "<subject>" --plan "a; b; c"` opens one.'));
      return;
    }
    const width = terminalWidth();
    for (const item of items) {
      const steps = store.work.steps(item.workId);
      const fold = foldEvents(store.work.events(item.workId));
      for (const line of itemLines(item, steps, fold, now, width, BOARD_PAINT)) console.log(line);
    }
  });
}

/**
 * The shared board: what every agent is working on.
 *
 * PULL, NOT PUSH. This is a command rather than an injection because the
 * per-agent record is 4-6 lines, and seven agents would add ~35 lines to every
 * turn to tell each agent six things it does not need.
 */
function board(who: string, opts: { history: boolean; all: boolean; raw: boolean }): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    store.work.pruneWork(now);
    const showName = operatorNames(store.liveSessions(now));
    const target = who !== "" ? resolveAgentId(store, who, now) : undefined;
    if (who !== "" && target === undefined) {
      console.error(`no work records for ${bold(who)}.`);
      process.exitCode = 1;
      return;
    }
    const items = store.work.items({
      ...(target !== undefined ? { agentId: target } : {}),
      includeClosed: opts.all || opts.history,
    });
    if (items.length === 0) {
      console.log(dim(`No work records in ${PROJECT.name}.`));
      console.log(dim('  Agents open one with `cli.ts doing "<subject>"`.'));
      return;
    }
    const width = terminalWidth();
    if (opts.history) {
      printHistory(store, items, now, width);
      return;
    }

    // Grouped by agent, most recently touched agent first — the same ordering
    // rule the roster uses, and for the same reason: whoever is doing something
    // now is who you are looking for.
    const byAgent = new Map<string, typeof items>();
    for (const i of items) {
      const g = byAgent.get(i.agentId);
      if (g) g.push(i);
      else byAgent.set(i.agentId, [i]);
    }
    for (const [agentId, group] of byAgent) {
      const first = group[0];
      if (!first) continue;
      const open = group.filter((i) => i.closedMs === 0);
      const closed = group.length - open.length;
      // The tally counts what is IN this view: with closed items hidden, saying
      // "1 closed" beside a board that shows none is a claim the reader cannot
      // check. The `--all` hint below is how they get at them instead.
      const tally = agentTally(open.length, opts.all || opts.history ? closed : 0);
      // THE HEADING NAMES THE AGENT, SO IT COMES FROM THE AGENT — resolved from
      // the group's key, which is `session:<uuid>`, and not from whichever row
      // happens to sort first. Reading `group[0]`'s frozen name made the heading
      // depend on the SORT: rows are ordered by `updated_ms`, so closing the
      // most recent item promoted an older row and the same agent's group
      // silently relabelled itself from `Hopper` to `tooling` between two board
      // reads. `showName` still handles an agent that has exited, whose frozen
      // string is the only name left.
      const stored = first.agentName !== "" ? first.agentName : first.agentId;
      const live = agentId.startsWith("session:")
        ? store.findBySession(agentId.slice("session:".length))
        : null;
      const name = opts.raw ? stored : live ? rosterName(live) : showName(stored);
      const gap = Math.max(1, width - 2 - [...name].length - tally.length);
      console.log("");
      console.log(`  ${bold(handleColour(name)(name))}${" ".repeat(gap)}${dim(tally)}`);
      // Beyond the first few, open items are a COUNT. Nothing stops an agent
      // opening items it never closes, and a board that lists eleven of them
      // stops being readable exactly when it most needs to be.
      const shown = group.slice(0, BOARD_OPEN_SHOWN + closed);
      for (const item of shown) {
        const steps = store.work.steps(item.workId);
        const fold = foldEvents(store.work.events(item.workId));
        for (const line of itemLines(item, steps, fold, now, width, BOARD_PAINT)) console.log(line);
      }
      const hidden = group.length - shown.length;
      if (hidden > 0) console.log(dim(`    +${hidden} more`));
    }
    console.log("");
    // A closed record is kept for a week and is invisible here, so the default
    // view has to SAY that there is more rather than looking like the whole
    // history — "who broke the baselines?" is asked days after the item closed.
    if (!opts.all) {
      const withClosed = store.work.items({
        ...(target !== undefined ? { agentId: target } : {}),
        includeClosed: true,
      });
      const closed = withClosed.length - items.length;
      if (closed > 0) console.log(dim(`  ${closed} closed — \`board --all\` to include them`));
    }
  });
}

/** The same rows as a timeline — what the append-only event table is for. */
function printHistory(
  store: StoreHandle,
  items: readonly { workId: number; subject: string; startedMs: number }[],
  nowMs: number,
  width: number,
): void {
  for (const item of items) {
    console.log("");
    console.log(`  ${bold(item.subject)} ${dim(`started ${briefAgo(item.startedMs, nowMs)}`)}`);
    for (const e of store.work.events(item.workId)) {
      const when = dim(briefAge(e.tsMs, nowMs).padStart(6));
      const ref = e.ref !== "" ? ` ${cyan(e.ref)}` : "";
      console.log(`  ${when}  ${dim(e.kind.padEnd(8))}${ref} ${fit(e.body, width - 22)}`);
    }
  }
  console.log("");
}

/**
 * Maps a name a human would type onto the agent key its records are under.
 *
 * Matches a LIVE session's name first, then falls back to any name frozen on a
 * work row — so a record still answers to its author's name after that session
 * has exited, which is the whole point of keeping records past the session.
 */
function resolveAgentId(store: StoreHandle, query: string, nowMs: number): string | undefined {
  const live = store.findByName(query, nowMs);
  if (live) return agentKey(live.title, live.sessionId);
  const q = query.toLowerCase();
  const all = store.work.items({ includeClosed: true });
  return all.find((i) => i.agentName.toLowerCase() === q)?.agentId;
}

/**
 * Deregisters a session, leaving its OS process alone.
 *
 * DEREGISTER, NEVER KILL (user ruling, 2026-07-31). Terminating a `claude.exe`
 * destroys whatever that agent held in context, unrecoverably, and this tool
 * cannot tell a session whose terminal was closed from one merely sitting idle
 * — measured: window handle is 0 for every session including live ones, process
 * ancestry is byte-identical between a closed tab and this one, and CPU time
 * looked decisive over 6 s then INVERTED over 25 s. With no reliable liveness
 * signal, killing on a guess would eventually kill working agents. Removing the
 * roster row is safe and reversible: any hook the session fires re-registers it.
 */
function quit(target: string): void {
  const agents = listAgents();
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const sessions = store.liveSessions(now);
    const match = sessions.find(
      (s) => displayName(s).toLowerCase() === target.toLowerCase() || s.handle === target,
    );
    if (!match) {
      console.error(`no agent named ${bold(target)} in ${PROJECT.name}`);
      console.error(dim(`  active: ${sessions.map((s) => displayName(s)).join(", ") || "(none)"}`));
      process.exitCode = 1;
      return;
    }

    // WARN BEFORE REMOVING, because a roster row is how peers learn that a file
    // is spoken for: dropping a session that holds a contested path takes the
    // only warning about that collision with it.
    const claims = store.allClaims(now);
    const mine = claims.filter((c) => c.handle === match.handle);
    const counts = new Map<string, number>();
    for (const c of claims) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
    const contested = mine.filter((c) => (counts.get(c.path) ?? 0) > 1);

    const live = agents.find((a) => a.sessionId === match.sessionId);
    console.log(`${bold(displayName(match))} ${dim(`— ${agoText(match.lastSeenMs, now)}`)}`);
    if (live) {
      console.log(dim(`  process ${live.pid} is still running; this only clears the roster row`));
    }
    for (const c of contested) {
      const others = claims
        .filter((k) => k.path === c.path && k.handle !== match.handle)
        .map((k) => claimName(k));
      console.log(red(`  ⚠ holds ${c.path}, also held by ${others.join(", ")}`));
    }
    if (mine.length > 0) console.log(dim(`  releasing ${mine.length} claim(s)`));

    store.post(match.handle, "done", "left the roster", now);
    store.unregister(match.sessionId);
    console.log(green(`  ✓ deregistered`));
  });
}

/** One entry as a search result: the title line, and what qualifies it. */
function entryLine(e: DiaryEntry, nowMs: number, width: number): string[] {
  const age = shortAge(e.tsMs, nowMs);
  const kindPaint =
    e.kind === "error" ? red : e.kind === "warning" ? yellow : e.kind === "optimization" ? green : dim;
  const head = `${dim(`#${e.id}`)} ${kindPaint(e.kind.padEnd(12))} ${dim(pad(age, 4))}  `;
  const headLen = [...`#${e.id} ${e.kind.padEnd(12)} ${pad(age, 4)}  `].length;
  // WRAPPED, not truncated. The title is the whole claim and a search result
  // that ends in "…" makes the reader open the entry to find out whether it was
  // relevant — which is the cost the title/body split exists to avoid.
  const lines = wrap(e.title, Math.max(20, width - headLen)).map((l, i) =>
    i === 0 ? head + bold(l) : " ".repeat(headLen) + bold(l),
  );

  const bits = [cyan(e.topic)];
  for (const t of e.tags) bits.push(dim(`#${t}`));
  if (e.scope !== "") bits.push(dim(e.scope));
  bits.push(dim(`— ${e.agent}`));
  if (e.body !== "") bits.push(dim(`(body: cli.ts note ${e.id})`));
  lines.push(" ".repeat(headLen) + bits.join(" "));

  // A deprecated entry is shown with the reason it stopped being true, because
  // that is usually worth more than the claim was.
  if (e.deprecatedMs !== 0) {
    const why = e.deprecatedWhy !== "" ? `: ${e.deprecatedWhy}` : "";
    const sup = e.supersededBy !== 0 ? ` → see #${e.supersededBy}` : "";
    lines.push(" ".repeat(headLen) + red(fit(`✗ no longer true${why}${sup}`, width - headLen)));
  }
  return lines;
}

/** Writes one finding. */
function note(args: string[]): void {
  const topic = takeFlag(args, "--topic");
  const body = takeFlag(args, "--body");
  const tags = takeFlag(args, "--tags");
  const kind = takeFlag(args, "--kind");
  const scope = takeFlag(args, "--scope");
  const fixes = takeFlag(args, "--fixes");
  const title = args.join(" ").trim();

  const check = checkNote({
    title,
    body,
    topic,
    tags: parseTags(tags),
    ...(kind !== "" ? { kind: kind as DiaryKind } : {}),
    scope,
  });
  if (!check.ok) {
    console.error(`${red("✗")} ${check.why}`);
    process.exitCode = 1;
    return;
  }

  withStore(PROJECT.dbPath, (store) => {
    const who = callerIdentity(store);
    if (!who) {
      notAnAgent("`note`");
      return;
    }
    const now = Date.now();
    const id = store.diary.write(ENV_SESSION, who.agentName, check.note, now);
    console.log(`${green("✓")} ${bold(`#${id}`)} ${check.note.title}`);
    const where = check.note.scope !== "" ? ` in ${check.note.scope}` : "";
    console.log(
      dim(`  ${check.note.kind} · ${check.note.topic}${where} — peers find it with \`cli.ts recall\``),
    );
    if (check.note.scope === "") {
      // Said once at write time rather than as a refusal: a repo-wide entry is
      // legitimate, it just never fires the pre-edit pointer that makes the
      // diary worth writing to.
      console.log(dim("  no --scope, so this will not surface when someone edits a related file"));
    }
    if (fixes !== "") {
      const target = Number(fixes);
      const bug = Number.isFinite(target) ? store.diary.get(target) : null;
      // REPORTED, not silent. A `--fixes` that quietly does nothing leaves the
      // author believing a bug is closed while `bugs` still lists it.
      if (!bug) console.error(`${red("✗")} --fixes: no entry #${fixes}`);
      else if (bug.kind !== "error") {
        console.error(`${red("✗")} --fixes: #${target} is a ${bug.kind}, and only an error can be fixed`);
      } else if (!store.diary.fix(target, id, now)) {
        console.error(`${red("✗")} --fixes: #${target} is already fixed`);
      } else {
        console.log(`${green("✓")} fixed ${dim(`#${target} ${bug.title}`)}`);
      }
    }
  });
}

/** Search. Prints TITLES; a body is opened by id. */
function recall(args: string[]): void {
  const topic = takeFlag(args, "--topic");
  const tag = takeFlag(args, "--tag");
  const kind = takeFlag(args, "--kind");
  const scope = takeFlag(args, "--scope");
  const limit = Number(takeFlag(args, "--limit")) || 20;
  const all = args.includes("--all");
  if (all) args.splice(args.indexOf("--all"), 1);
  const mine = args.includes("--mine");
  if (mine) args.splice(args.indexOf("--mine"), 1);
  const query = args.join(" ").trim();

  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const hits = store.diary.recall({
      query,
      topic,
      tag,
      ...(kind !== "" ? { kind: kind as DiaryKind } : {}),
      scope,
      ...(mine ? { sessionId: ENV_SESSION } : {}),
      all,
      limit,
    });
    if (hits.length === 0) {
      console.log(dim(`nothing in the diary matches${query !== "" ? ` "${query}"` : ""}.`));
      const topics = store.diary.topics();
      if (topics.length > 0) {
        console.log(dim(`  topics: ${topics.slice(0, 8).map((t) => t.topic).join(", ")}`));
      }
      return;
    }
    const width = terminalWidth();
    for (const e of hits) for (const l of entryLine(e, now, width)) console.log(l);
  });
}

/** One entry in full — the only place a body is printed. */
function showNote(idRaw: string): void {
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) {
    console.error("usage: cli.ts note <id>");
    process.exitCode = 1;
    return;
  }
  withStore(PROJECT.dbPath, (store) => {
    const e = store.diary.get(id);
    if (!e) {
      console.error(`no diary entry #${id} in ${PROJECT.name}`);
      process.exitCode = 1;
      return;
    }
    const now = Date.now();
    const width = terminalWidth();
    for (const l of entryLine(e, now, width)) console.log(l);
    if (e.body !== "") {
      console.log("");
      for (const line of e.body.split("\n")) console.log(`  ${line}`);
    }
  });
}

/** What topics exist, and how alive each is. */
function topics(args: string[]): void {
  const stale = args.includes("--stale");
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const all = store.diary.topics();
    if (all.length === 0) {
      console.log(dim(`the ${PROJECT.name} diary is empty — write one with \`cli.ts note\`.`));
      return;
    }
    const shown = stale ? all.filter((t) => now - t.lastMs > 30 * 24 * 60 * 60 * 1000) : all;
    const w = Math.max(...shown.map((t) => t.topic.length), 5);
    console.log(bold(`${all.length} topics in ${PROJECT.name}`));
    for (const t of shown) {
      // Flagged only when a SIMILAR topic exists — a one-entry topic in a young
      // diary is just a new topic, and saying "typo?" about every row in a
      // four-entry diary trains the reader to ignore the hint entirely.
      const near = all.find((o) => o.topic !== t.topic && nearTopic(o.topic, t.topic));
      const lonely = near ? dim(`  (near \`${near.topic}\` — merge?)`) : "";
      console.log(
        `  ${cyan(pad(t.topic, w))} ${dim(String(t.count).padStart(3))}  ${dim(shortAge(t.lastMs, now))}${lonely}`,
      );
    }
  });
}

/** Every tag with a count. */
function tags(): void {
  withStore(PROJECT.dbPath, (store) => {
    const cloud = store.diary.tagCloud();
    if (cloud.length === 0) {
      console.log(dim("no tags yet — `cli.ts note \"…\" --topic x --tags perf,flaky`"));
      return;
    }
    console.log(bold(`${cloud.length} tags in ${PROJECT.name}`));
    const w = Math.max(...cloud.map((c) => c.tag.length), 5);
    for (const c of cloud) {
      console.log(`  ${dim("#")}${cyan(pad(c.tag, w))} ${dim(String(c.count).padStart(3))}`);
    }
  });
}

/**
 * Records a breaking change or an unmet dependency, and tells the peers it
 * affects.
 *
 * WHY `breaks` REACHES PEOPLE AND `needs` DOES NOT. A break is news somebody
 * else has to act on — a deleted function they may still call, a moved
 * baseline. `needs` is a note to the reader of the board about what this work is
 * waiting on; nobody is obliged by it, and messaging every agent about one
 * agent's blocker is how a channel becomes noise.
 *
 * ADDRESSED, NOT BROADCAST. A break goes only to agents who have touched a file
 * this one has touched — that is what makes it worth ending nobody's turn over.
 * Broadcasting it to eight agents so that one of them cares is the cost this
 * avoids.
 */
function flagWork(kind: "breaks" | "needs", text: string, match: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent(`\`${kind}\``);
    const now = Date.now();
    const item = store.work.target(me.agentId, match);
    if (!item) {
      console.error(`${red("✗")} no open work item to attach this to`);
      console.error(dim('  `cli.ts doing "<subject>"` opens one.'));
      process.exitCode = 1;
      return;
    }
    store.work.record(item.workId, kind, text, now);
    console.log(
      `${kind === "breaks" ? red("⚠") : yellow("•")} ${bold(item.subject)} ${dim(`— ${kind}`)}`,
    );
    console.log(`  ${text}`);

    if (kind !== "breaks") {
      console.log(dim("  recorded on the board; `needs` tells the reader, not the roster"));
      return;
    }

    // WHO IS AFFECTED: agents whose recent edits touch a file this agent has
    // also touched. Read from `edits`, which is append-only, so it still names
    // an agent whose live claim has already expired — a break reaches the
    // person who was in that file this morning, not only the one in it now.
    const day = now - 24 * 60 * 60 * 1000;
    const mine = new Set(store.editsBy(ENV_SESSION, day).map((e) => e.path));
    const reached: string[] = [];
    for (const peer of store.liveSessions(now)) {
      if (peer.sessionId === ENV_SESSION) continue;
      const theirs = store.editsBy(peer.sessionId, day);
      if (!theirs.some((e) => mine.has(e.path))) continue;
      store.post(me.agentName, "breaks", `${text} (in "${item.subject}")`, now, {
        sessionId: peer.sessionId,
        name: displayName(peer),
      });
      reached.push(displayName(peer));
    }
    console.log(
      reached.length > 0
        ? dim(`  told ${reached.join(", ")} — they have edited files you have`)
        : dim("  nobody else has been in your files today, so nobody was messaged"),
    );
  });
}

/** Marks an entry no longer true, with the reason that is the point of it. */
function deprecateNote(idRaw: string, why: string): void {
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0 || why.trim() === "") {
    console.error(usageFor("note-deprecate"));
    console.error(dim("  The reason is required — it is usually worth more than the claim was."));
    process.exitCode = 1;
    return;
  }
  withStore(PROJECT.dbPath, (store) => {
    const e = store.diary.get(id);
    if (!e) {
      console.error(`no diary entry #${id} in ${PROJECT.name}`);
      process.exitCode = 1;
      return;
    }
    if (!store.diary.deprecate(id, why, Date.now())) {
      // An entry retired WITHOUT a reason can still take one. Refusing outright
      // made `diary check`'s "does not say why" unfixable by any command — a
      // report with no repair, which is the same dead end as advice that fails
      // when followed.
      if (e.deprecatedWhy === "" && store.diary.explainDeprecation(id, why)) {
        console.log(`${green("✓")} #${id} ${dim("— reason recorded")}`);
        console.log(dim(`  it was already retired; this fills in why`));
        return;
      }
      console.error(`${red("✗")} #${id} is already marked no longer true`);
      console.error(dim(`  ${e.deprecatedWhy}`));
      process.exitCode = 1;
      return;
    }
    console.log(`${green("✓")} #${id} ${dim("marked no longer true")}`);
    console.log(dim(`  ${e.title}`));
    console.log(dim(`  it stays searchable behind \`cli.ts recall --all\``));
  });
}

/** Points a stale entry at the one that replaced it. */
function supersedeNote(idRaw: string, byRaw: string): void {
  const id = Number(idRaw);
  const by = Number(byRaw);
  if (!Number.isFinite(id) || !Number.isFinite(by) || id <= 0 || by <= 0) {
    console.error(usageFor("note-supersede"));
    process.exitCode = 1;
    return;
  }
  withStore(PROJECT.dbPath, (store) => {
    if (!store.diary.supersede(id, by, Date.now())) {
      console.error(`${red("✗")} could not supersede #${id} with #${by}`);
      console.error(dim("  both must exist, and an entry cannot supersede itself"));
      process.exitCode = 1;
      return;
    }
    console.log(`${green("✓")} #${id} ${dim("→")} #${by}`);
    console.log(dim("  a search lands on the new one and can still walk back to the old"));
  });
}

/** Folds one topic into another. */
function mergeTopics(from: string, into: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const n = store.diary.mergeTopic(from, into);
    if (n === 0) {
      console.error(`${red("✗")} nothing moved — check both names with \`cli.ts topics\``);
      process.exitCode = 1;
      return;
    }
    console.log(`${green("✓")} moved ${n} ${n === 1 ? "entry" : "entries"} from ${bold(from)} to ${bold(into)}`);
  });
}

/** What is wrong with the diary as an organised thing. */
function diaryCheck(): void {
  withStore(PROJECT.dbPath, (store) => {
    const problems = store.diary.check(Date.now());
    if (problems.length === 0) {
      console.log(`${green("✓")} the ${PROJECT.name} diary looks healthy`);
      return;
    }
    console.log(bold(`${problems.length} thing(s) worth a look in ${PROJECT.name}`));
    for (const p of problems) {
      console.log(`  ${yellow("•")} ${p.detail}`);
      if (p.fix !== "") console.log(dim(`      ${p.fix}`));
    }
  });
}

/** Records something about the operator, for THIS agent only. */
/**
 * Which body of knowledge a session reads and writes.
 *
 * An adopted lineage wins over the session's own name — that is what adoption
 * MEANS. Without a lineage it is the agent's own name, so an ordinary session
 * keeps exactly the behaviour it had before lineages existed.
 */
function lineageOf(s: Session): string {
  return s.lineageFrom !== "" ? s.lineageFrom : lineageKey(displayName(s), s.sessionId);
}

function remember(args: string[]): void {
  const body = takeFlag(args, "--body");
  const tagList = takeFlag(args, "--tags");
  const isGlobal = args.includes("--global");
  if (isGlobal) args.splice(args.indexOf("--global"), 1);
  const title = args.join(" ").trim();

  const check = checkMemory(title, body, tagList.split(",").filter((t) => t.trim() !== ""));
  if (!check.ok) {
    console.error(`${red("✗")} ${check.why}`);
    process.exitCode = 1;
    return;
  }
  if (ENV_SESSION === "") {
    notAnAgent("`remember`");
    return;
  }
  const self = withStore(PROJECT.dbPath, (store) => store.findBySession(ENV_SESSION));
  const name = self ? displayName(self) : "";
  // A DISCIPLE WRITES INTO ITS MASTER'S LINEAGE. `agent` stays this session's
  // own name (who learned it), while `lineage` is the body of knowledge it
  // joins — so an inherited store keeps growing rather than forking on the
  // first thing its successor learns.
  const lineage = self ? lineageOf(self) : lineageKey(name, ENV_SESSION);
  withPersonal((personal) => {
    const id = personal.remember(
      ENV_SESSION,
      name,
      check,
      isGlobal ? "" : PROJECT.name,
      isGlobal,
      Date.now(),
      lineage,
    );
    console.log(`${green("✓")} ${bold(`#${id}`)} ${check.title}`);
    console.log(
      dim(
        isGlobal
          ? "  global — you will carry this into every project"
          : `  ${PROJECT.name} only — add \`--global\` if it is true of them everywhere`,
      ),
    );
  });
}

/**
 * What an agent believes about the operator.
 *
 * READABLE BY THE OPERATOR, and that is load-bearing: these are injected every
 * session and a wrong one compounds. A private model of a person that the
 * person cannot inspect is the one shape this feature must not take.
 */
function aboutMe(args: string[]): void {
  const target = takeFlag(args, "--agent");
  const allProjects = args.includes("--all-projects");

  const resolved = withStore(PROJECT.dbPath, (store) => {
    if (target !== "") {
      // A named agent may be GONE, and that is the interesting case — the whole
      // point of a lineage is reading a departed agent's knowledge. So a name
      // that resolves to no live session still resolves to a lineage.
      const s = store.findByName(target, Date.now());
      if (s) return { lineage: lineageOf(s), name: displayName(s) };
      return { lineage: target.trim().toLowerCase(), name: target.trim() };
    }
    if (ENV_SESSION === "") return null;
    const self = store.findBySession(ENV_SESSION);
    const name = self ? displayName(self) : "";
    return { lineage: self ? lineageOf(self) : lineageKey(name, ENV_SESSION), name };
  });

  withPersonal((personal) => {
    if (!resolved) {
      // No agent named: show which LINEAGES hold memories, so the operator can
      // pick one. Lineages rather than sessions, because a body of knowledge is
      // the thing that persists and the thing `inherit` takes up.
      const held = personal.lineages();
      if (held.length === 0) {
        console.log(dim("no agent has recorded anything about you yet."));
        return;
      }
      console.log(bold("lineages holding memories about you"));
      for (const l of held) {
        const who = l.lineage.startsWith("session:") ? l.lineage.slice(8, 16) : l.lineage;
        console.log(
          `  ${cyan(who)} ${dim(`— ${l.count}`)}  ${dim(`cli.ts about-me --agent ${who}`)}`,
        );
      }
      return;
    }
    const mine = personal.forLineage(resolved.lineage, PROJECT.name, { allProjects });
    if (mine.length === 0) {
      console.log(dim(`${resolved.name || "this agent"} has recorded nothing about you here.`));
      if (!allProjects) console.log(dim("  `--all-projects` looks in every repo."));
      return;
    }
    const now = Date.now();
    const width = terminalWidth();
    console.log(bold(`what ${resolved.name || "this agent"} remembers about you`));
    for (const m of mine) {
      // The qualifiers go on their OWN line. Run together, "…screenshot loop
      // test now" reads as though the scope and age were part of what the agent
      // remembers — which is exactly the sentence the operator is checking.
      const head = `  ${dim(`#${m.id}`)} `;
      const headLen = [...`  #${m.id} `].length;
      for (const [i, l] of wrap(m.title, Math.max(20, width - headLen)).entries()) {
        console.log(i === 0 ? head + l : " ".repeat(headLen) + l);
      }
      const where = m.global ? cyan("everywhere") : dim(`${m.project} only`);
      console.log(`${" ".repeat(headLen)}${where} ${dim(`· ${shortAge(m.tsMs, now)}`)}`);
      if (m.body !== "") {
        for (const l of wrap(m.body, Math.max(20, width - headLen))) {
          console.log(dim(" ".repeat(headLen) + l));
        }
      }
    }
    console.log(dim("  `cli.ts forget <id>` removes one."));
  });
}

/**
 * Take up a departed agent's body of knowledge.
 *
 * A LIVE LINEAGE IS REFUSED, and that is the rule the whole feature rests on.
 * Adopting from an agent that is still working is a FORK, not a succession: two
 * sessions writing one lineage makes it a composite of two agents' beliefs with
 * no way to tell them apart, and `forget` could then remove something its
 * author never wrote. When the original goes, the lineage becomes inheritable.
 */
function inherit(args: string[]): void {
  const target = args.join(" ").trim();
  if (target === "") {
    // Bare `inherit` lists what is available rather than erroring: an agent
    // that does not know a lineage exists is the case this feature is FOR.
    withPersonal((personal) => {
      const held = personal.lineages().filter((l) => !l.lineage.startsWith("session:"));
      if (held.length === 0) {
        console.log(dim("no lineage has recorded anything yet."));
        return;
      }
      const now = Date.now();
      const rows = withStore(PROJECT.dbPath, (store) =>
        held.map((l) => ({ ...l, live: store.liveHolder(l.lineage, now) !== null })),
      );
      const free = rows.filter((l) => !l.live);
      const busy = rows.filter((l) => l.live);
      // THE FREE ONES ARE THE ANSWER TO THE QUESTION ASKED. A live lineage is
      // listed too, because "hopper knows this ground but is still working" is
      // useful — it says whom to ASK — but it is listed second and marked, not
      // offered as something to take.
      if (free.length > 0) {
        console.log(bold("lineages you could take up"));
        for (const l of free) {
          console.log(
            `  ${cyan(l.lineage)} ${dim(`${l.count} ${l.count === 1 ? "memory" : "memories"}`)} ` +
              `${dim(`· last active ${shortAge(l.lastMs, now)}`)}`,
          );
        }
        console.log(dim("  `cli.ts inherit <name>` takes one up."));
      } else {
        console.log(dim("no lineage is free to take up right now."));
      }
      if (busy.length > 0) {
        console.log(bold("\nstill held — ask them instead of inheriting"));
        for (const l of busy) {
          console.log(`  ${cyan(l.lineage)} ${dim(`${l.count} ${l.count === 1 ? "memory" : "memories"}`)}`);
        }
      }
    });
    return;
  }
  if (ENV_SESSION === "") {
    notAnAgent("`inherit`");
    return;
  }
  const key = target.toLowerCase();
  const outcome = withStore(PROJECT.dbPath, (store) => {
    const self = store.findBySession(ENV_SESSION);
    const me = self ? displayName(self) : "";
    if (key === me.toLowerCase()) return { ok: false as const, why: "that is your own name" };
    const holder = store.liveHolder(key, Date.now());
    if (holder) {
      return {
        ok: false as const,
        why: `${displayName(holder)} is live and still holds it — inheriting now would fork it`,
      };
    }
    store.setLineage(ENV_SESSION, key);
    return { ok: true as const, me };
  });
  if (!outcome.ok) {
    console.error(`${red("✗")} ${outcome.why}`);
    process.exitCode = 1;
    return;
  }
  const count = withPersonal((personal) => personal.forLineage(key, PROJECT.name).length);
  console.log(`${green("✓")} you are ${bold(discipleName(outcome.me, key))}`);
  console.log(
    dim(
      count === 0
        ? `  ${key} left no memories in ${PROJECT.name} — you start clean, under its name`
        : `  ${count} ${count === 1 ? "memory" : "memories"} from ${key}, unverified by you` +
          ` — \`cli.ts about-me\` reads them`,
    ),
  );
}

/** Removes a memory outright — see `PersonalStore.forget` for why not a tombstone. */
function forget(idRaw: string): void {
  const id = Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) {
    console.error(usageFor("forget"));
    process.exitCode = 1;
    return;
  }
  withPersonal((personal) => {
    const m = personal.get(id);
    if (!m || !personal.forget(id)) {
      console.error(`no memory #${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${green("✓")} forgotten: ${dim(m.title)}`);
  });
}

function structured(target:string,acts:StructuredActInput[],idempotencyKey=randomUUID(),dependencies?:any[]):void {
  if(ENV_SESSION===""){notAnAgent("structured acts");return;}
  const result=withStore(PROJECT.dbPath,store=>{
    const now=Date.now();const self=store.findBySession(ENV_SESSION);const to=store.findByName(target,now);
    if(!self)return {error:"this session is not registered"} as const;if(!to)return {error:`no live agent named ${target}`} as const;
    try{return {value:store.obligations.createBatch({senderSessionId:ENV_SESSION,senderName:displayName(self),recipientSessionId:to.sessionId,recipientName:displayName(to),acts,dependencies,idempotencyKey,nowMs:now,surface:"cli"})} as const;}catch(e){return {error:e instanceof Error?e.message:String(e)} as const;}
  });
  if("error" in result){console.error(`${red("✗")} ${result.error}`);process.exitCode=1;return;}
  console.log(`${green("✓")} structured message #${result.value.messageId}`);for(const [key,id] of Object.entries(result.value.obligationIds))console.log(`  ${key}: obligation ${id}`);for(const [key,id] of Object.entries(result.value.clearanceIds))console.log(`  ${key}: clearance ${id}`);
}

function obligationCommand(id:string,eventName:string|undefined,args:string[]):void {
  const outcome=withStore(PROJECT.dbPath,store=>{
    const definition=store.obligations.definition(id),snapshot=store.obligations.snapshot(id);if(!definition||!snapshot)return {error:`no obligation ${id}`} as const;
    if(!eventName)return {definition,snapshot,events:store.obligations.events(id)} as const;
    const self=ENV_SESSION?store.findBySession(ENV_SESSION):null;const actor:ActorRef=self?{kind:"agent",agentId:ENV_SESSION}:{kind:"operator"};const versionRaw=takeFlag(args,"--version");const expectedVersion=versionRaw===""?snapshot.version:Number(versionRaw);const reason=takeFlag(args,"--reason");const resolution=takeFlag(args,"--resolution");const target=takeFlag(args,"--to");let to:ActorRef|undefined;if(target){const session=store.findByName(target,Date.now());if(!session)return {error:`no live agent named ${target}`} as const;to={kind:"agent",agentId:session.sessionId};}
    let payload:ObligationEvent;
    switch(eventName){case"accept":payload={type:"accepted"};break;case"decline":payload={type:"declined",reason:reason||undefined};break;case"counter":{const replacement=takeFlag(args,"--replacement");if(!replacement)return {error:"counter requires --replacement <id>"} as const;payload={type:"countered",replacementId:replacement};break;}case"withdraw":payload={type:"withdrawn",reason:reason||undefined};break;case"cancel":payload={type:"cancelled",reason:reason||"cancelled explicitly"};break;case"fulfil":payload={type:"fulfilled",resolutionKey:resolution||undefined};break;case"violate":payload={type:"violated"};break;case"activate":payload={type:"activated",trigger:{kind:"obligation_resolved",obligationId:id}};break;case"release":payload={type:"released",why:reason||"released explicitly"};break;case"expire":payload={type:"expired",episodeId:takeFlag(args,"--episode")||"operator"};break;case"relinquish":if(snapshot.currentResponsible.kind!=="assigned")return {error:"obligation is unassigned"} as const;payload={type:"relinquished",from:snapshot.currentResponsible.actor,reason:reason||undefined};break;case"assign":if(!to||!((to.kind==="agent")||(to.kind==="operator")))return {error:"assign requires --to <agent>"} as const;payload={type:"assigned",to};break;case"reassign":case"return":if(snapshot.currentResponsible.kind!=="assigned"||!to||!((to.kind==="agent")||(to.kind==="operator")))return {error:`${eventName} requires assigned owner and --to`} as const;payload=eventName==="return"?{type:"returned",from:snapshot.currentResponsible.actor,to}:{type:"reassigned",from:snapshot.currentResponsible.actor,to};break;default:return {error:`unknown obligation event ${eventName}`} as const;}
    try{return {definition,snapshot:store.obligations.append({id:randomUUID(),obligationId:id,actor,occurredAt:Date.now(),expectedVersion,idempotencyKey:takeFlag(args,"--key")||randomUUID(),payload}),events:store.obligations.events(id)} as const;}catch(e){return {error:e instanceof Error?e.message:String(e)} as const;}
  });
  if("error" in outcome){console.error(`${red("✗")} ${outcome.error}`);process.exitCode=1;return;}console.log(`${bold(id)}  ${outcome.snapshot.authority} / ${outcome.snapshot.activation}  v${outcome.snapshot.version}`);console.log(`  ${outcome.definition.text}`);
}

function clearanceCommand(id:string,eventName:string|undefined,args:string[]):void {
  const outcome=withStore(PROJECT.dbPath,store=>{const definition=store.obligations.clearance(id),snapshot=store.obligations.clearanceSnapshot(id);if(!definition||!snapshot)return {error:`no clearance ${id}`} as const;if(!eventName)return {definition,snapshot} as const;const self=ENV_SESSION?store.findBySession(ENV_SESSION):null;const actor:ActorRef=self?{kind:"agent",agentId:ENV_SESSION}:{kind:"operator"};const version=Number(takeFlag(args,"--version")||snapshot.version);const reason=takeFlag(args,"--reason");const payload=eventName==="revoke"?{type:"revoked" as const,reason:reason||undefined}:eventName==="expire"?{type:"expired" as const,reason:reason||"expired explicitly"}:null;if(!payload)return {error:`unknown clearance event ${eventName}`} as const;try{return {definition,snapshot:store.obligations.appendClearance({id:randomUUID(),clearanceId:id,actor,occurredAt:Date.now(),expectedVersion:version,idempotencyKey:takeFlag(args,"--key")||randomUUID(),payload})} as const;}catch(e){return {error:e instanceof Error?e.message:String(e)} as const;}});if("error" in outcome){console.error(`${red("âœ—")} ${outcome.error}`);process.exitCode=1;return;}console.log(`${bold(id)}  ${outcome.snapshot.state}  v${outcome.snapshot.version}`);console.log(`  ${outcome.definition.scopeText}`);
}

const [cmd, ...rest] = Bun.argv.slice(2);
const structuredVerbs=new Set(["ask","request","promise","handoff","grant","correct","hazard","act"]);
switch (cmd) {
  case "who":
  case undefined:
    who(rest.includes("--raw"));
    break;
  case "log":
    // The count is the first bare number, so `log --raw` and `log 40 --raw`
    // both work rather than `--raw` being parsed as the limit.
    log(Number(rest.find((a) => /^\d+$/.test(a)) ?? 20) || 20, rest.includes("--raw"));
    break;
  case "say": {
    const text = rest.join(" ").trim();
    if (!text) {
      console.error(usageFor("say"));
      process.exit(1);
    }
    say(text);
    break;
  }
  case "msg": {
    // `--from <name>` anywhere in the args; an agent uses it to send as itself.
    const args = [...rest];
    let from: string | undefined;
    const fi = args.indexOf("--from");
    if (fi >= 0) {
      from = args[fi + 1];
      args.splice(fi, 2);
    }
    const target = args.shift();
    const text = args.join(" ").trim();
    if (!target || !text) {
      console.error(usageFor("msg"));
      process.exit(1);
    }
    msg(target, text, from);
    break;
  }
  case "request": {const target=rest.shift();const text=rest.join(" ").trim();if(!target||!text){console.error(usageFor("request"));process.exitCode=1;break;}structured(target,[{key:"request",type:"request",text}]);break;}
  case "promise": {const args=[...rest];const target=args.shift();const refrain=args.includes("--refrain");if(refrain)args.splice(args.indexOf("--refrain"),1);const until=takeFlag(args,"--until");const text=args.join(" ").trim();if(!target||!text||(refrain&&!until)){console.error(usageFor("promise"));process.exitCode=1;break;}structured(target,[{key:"promise",type:"promise",text,mode:refrain?"refrain":"perform",...(until?{releaseBoundary:{text:until,handling:"manual" as const}}:{})}]);break;}
  case "handoff": {const target=rest.shift();const subject=rest.join(" ").trim();if(!target||!subject){console.error(usageFor("handoff"));process.exitCode=1;break;}structured(target,[{key:"handoff",type:"handoff",text:`Responsibility for ${subject}`,subject}]);break;}
  case "grant": {const target=rest.shift();const scope=rest.join(" ").trim();if(!target||!scope){console.error(usageFor("grant"));process.exitCode=1;break;}structured(target,[{key:"grant",type:"grant",text:`Go ahead on ${scope}`,scopeText:scope}]);break;}
  case "correct": {const target=rest.shift(),kind=rest.shift();const text=rest.join(" ").trim();const correctionType=kind==="self"?"self_erratum":kind==="peer"?"peer_correction":kind==="implementation"?"implementation_correction":undefined;if(!target||!correctionType||!text){console.error(usageFor("correct"));process.exitCode=1;break;}structured(target,[{key:"correction",type:"correction",text,correctionType}]);break;}
  case "hazard": {const target=rest.shift(),subject=rest.shift();const text=rest.join(" ").trim();if(!target||!subject||!text){console.error(usageFor("hazard"));process.exitCode=1;break;}structured(target,[{key:"hazard",type:"hazard",text,subject}]);break;}
  case "act": {const args=[...rest];const target=args.shift();const file=takeFlag(args,"--json");if(!target||!file){console.error(usageFor("act"));process.exitCode=1;break;}try{const body=JSON.parse(readFileSync(file,"utf8"));if(!Array.isArray(body.acts))throw new Error("JSON requires acts[]");structured(target,body.acts,body.idempotencyKey??randomUUID(),body.dependencies);}catch(e){console.error(`${red("✗")} ${e instanceof Error?e.message:String(e)}`);process.exitCode=1;}break;}
  case "obligation": {const id=rest.shift();const eventName=rest.shift();if(!id){console.error(usageFor("obligation"));process.exitCode=1;break;}obligationCommand(id,eventName,rest);break;}
  case "clearance": {const id=rest.shift();const eventName=rest.shift();if(!id){console.error(usageFor("clearance"));process.exitCode=1;break;}clearanceCommand(id,eventName,rest);break;}
  case "quit": {
    const target = rest[0];
    if (!target) {
      console.error(usageFor("quit"));
      process.exit(1);
    }
    quit(target);
    break;
  }
  case "doing": {
    // `--plan` takes ONE argument, so the steps must be quoted as a unit;
    // everything before it is the subject, joined so it need not be.
    const args = [...rest];
    let plan = "";
    const pi = args.indexOf("--plan");
    if (pi >= 0) {
      plan = args[pi + 1] ?? "";
      args.splice(pi, 2);
    }
    const planDoc = takeFlag(args, "--plan-doc");
    const subject = args.join(" ").trim();
    if (!subject) {
      console.error(usageFor("doing"));
      process.exit(1);
    }
    doing(subject, plan, planDoc);
    break;
  }
  case "did": {
    const args = [...rest];
    const n = Number(args.shift());
    const match = takeFlag(args, "--item");
    if (!Number.isInteger(n) || n < 1) {
      console.error(usageFor("did"));
      process.exit(1);
    }
    did(n, args.join(" ").trim(), match);
    break;
  }
  case "step": {
    const args = [...rest];
    const n = Number(args.shift());
    const match = takeFlag(args, "--item");
    const status = args.join(" ").trim();
    if (!Number.isInteger(n) || n < 1 || !status) {
      console.error(usageFor("step"));
      process.exit(1);
    }
    step(n, status, match);
    break;
  }
  case "add": {
    const args = [...rest];
    const match = takeFlag(args, "--item");
    const text = args.join(" ").trim();
    if (!text) {
      console.error(usageFor("add"));
      process.exit(1);
    }
    addStep(text, match);
    break;
  }
  case "done": {
    const args = [...rest];
    const abandoned = args.includes("--abandoned");
    if (abandoned) args.splice(args.indexOf("--abandoned"), 1);
    const body = takeFlag(args, "--note");
    doneWork(args.join(" ").trim(), abandoned, body);
    break;
  }
  case "board": {
    const args = [...rest];
    const history = args.includes("--history");
    if (history) args.splice(args.indexOf("--history"), 1);
    const all = args.includes("--all");
    if (all) args.splice(args.indexOf("--all"), 1);
    const raw = args.includes("--raw");
    if (raw) args.splice(args.indexOf("--raw"), 1);
    board(args.join(" ").trim(), { history, all, raw });
    break;
  }
  case "ask": {
    const [target, ...words] = rest;
    const text = words.join(" ").trim();
    if (!target || !text) {
      console.error(usageFor("ask"));
      process.exit(1);
    }
    ask(target, text);
    break;
  }
  case "answer": {
    const [id, ...words] = rest;
    const text = words.join(" ").trim();
    if (!id || !text) {
      console.error(usageFor("answer"));
      process.exit(1);
    }
    answerQuestion(id, text);
    break;
  }
  case "asks":
    asks();
    break;
  case "bugs": {
    const args = [...rest];
    const scope = takeFlag(args, "--scope");
    bugs(scope, Number(takeFlag(args, "--limit")) || 20);
    break;
  }
  case "link": {
    const args = [...rest];
    const match = takeFlag(args, "--item");
    const path = args.join(" ").trim();
    if (!path) {
      console.error(usageFor("link"));
      process.exit(1);
    }
    link(path, match);
    break;
  }
  case "plans":
    plans();
    break;
  case "mine":
    mine();
    break;
  case "call-me":
  case "name": {
    const args = [...rest];
    const target = takeFlag(args, "--agent");
    const name = args.join(" ").trim();
    if (!name) {
      console.error(usageFor("call-me"));
      process.exit(1);
    }
    callMe(name, target);
    break;
  }
  case "files": {
    const args = [...rest];
    const hours = Number(takeFlag(args, "--hours")) || 24;
    const target = args.join(" ").trim();
    if (!target) {
      console.error(usageFor("files"));
      process.exit(1);
    }
    filesOf(target, hours);
    break;
  }
  case "blame": {
    const path = rest.join(" ").trim();
    if (!path) {
      console.error(usageFor("blame"));
      process.exit(1);
    }
    blame(path);
    break;
  }
  case "note": {
    // `note <id>` reads, `note "<title>" --topic x` writes. Split on whether
    // the whole argument is a bare number, so neither needs a subcommand.
    const args = [...rest];
    if (args.length === 1 && /^\d+$/.test(args[0] ?? "")) {
      showNote(args[0] ?? "");
      break;
    }
    if (args.length === 0) {
      console.error('usage: cli.ts note "<title>" --topic <t> [--body "<detail>"]');
      console.error(dim("             [--tags a,b] [--kind finding|warning|error|optimization]"));
      console.error(dim("             [--scope src/sim/water]"));
      console.error(dim("       cli.ts note <id>     # read one, body included"));
      process.exit(1);
    }
    note(args);
    break;
  }
  case "recall":
    recall([...rest]);
    break;
  case "topics":
    topics([...rest]);
    break;
  case "topic": {
    const args = [...rest];
    // `topic merge <from> <into>` before the read, so the reader is not the
    // thing that swallows a subcommand.
    if (args[0] === "merge") {
      if (args.length !== 3) {
        console.error("usage: cli.ts topic merge <from> <into>");
        process.exit(1);
      }
      mergeTopics(args[1] ?? "", args[2] ?? "");
      break;
    }
    const limit = Number(takeFlag(args, "--limit")) || 20;
    const name = args.join(" ").trim();
    if (!name) {
      console.error("usage: cli.ts topic <name> [--limit n]");
      console.error(dim("       cli.ts topic merge <from> <into>"));
      process.exit(1);
    }
    recall(["--topic", name, "--limit", String(limit)]);
    break;
  }
  case "tags":
    tags();
    break;
  case "breaks":
  case "needs": {
    const args = [...rest];
    const match = takeFlag(args, "--item");
    const text = args.join(" ").trim();
    if (!text) {
      console.error(`usage: cli.ts ${cmd} "<what>" [--item <subject match>]`);
      console.error(
        dim(
          cmd === "breaks"
            ? "  Recorded on your item AND messaged to agents who have edited the same files."
            : "  Recorded on your item, for whoever reads the board.",
        ),
      );
      process.exit(1);
    }
    flagWork(cmd, text, match);
    break;
  }
  case "note-deprecate": {
    const args = [...rest];
    const id = args.shift() ?? "";
    deprecateNote(id, args.join(" "));
    break;
  }
  case "note-supersede":
    supersedeNote(rest[0] ?? "", rest[1] ?? "");
    break;
  case "diary": {
    // `diary check` is the only subcommand; anything else is a typo worth
    // naming rather than silently doing nothing.
    const sub = rest[0] ?? "";
    if (sub === "check") diaryCheck();
    else {
      console.error(usageFor("diary"));
      process.exit(1);
    }
    break;
  }
  case "remember":
    remember([...rest]);
    break;
  case "about-me":
    aboutMe([...rest]);
    break;
  case "inherit":
    inherit(rest);
    break;
  case "forget":
    forget(rest[0] ?? "");
    break;
  case "call-you":
  case "role": {
    const args = [...rest];
    const target = takeFlag(args, "--agent");
    const role = args.join(" ").trim();
    if (!role) {
      console.error(usageFor("call-you"));
      process.exit(1);
    }
    callYou(role, target);
    break;
  }
  case "clear":
    clear();
    break;
  case "where":
    where();
    break;
  case "injection":
    injection(rest);
    break;
  case "inbox":
    inbox(rest);
    break;
  case "stats":
    stats();
    break;
  case "help":
  case "--help":
  case "-h":
    if(ENV_SESSION!=="")withStore(PROJECT.dbPath,store=>{for(const feature of helpFeatures())store.recordFeatureEvent({sessionId:ENV_SESSION,feature,stage:"exposure",surface:"help",opportunityId:ENV_SESSION,sourceKey:"cli-help",nowMs:Date.now()});});
    console.log(usage(terminalWidth()));
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    console.error(usage(terminalWidth()));
    process.exit(1);
}

// A CLI invocation is use only after its handler succeeds. Structured verbs
// record inside their own transaction, so a failed batch cannot leave a use
// event and a successful one cannot be counted twice here.
if((process.exitCode??0)===0&&ENV_SESSION!==""&&cmd&&!structuredVerbs.has(cmd)&&!["help","--help","-h"].includes(cmd)){const feature=featureForVerb(cmd);if(feature)withStore(PROJECT.dbPath,store=>store.recordFeatureEvent({sessionId:ENV_SESSION,feature,stage:"use",surface:"cli",opportunityId:ENV_SESSION,sourceKey:`${cmd}:${randomUUID()}`,nowMs:Date.now()}));}

/** Pulls `--flag <value>` out of an arg list, returning "" when absent. */
function takeFlag(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0) return "";
  const value = args[i + 1] ?? "";
  args.splice(i, 2);
  return value;
}
