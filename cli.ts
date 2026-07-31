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
import { formatRoster } from "./shared.ts";
import { resolveProject } from "./repo.ts";

const HUMAN_HANDLE = "human";

/**
 * Resolved from the CWD, so running this from any worktree reads that repo's
 * roster — the same key the hooks use.
 */
const PROJECT = resolveProject(process.cwd());

function who(): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    store.pruneStale(now);
    const sessions = store.liveSessions(now);
    const claims = store.allClaims(now);
    if (sessions.length === 0) {
      console.log(`No active agents in ${PROJECT.name}.`);
      return;
    }
    console.log(`${sessions.length} active agent(s) in ${PROJECT.name}:`);
    // Passing "" as self means every peer's worktree is shown, which is what a
    // human wants: the hooks hide the current tree, the overview should not.
    console.log(formatRoster(sessions, claims, now, "").join("\n"));
  });
}

function log(limit: number): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    const msgs = store.recent(limit);
    if (msgs.length === 0) {
      console.log("Log is empty.");
      return;
    }
    for (const m of msgs) {
      console.log(`[${agoText(m.tsMs, now)}] ${m.handle} ${m.kind}: ${m.body}`);
    }
  });
}

function say(text: string): void {
  withStore(PROJECT.dbPath, (store) => {
    store.post(HUMAN_HANDLE, "note", text, Date.now());
  });
  console.log(`posted to ${PROJECT.name} as ${HUMAN_HANDLE}: ${text}`);
}

function clear(): void {
  withStore(PROJECT.dbPath, (store) => {
    const now = Date.now();
    for (const s of store.liveSessions(now)) store.unregister(s.sessionId);
  });
  console.log("Cleared sessions and claims. (Message log is kept; it self-prunes.)");
}

/** Which db this repo maps to — the first thing to check when a roster is empty. */
function where(): void {
  console.log(`project: ${PROJECT.name}`);
  console.log(`key:     ${PROJECT.key}${PROJECT.isGit ? "" : "  (no git repo — keyed on directory)"}`);
  console.log(`root:    ${PROJECT.root}`);
  console.log(`db:      ${PROJECT.dbPath}`);
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
