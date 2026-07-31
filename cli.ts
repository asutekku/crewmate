/**
 * Human-facing view of the presence store, and a way to post into it by hand.
 *
 *   bun cli.ts who          # roster + claims
 *   bun cli.ts log [n]      # recent messages
 *   bun cli.ts say <text>   # post as "human"
 *   bun cli.ts clear        # wipe roster
 *   bun cli.ts where        # which project/db this directory maps to
 *
 * The project is resolved from the CWD exactly as the hooks resolve it, so
 * running this from any worktree reads that repo's roster.
 *
 * `say` exists because you are the only participant who can see all four
 * sessions at once; it is how you tell them something without retyping it four
 * times. It posts under a fixed handle so agents can tell it from a peer.
 */

import { agoText, withStore } from "./store.ts";
import { resolveProject } from "./repo.ts";
import { activityColour, bold, cyan, dim, handleColour, red, yellow } from "./colour.ts";

const HUMAN_HANDLE = "human";

/**
 * Resolved from the CWD, so running this from any worktree reads that repo's
 * roster — the same key the hooks use.
 */
const PROJECT = resolveProject(process.cwd());

/**
 * The roster, built for a terminal rather than for an agent's context.
 *
 * This does NOT colourise `formatRoster`'s output: the two audiences want
 * different text. An agent needs the trust framing ("asked to:") on every line;
 * a human scanning four sessions wants density, and gets the same distinctions
 * from colour. Both read the same store, so they cannot disagree on the facts.
 */
function who(): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    store.pruneStale(now);
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

    console.log(bold(`${sessions.length} active agent(s) in ${PROJECT.name}:`));
    for (const s of sessions) {
      const paint = handleColour(s.handle);
      const age = now - s.lastSeenMs;
      const where = showTree && s.worktree !== "" ? dim(` ${s.worktree.split("/").pop() ?? ""}`) : "";
      const branch = s.branch !== "" ? dim(` (${s.branch})`) : "";
      const seen = activityColour(age)(agoText(s.lastSeenMs, now));
      const task = s.intent !== "" ? `"${s.intent}"` : dim("(no stated task yet)");
      console.log(`  ${paint(bold(s.handle))}${where}${branch}  ${task}  ${dim("·")} ${seen}`);

      const mine = claims.filter((c) => c.handle === s.handle);
      if (mine.length === 0) continue;
      const shown = mine.slice(0, 6).map((c) => {
        // Red marks a path another live agent also holds — the one thing in this
        // view that wants action, so it is the only red.
        const shared = (counts.get(c.path) ?? 0) > 1;
        return shared ? red(`${c.path} ⚠`) : dim(c.path);
      });
      const more = mine.length > shown.length ? dim(` +${mine.length - shown.length} more`) : "";
      console.log(`      ${dim("editing")} ${shown.join(dim(", "))}${more}`);
    }

    const contested = [...counts].filter(([, n]) => n > 1);
    if (contested.length > 0) {
      console.log();
      console.log(red(`⚠ ${contested.length} file(s) claimed by more than one agent:`));
      for (const [path, n] of contested) {
        const who = claims.filter((c) => c.path === path).map((c) => handleColour(c.handle)(c.handle));
        console.log(`    ${path} ${dim("—")} ${who.join(dim(", "))} ${dim(`(${n} agents)`)}`);
      }
    }
  });
}

/**
 * The message log. Human words (`tasked`, `note`) are shown in full colour and
 * attributed; agent chatter is dimmed, because when you are scanning for what
 * you or another user asked for, the agent's own bookkeeping is the background.
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
      const paint = handleColour(m.handle);
      if (m.kind === "tasked") {
        console.log(`${when} ${paint(m.handle)} ${dim("was asked by its user:")} ${m.body}`);
      } else if (m.kind === "note") {
        console.log(`${when} ${yellow(bold("the user broadcast to everyone:"))} ${m.body}`);
      } else if (m.kind === "claim") {
        console.log(`${when} ${paint(m.handle)} ${red("claim")} ${dim(m.body)}`);
      } else {
        console.log(`${when} ${paint(m.handle)} ${dim(`${m.kind}: ${m.body}`)}`);
      }
    }
  });
}

function say(text: string): void {
  withStore(PROJECT.dbPath, (store) => {
    store.post(HUMAN_HANDLE, "note", text, Date.now());
  });
  console.log(`${yellow("broadcast")} to ${bold(PROJECT.name)}: ${text}`);
  console.log(dim("Every agent sees this on its next turn, marked as from you."));
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
  case "clear":
    clear();
    break;
  case "where":
    where();
    break;
  default:
    console.error(`unknown command: ${cmd}\nusage: who | log [n] | say <text> | clear | where`);
    process.exit(1);
}
