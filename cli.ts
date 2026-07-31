/**
 * Human-facing view of the presence store, and a way to post into it by hand.
 *
 *   bun cli.ts who               # roster + claims
 *   bun cli.ts log [n]           # recent messages
 *   bun cli.ts msg <name> "..."  # send to ONE agent  [--from <name>]
 *   bun cli.ts say <text>        # broadcast to every agent
 *   bun cli.ts clear             # wipe roster
 *   bun cli.ts where             # which project/db this directory maps to
 *
 * The project is resolved from the CWD exactly as the hooks resolve it, so
 * running this from any worktree reads that repo's roster.
 *
 * `say` exists because you are the only participant who can see all four
 * sessions at once; it is how you tell them something without retyping it four
 * times. It posts under a fixed handle so agents can tell it from a peer.
 */

import { agoText, claimName, displayName, withStore } from "./core/store.ts";
import { installedVersion, resolveProject } from "./core/repo.ts";
import { listAgents } from "./core/agents.ts";
import { refreshSummary, SUMMARY_TTL_MS } from "./core/summary.ts";
import {
  fit,
  pad,
  renderFileLine,
  shortAge,
  summarizeFiles,
  terminalWidth,
} from "./core/layout.ts";
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
 * The summary worker, resolved beside THIS file.
 *
 * `import.meta.dir` rather than a fixed path, so a CLI run from the source tree
 * spawns the source worker and the installed copy under `~/.claude/agent-
 * presence/bin/` spawns its own. Hardcoding the installed path would make every
 * source-tree test silently exercise the deployed build — the exact trap that
 * once had an edit look broken because `bin/` was stale.
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
 *
 * This does NOT colourise `formatRoster`'s output: the two audiences want
 * different text. An agent needs the framing spelled out in words; a human
 * scanning eight sessions wants density, and gets the same distinctions from
 * colour. Both read the same store, so they cannot disagree on the facts.
 */
function who(): void {
  // Refreshed on every `who`: you are asking precisely because you want the
  // current picture, and ~950 ms is fine for a command you typed.
  const agents = listAgents();
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    store.pruneStale(now);
    if (agents.length > 0) store.syncAgents(agents);
    const sessions = store.liveSessions(now);
    const claims = store.allClaims(now);
    if (sessions.length === 0) {
      console.log(dim(`No active agents in ${PROJECT.name}.`));
      return;
    }

    // A path is only worth showing once trees actually differ.
    const trees = new Set(sessions.map((s) => s.worktree).filter((w) => w !== ""));
    const showTree = trees.size > 1;
    // Any path two live agents both hold is a genuine collision worth flagging.
    const counts = new Map<string, number>();
    for (const c of claims) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);

    // Assigned across the roster so no two agents share a colour — hashing a
    // name cannot promise that once names are arbitrary (`traffic-12`).
    const palette = rosterColours(sessions, (s) => displayName(s));
    const taskCounts = store.taskCounts();
    // A session runs the scripts it loaded at start, so an install mid-flight
    // leaves the roster mixing builds with nothing to tell them apart.
    const current = installedVersion();
    const versions = store.codeVersions();
    // Kicked off HERE and never waited for. Each call is ~8 s of Haiku, so the
    // roster below prints whatever summaries already exist and these land for
    // the next `who`. Bounded by SUMMARY_TTL_MS per session, so typing `who`
    // repeatedly costs nothing extra.
    for (const stale of store.staleSummarySessions(now, SUMMARY_TTL_MS)) {
      refreshSummary(summaryWorkerPath(), stale.sessionId, stale.path, PROJECT.dbPath);
    }
    // Paths held by two agents at once — needed per-row below, so the whole
    // contested set is computed once rather than re-scanned inside the loop.
    const contestedPaths = new Set([...counts].filter(([, n]) => n > 1).map(([p]) => p));

    // MOST RECENTLY ACTIVE FIRST. Start order put whoever launched first at the
    // top, which is never the one you are looking for; the agents doing
    // something right now are.
    const ordered = [...sessions].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    // Grouped by tree, main tree first, so a worktree is labelled ONCE in a
    // heading instead of repeating "Traffic (master)" on every row. Only the
    // exception needs naming — and the old all-or-nothing `showTree` printed the
    // main tree on all six same-tree rows the moment a single worktree existed.
    // The MAIN tree is the one the most agents are in, not the one this command
    // happens to be run from: grouping against the caller's cwd would relabel
    // every row depending on which terminal typed `who`, so the same roster
    // would read differently from a worktree than from the checkout.
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
    // One column wide enough for the longest name, capped so a single verbose
    // name cannot squeeze the description column to nothing.
    const nameW = Math.min(24, Math.max(...ordered.map((s) => [...displayName(s)].length)));
    const AGE_W = 4;
    // Where the description starts, and where every continuation line aligns:
    // "  " + mark + " " + name + " " + age + "  "
    const gutter = 2 + 1 + 1 + nameW + 1 + AGE_W + 2;
    const descW = Math.max(20, width - gutter - 1);

    // ROSTER-WIDE FACTS GO IN THE HEADER. "⟲ old hooks" was printed on all seven
    // rows, which is one fact stated seven times, and it is a property of the
    // install rather than of any agent.
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
        // A filled dot for busy, hollow for idle: state reads as a SHAPE at the
        // start of the line, so the eye finds the working agents without parsing
        // a word out of the middle of each row.
        const mark = s.blocked !== "" ? red("●") : s.status === "busy" ? green("●") : dim("○");
        const seen = activityColour(now - s.lastSeenMs)(pad(shortAge(s.lastSeenMs, now), AGE_W));
        const t = taskCounts.get(s.sessionId);
        const prog = t && t.open + t.done > 0 ? dim(` [${t.done}/${t.open + t.done}]`) : "";

        // BEST AVAILABLE SOURCE, not all of them. The title is a better
        // description than `intent`, which is guessed from a single prompt and
        // gets it wrong in ways a title cannot: a compaction summary took the
        // slot on one live session, listing it as "<analysis> Let me
        // chronologically work through this convers…".
        const headline = s.title !== "" ? s.title : s.intent;
        const desc =
          headline !== ""
            ? fit(headline, descW - [...prog].length)
            : dim(fit("(no stated task)", descW));
        console.log(`  ${mark} ${paint(bold(pad(displayName(s), nameW)))} ${seen}  ${desc}${prog}`);

        // A blocked session is the one that wants attention, so it gets its own
        // line in red rather than a word buried in the row above.
        if (s.blocked !== "") console.log(`${" ".repeat(gutter)}${red(fit(s.blocked, descW))}`);
        // What the session is doing NOW, which the title cannot say: a title is
        // set from the opening subject and does not move as the work does.
        if (s.summary !== "") console.log(`${" ".repeat(gutter)}${cyan(fit(s.summary, descW))}`);

        const mine = claims.filter((c) => c.handle === s.handle).map((c) => c.path);
        if (mine.length === 0) continue;
        const pieces = summarizeFiles(mine, { contested: contestedPaths });
        if (pieces.length === 0) continue;
        // Red marks ONLY a path two agents hold at once — the single entry here
        // that needs a decision. Everything else is dim, so the line reads as
        // context until something on it is actually contested.
        const line = renderFileLine(pieces, descW - 2, { contested: red, normal: dim });
        if (line === "") continue;
        console.log(`${" ".repeat(gutter)}${dim("✎")} ${line}`);
      }
    }

    // ONE TREE OR TWO is the whole question. Two agents editing one path in one
    // checkout are about to overwrite each other; two agents editing it in
    // separate worktrees are editing different files that merge later, which is
    // ordinary parallel work. Colouring both red made the warning meaningless —
    // a master session and a worktree session on `waterTexture.ts` read exactly
    // like an imminent clobber.
    const contested = [...counts]
      .filter(([, n]) => n > 1)
      .map(([path]) => {
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
function log(limit: number): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const msgs = store.recent(limit);
    if (msgs.length === 0) {
      console.log(dim("Log is empty."));
      return;
    }
    for (const m of msgs) {
      // Right-aligned and bracket-free: `[1m ago]` reads as a stray ANSI code
      // (ESC[1m is bold), which is genuinely confusing in a colourised log.
      const when = dim(agoText(m.tsMs, now).padStart(9));
      const paint = handleColour(m.from);
      if (m.kind === "note") {
        console.log(`${when} ${yellow(bold("you → everyone"))}: ${m.body}`);
      } else if (m.kind === "say") {
        // The arrow is the point of this view: who spoke, and to whom.
        const to = m.to !== "" ? bold(handleColour(m.to)(m.to)) : dim("everyone");
        console.log(`${when} ${paint(bold(m.from))} ${dim("→")} ${to}: ${m.body}`);
      } else if (m.kind === "claim") {
        console.log(`${when} ${paint(m.from)} ${red("claim")} ${dim(m.body)}`);
      } else {
        console.log(`${when} ${paint(m.from)} ${dim(`${m.kind}: ${m.body}`)}`);
      }
    }
  });
}

/**
 * Broadcast to every agent.
 *
 * An agent calling this speaks as ITSELF, not as you: `note` is the kind that
 * carries the operator's words and outranks peer text wherever it is rendered,
 * so letting a session post one would let it issue instructions in your voice.
 */
function say(text: string): void {
  const from = withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    // An agent whose row was reaped must NOT fall through to the operator's
    // handle. `note` renders as "the user, to everyone" and outranks peer text
    // wherever it appears, so that fallback turned a bookkeeping miss into a
    // live agent broadcasting in the user's voice — the exact forgery the
    // sender-identity work was meant to prevent, reachable with no malice at
    // all. A session that identifies itself is an agent whether or not the
    // roster still has a row for it.
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
 * the message is from you, the operator.
 *
 * Delivery is scoped, not secret: only the recipient is SHOWN the message, but
 * every agent can read the db file directly. Good for keeping contexts clean;
 * not a channel for anything you would not want all your sessions to see.
 */
function msg(target: string, text: string, from: string | undefined): void {
  const result = withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const to = store.findByName(target, now);
    if (!to) return { ok: false as const, live: store.liveSessions(now) };

    // Explicit `--from` wins (it is how you speak AS an agent); otherwise the
    // environment identifies an agent caller, and only a genuine terminal —
    // one with no Claude session around it — speaks as the operator.
    let handle = HUMAN_HANDLE;
    let fromLabel = "you";
    if (from !== undefined) {
      const sender = store.findByName(from, now);
      if (!sender) return { ok: false as const, live: store.liveSessions(now), badFrom: true };
      handle = sender.handle;
      fromLabel = displayName(sender);
    } else if (ENV_SESSION !== "") {
      // Same rule as `say`: a caller that identifies itself as a session is an
      // agent, and never speaks as the operator even if its row was reaped.
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

/** Which db this repo maps to — the first thing to check when a roster is empty. */
function where(): void {
  const note = PROJECT.isGit ? "" : dim("  (no git repo — keyed on directory)");
  console.log(`${dim("project:")} ${bold(PROJECT.name)}`);
  console.log(`${dim("key:    ")} ${cyan(PROJECT.key)}${note}`);
  console.log(`${dim("root:   ")} ${PROJECT.root}`);
  console.log(`${dim("db:     ")} ${PROJECT.dbPath}`);
}

const [cmd, ...rest] = Bun.argv.slice(2);
switch (cmd) {
  case "who":
  case undefined:
    who();
    break;
  case "log":
    log(Number(rest[0] ?? 20) || 20);
    break;
  case "say": {
    const text = rest.join(" ").trim();
    if (!text) {
      console.error("usage: cli.ts say <text>");
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
      console.error('usage: cli.ts msg <name> "<text>" [--from <name>]');
      process.exit(1);
    }
    msg(target, text, from);
    break;
  }
  case "clear":
    clear();
    break;
  case "where":
    where();
    break;
  default:
    console.error(
      `unknown command: ${cmd}\n` +
        'usage: who | log [n] | msg <name> "<text>" [--from <name>] | say <text> | clear | where',
    );
    process.exit(1);
}
