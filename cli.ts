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
 * And the work board — what each agent is doing, as a timeline:
 *
 *   bun cli.ts doing "<subject>" [--plan "a; b; c"]   # open an item
 *   bun cli.ts did <n> ["<what changed>"]             # tick step n off
 *   bun cli.ts step <n> "<status>"                    # in progress, not finished
 *   bun cli.ts add "<step>"                           # a phase the plan missed
 *   bun cli.ts done [<subject match>] [--abandoned]   # close ONE item
 *   bun cli.ts board [<agent>] [--history] [--all]    # read the board  [--raw]
 *   bun cli.ts mine                                   # my open items
 *
 * The project is resolved from the CWD exactly as the hooks resolve it, so
 * running this from any worktree reads that repo's roster.
 *
 * `say` exists because you are the only participant who can see all four
 * sessions at once; it is how you tell them something without retyping it four
 * times. It posts under a fixed handle so agents can tell it from a peer.
 */

import {
  agoText,
  claimName,
  displayName,
  operatorNames,
  rosterName,
  withStore,
} from "./core/store.ts";
import { installedVersion, resolveProject } from "./core/repo.ts";
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
} from "./core/layout.ts";
import { agentKey, BOARD_OPEN_SHOWN, foldEvents, parsePlan, progress } from "./core/work.ts";
import { validateAlias, validateRole } from "./core/topic.ts";
import { minionName } from "./core/names.ts";
import { dirtyFiles } from "./core/dirty.ts";
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
function who(raw: boolean): void {
  // Refreshed on every `who`: you are asking precisely because you want the
  // current picture, and ~950 ms is fine for a command you typed.
  const agents = listAgents();
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    store.pruneStale(now);
    if (agents.length > 0) store.syncAgents(agents);
    const sessions = store.liveSessions(now);
    const claims = store.allClaims(now);
    // Swept here as well as on SubagentStop: a parent that CRASHED never fires
    // Stop, so its minions would read as running until someone else's did.
    store.pruneMinions(now);
    const minions = store.liveMinions(now);
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
    // A COMMITTED FILE IS NOT CONTESTED. Red is the roster's only alarm colour
    // and it is worth exactly what it is spent on: measured 2026-08-01, 38 of 42
    // live claims were on files with no uncommitted changes, so most of what
    // this marked had already been resolved by a commit. `git status` is ~40 ms
    // per worktree, paid once here for a command the operator typed — and only
    // for paths that two agents actually hold.
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
    // Measured on the ROSTER name ("Luna — Tooling Master"), which is what this
    // column prints — not on the bare name peers type. Cap raised to suit:
    // "Keeper of Wet Things Luna" is 25, and truncating the role to fit would
    // remove exactly the part that makes an agent recognisable at a glance.
    // 34 fits the longest real roster name measured ("Adela — Road Network
    // Retirement", 31) with room for the em-dash form to grow a little. The cap
    // exists so one verbose name cannot squeeze the description column to
    // nothing, not to force truncation on ordinary ones — and truncating here
    // eats the ROLE, which is the half that says who somebody is.
    const nameW = Math.min(
      34,
      Math.max(...ordered.map((s) => [...(raw ? displayName(s) : rosterName(s))].length)),
    );
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
        // `--raw` prints the name peers TYPE, which is what you want when you
        // are about to `msg` someone or are debugging why a match failed.
        const shown = raw ? displayName(s) : rosterName(s);
        console.log(`  ${mark} ${paint(bold(pad(fit(shown, nameW), nameW)))} ${seen}  ${desc}${prog}`);

        // A blocked session is the one that wants attention, so it gets its own
        // line in red rather than a word buried in the row above.
        if (s.blocked !== "") console.log(`${" ".repeat(gutter)}${red(fit(s.blocked, descW))}`);
        // What the session is doing NOW, which the title cannot say: a title is
        // set from the opening subject and does not move as the work does.
        if (s.summary !== "") console.log(`${" ".repeat(gutter)}${cyan(fit(s.summary, descW))}`);

        // MINIONS BEFORE FILES, because they are the reason the files are
        // moving. A parent shows what it has running; the minion itself never
        // gets a roster row, since it cannot be addressed and would only pad
        // the count with something nobody can act on.
        const mySpawn = minions.get(s.sessionId) ?? [];
        // Sized on the MINION labels, not on `nameW`: these are longer than an
        // agent name ("Hopper's Minion #12" against "Hopper") and start two
        // columns further in, so borrowing the roster's width truncated every
        // one to `hoppe…` — a column that hides the number is worse than no
        // column, since the number is the only part that differs between them.
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
    // Reads `contestedPaths`, not `counts` — the summary and the per-row marker
    // must agree, and re-deriving from counts here would list a file as
    // contested that the rows above had already ruled out as committed.
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
  const name = self
    ? displayName(self)
    : (store.handleFor(ENV_SESSION) ?? ENV_SESSION.slice(0, 8));
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
function doing(subject: string, plan: string): void {
  withStore(PROJECT.dbPath, (store) => {
    const me = callerIdentity(store);
    if (!me) return notAnAgent("`doing`");
    const now = Date.now();
    const steps = parsePlan(plan);
    const workId = store.work.open(me.agentId, me.agentName, subject, steps, now);
    console.log(`${cyan("▸")} ${bold(subject)} ${dim(`— work #${workId}`)}`);
    for (const [i, s] of steps.entries()) console.log(`    ${dim(String(i + 1))}  ${s}`);
    if (steps.length === 0) {
      console.log(dim("    no checklist — `cli.ts add \"<step>\"` if phases appear"));
    }
    console.log(dim(`  Peers see it with \`cli.ts board\`. Close it with \`cli.ts done\`.`));
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
    for (const [, group] of byAgent) {
      const first = group[0];
      if (!first) continue;
      const open = group.filter((i) => i.closedMs === 0);
      const closed = group.length - open.length;
      // The tally counts what is IN this view: with closed items hidden, saying
      // "1 closed" beside a board that shows none is a claim the reader cannot
      // check. The `--all` hint below is how they get at them instead.
      const tally = agentTally(open.length, opts.all || opts.history ? closed : 0);
      // Through the same resolver `who` and `log` use, so one agent reads the
      // same way in all three. `--raw` keeps the frozen name for debugging.
      const stored = first.agentName !== "" ? first.agentName : first.agentId;
      const name = opts.raw ? stored : showName(stored);
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

const [cmd, ...rest] = Bun.argv.slice(2);
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
  case "quit": {
    const target = rest[0];
    if (!target) {
      console.error("usage: cli.ts quit <name>");
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
    const subject = args.join(" ").trim();
    if (!subject) {
      console.error('usage: cli.ts doing "<subject>" [--plan "step a; step b; step c"]');
      process.exit(1);
    }
    doing(subject, plan);
    break;
  }
  case "did": {
    const args = [...rest];
    const n = Number(args.shift());
    const match = takeFlag(args, "--item");
    if (!Number.isInteger(n) || n < 1) {
      console.error('usage: cli.ts did <n> ["<what changed>"] [--item <subject match>]');
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
      console.error('usage: cli.ts step <n> "<status>" [--item <subject match>]');
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
      console.error('usage: cli.ts add "<step>" [--item <subject match>]');
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
  case "mine":
    mine();
    break;
  case "call-me":
  case "name": {
    const args = [...rest];
    const target = takeFlag(args, "--agent");
    const name = args.join(" ").trim();
    if (!name) {
      console.error("usage: cli.ts call-me <name> [--agent <who>]");
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
      console.error("usage: cli.ts files <agent> [--hours 24]");
      process.exit(1);
    }
    filesOf(target, hours);
    break;
  }
  case "blame": {
    const path = rest.join(" ").trim();
    if (!path) {
      console.error("usage: cli.ts blame <path>");
      process.exit(1);
    }
    blame(path);
    break;
  }
  case "call-you":
  case "role": {
    const args = [...rest];
    const target = takeFlag(args, "--agent");
    const role = args.join(" ").trim();
    if (!role) {
      console.error('usage: cli.ts call-you "<role>" [--agent <who>]');
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
  default:
    console.error(
      `unknown command: ${cmd}\n` +
        "usage: who | log [n] | msg <name> \"<text>\" [--from <name>] | say <text> | " +
        "quit <name> | clear | where\n" +
        '       doing "<subject>" [--plan "a; b; c"] | did <n> ["<what changed>"] | ' +
        'step <n> "<status>" | add "<step>"\n' +
        "       done [<subject match>] [--abandoned] | board [<agent>] [--history] [--all] | mine",
    );
    process.exit(1);
}

/** Pulls `--flag <value>` out of an arg list, returning "" when absent. */
function takeFlag(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  if (i < 0) return "";
  const value = args[i + 1] ?? "";
  args.splice(i, 2);
  return value;
}
