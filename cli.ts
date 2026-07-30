/**
 * Human-facing view of the presence store, and a way to post into it by hand.
 *
 *   bun .claude/hooks/presence/cli.ts who          # roster + claims
 *   bun .claude/hooks/presence/cli.ts log [n]      # recent messages
 *   bun .claude/hooks/presence/cli.ts say <text>   # post as "human"
 *   bun .claude/hooks/presence/cli.ts clear        # wipe all state
 *
 * `say` exists because you are the only participant who can see all four
 * sessions at once; it is how you tell them something without retyping it four
 * times. It posts under a fixed handle so agents can tell it from a peer.
 */

import { agoText, withStore } from "./store.ts";
import { formatRoster } from "./shared.ts";

const HUMAN_HANDLE = "human";

function who(): void {
  withStore((store) => {
    const now = Date.now();
    store.pruneStale(now);
    const sessions = store.liveSessions(now);
    const claims = store.allClaims(now);
    if (sessions.length === 0) {
      console.log("No active agents.");
      return;
    }
    console.log(`${sessions.length} active agent(s):`);
    // No session is "self" here, so nothing is filtered from the cwd column.
    console.log(formatRoster(sessions, claims, now, "").join("\n"));
  });
}

function log(limit: number): void {
  withStore((store) => {
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
  withStore((store) => {
    store.post(HUMAN_HANDLE, "note", text, Date.now());
  });
  console.log(`posted as ${HUMAN_HANDLE}: ${text}`);
}

function clear(): void {
  withStore((store) => {
    const now = Date.now();
    for (const s of store.liveSessions(now)) store.unregister(s.sessionId);
  });
  console.log("Cleared sessions and claims. (Message log is kept; it self-prunes.)");
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
  default:
    console.error(`unknown command: ${cmd}\nusage: who | log [n] | say <text> | clear`);
    process.exit(1);
}
