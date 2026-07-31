/**
 * Agent-chosen names.
 *
 * A name is durable and ADDRESSABLE — peers type it into `msg`, it is frozen
 * into every message the agent sends, and it outlives the session on the work
 * board. So it is validated harder than an intent: an intent that is wrong is
 * noise for one session, a name that is wrong misroutes messages.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { displayName, rosterName, STALE_MS, withStore } from "../core/store.ts";
import { validateAlias } from "../core/topic.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-alias-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {
        /* already gone */
      }
    }
  }
});

describe("validateAlias", () => {
  test("accepts the names an agent would actually pick", () => {
    for (const name of ["tooling", "terrain-perf", "water_sim", "r4core", "a11y", "agent2"]) {
      const r = validateAlias(name);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.alias).toBe(name);
    }
  });

  test("trims surrounding whitespace rather than refusing", () => {
    const r = validateAlias("  terrain-perf  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alias).toBe("terrain-perf");
  });

  /**
   * A name is ONE WORD, because it is the thing peers type.
   *
   * `msg water dynamic "…"` parses as a message to `water` with a stray
   * argument, so a name with a space does not merely look odd — it silently
   * stops resolving. And on the roster `Water Dynamic — Keeper of Wet Things`
   * gives a reader no way to see where the name ends and the role begins.
   */
  describe("one word only", () => {
    test("refuses a name with a space", () => {
      for (const bad of ["water dynamic", "R4 core", "terrain   perf"]) {
        expect(validateAlias(bad).ok).toBe(false);
      }
    });

    test("the reason says what to type instead", () => {
      const r = validateAlias("water dynamic");
      expect(r.ok).toBe(false);
      // A refusal an agent cannot act on just gets retried with another space.
      if (!r.ok) {
        expect(r.why).toContain("water-dynamic");
        expect(r.why).toContain("call-you");
      }
    });

    test("the hyphenated repair the message suggests is itself accepted", () => {
      // The advice has to be true, or it sends the agent round the loop again.
      const r = validateAlias("water dynamic");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const suggested = /"([a-z0-9-]+)"/.exec(r.why)?.[1] ?? "";
        expect(suggested).toBe("water-dynamic");
        expect(validateAlias(suggested).ok).toBe(true);
      }
    });

    test("the store refuses one too, however it was reached", () => {
      fresh((store) => {
        const now = Date.now();
        store.register("sess", "/tree", "master", now);
        // `setAlias` is reachable without going through the CLI's validation.
        expect(store.setAlias("sess", "water dynamic", now)).toBeNull();
        expect(displayName(store.findBySession("sess")!)).not.toContain(" ");
      });
    });
  });

  test("refuses an empty name", () => {
    expect(validateAlias("").ok).toBe(false);
    expect(validateAlias("   ").ok).toBe(false);
  });

  test("refuses names that would break the line a peer copies to reply", () => {
    // Quotes and backticks end up inside `cli.ts msg <name> "…"`.
    for (const bad of ['say "hi', "back`tick", "semi;colon", "pipe|it", "$(whoami)", "a'b"]) {
      expect(validateAlias(bad).ok).toBe(false);
    }
  });

  test("refuses control characters that could rewrite a roster line", () => {
    expect(validateAlias("red" + "\u001b" + "[31m").ok).toBe(false);
    expect(validateAlias("bell" + "\u0007").ok).toBe(false);
  });

  test("a newline cannot reach the roster intact", () => {
    // The danger was never the newline character, it was a newline SURVIVING
    // into a roster line and splitting one agent into two. It used to collapse
    // to a space and be accepted; now the space itself is refused, which lands
    // in the same safe place by a shorter route. The PROPERTY is what matters:
    // whatever comes back, no accepted name contains whitespace.
    const embedded = validateAlias("two\nlines");
    expect(embedded.ok).toBe(false);
    // Surrounding whitespace is still trimmed rather than refused — a trailing
    // newline is what `$(cat file)` and a heredoc produce, and refusing that
    // would reject a name the agent typed correctly.
    const trailing = validateAlias("tooling\n");
    expect(trailing.ok).toBe(true);
    if (trailing.ok) expect(trailing.alias).toBe("tooling");
  });

  test("NOTHING accepted contains whitespace", () => {
    // The invariant behind both rules above, stated once so a future relaxation
    // of either has to break this line to get through.
    for (const candidate of ["tooling", "two lines", "two\nlines", "  spaced  out ", "a\tb", "ok\n"]) {
      const r = validateAlias(candidate);
      if (r.ok) expect(r.alias).not.toMatch(/\s/);
    }
  });

  test("refuses names reserved by the system", () => {
    // `human` is the operator's handle: an agent answering to it could post in
    // the user's voice, which is the forgery sender-identity exists to prevent.
    for (const bad of ["human", "Human", "everyone", "all", "system", "claude"]) {
      const r = validateAlias(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why).toContain("reserved");
    }
  });

  test("refuses anything that looks like a credential", () => {
    const r = validateAlias("sk_live_0123456789abcdef0123456789abcdef");
    expect(r.ok).toBe(false);
  });

  test("refuses a name too long for a roster column", () => {
    expect(validateAlias("a".repeat(25)).ok).toBe(false);
    expect(validateAlias("a".repeat(24)).ok).toBe(true);
  });
});

describe("displayName precedence", () => {
  test("chosen name, then given name, then Claude's own label", () => {
    // Claude's `traffic-NN` is LAST because it is the only one that moves: one
    // conversation carried traffic-a0, traffic-7c and traffic-56 in an
    // afternoon. Both names above it are fixed for the life of the conversation.
    expect(displayName({ alias: "tooling", name: "traffic-56", handle: "luna" })).toBe("tooling");
    expect(displayName({ alias: "", name: "traffic-56", handle: "luna" })).toBe("luna");
    expect(displayName({ alias: "", name: "traffic-56", handle: "" })).toBe("traffic-56");
  });

  test("a caller that passes no alias field still resolves", () => {
    // `post` and the claim helpers pass a narrower shape; they must not crash.
    expect(displayName({ name: "traffic-56", handle: "luna" })).toBe("luna");
  });
});

describe("setAlias", () => {
  test("names a session, and the roster reads it back", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("s1", "/tree", "master", now);
      expect(store.setAlias("s1", "tooling", now)).toBe("tooling");
      const s = store.findBySession("s1");
      expect(s && displayName(s)).toBe("tooling");
    });
  });

  test("a peer can reach the agent by its chosen name", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("s1", "/tree", "master", now);
      store.setAlias("s1", "tooling", now);
      expect(store.findByName("tooling", now)?.sessionId).toBe("s1");
      // And by a prefix, like every other name form.
      expect(store.findByName("tool", now)?.sessionId).toBe("s1");
    });
  });

  test("two live agents cannot answer to one name", () => {
    // Ambiguity here is not cosmetic: `msg <name>` would have two recipients.
    fresh((store) => {
      const now = Date.now();
      store.register("s1", "/tree", "master", now);
      store.register("s2", "/tree", "master", now);
      expect(store.setAlias("s1", "tooling", now)).toBe("tooling");
      expect(store.setAlias("s2", "tooling", now)).toBeNull();
      expect(store.setAlias("s2", "Tooling", now)).toBeNull();
      expect(displayName(store.findBySession("s2")!)).not.toBe("tooling");
    });
  });

  test("renaming yourself to the name you already hold is not a collision", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("s1", "/tree", "master", now);
      store.setAlias("s1", "tooling", now);
      expect(store.setAlias("s1", "tooling", now)).toBe("tooling");
    });
  });

  test("a name freed by a dead session is reusable", () => {
    // Matches how handles are recycled: holding a name against an agent that
    // left hours ago drifts every later agent down the list.
    fresh((store) => {
      const now = Date.now();
      store.register("s1", "/tree", "master", now - STALE_MS - 1000);
      store.setAlias("s1", "tooling", now - STALE_MS - 1000);
      store.register("s2", "/tree", "master", now);
      expect(store.setAlias("s2", "tooling", now)).toBe("tooling");
    });
  });

  test("a chosen name survives a claude-agents sync", () => {
    // THE TRAP THIS COLUMN EXISTS FOR: `syncAgents` overwrites `name` wholesale
    // from `claude agents --json` on every roster read, so a chosen name stored
    // there would revert at the next `who` — visibly, minutes later.
    fresh((store) => {
      const now = Date.now();
      store.register("s1", "/tree", "master", now);
      store.setAlias("s1", "tooling", now);
      store.syncAgents([{ sessionId: "s1", name: "traffic-56", status: "busy" }]);
      const s = store.findBySession("s1");
      expect(displayName(s!)).toBe("tooling");
      // The underlying session name is still recorded — the alias layers over it.
      expect(s?.name).toBe("traffic-56");
    });
  });

  test("an overlap warning names the agent the way the roster does", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("s1", "/tree", "master", now);
      store.register("s2", "/tree", "master", now);
      store.syncAgents([{ sessionId: "s1", name: "traffic-56", status: "busy" }]);
      store.setAlias("s1", "tooling", now);
      store.claim("s1", "src/gen/terrain.ts", now);
      // A warning calling it `traffic-56` while the roster says `tooling` reads
      // as two different agents holding the same file.
      expect(store.conflictingClaims("s2", "src/gen/terrain.ts", now)[0]?.name).toBe("tooling");
      expect(store.allClaims(now)[0]?.name).toBe("tooling");
    });
  });

  test("a message carries the chosen name as its sender", () => {
    fresh((store) => {
      const now = Date.now();
      const handle = store.register("s1", "/tree", "master", now);
      store.setAlias("s1", "tooling", now);
      store.post(handle, "say", "hello", now);
      expect(store.recent(1)[0]?.from).toBe("tooling");
    });
  });

});

describe("a name survives a restart", () => {
  // MEASURED, not assumed (2026-07-31): CLAUDE_CODE_SESSION_ID is the
  // CONVERSATION uuid — the transcript's own filename, and what
  // "claude --resume" takes. This tool's conversation was restarted mid-session:
  // the display name moved traffic-a0 -> traffic-7c while the id stayed
  // c5ce05bc-… throughout. So a restart is the SAME id, and the only thing that
  // loses the name is SessionEnd deleting the row.
  const ID = "c5ce05bc-4024-45ef-8cb0-67c0c08d323d";

  test("a clean exit and relaunch comes back under the chosen name", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "tooling", now);

      // SessionEnd on a double ⌃C: the row goes, the id does not.
      store.unregister(ID);
      expect(store.findBySession(ID)).toBeNull();

      store.registerAndRestore(ID, "/tree", "master", now);
      expect(displayName(store.findBySession(ID)!)).toBe("tooling");
    });
  });

  test("a name survives a KILLED terminal too, where SessionEnd never runs", () => {
    // The name is recorded durably when it is CHOSEN, not only when the session
    // exits politely — a name that survives only a clean exit is backwards.
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "tooling", now);
      // No unregister: the process was killed. The stale sweep takes the row.
      store.pruneStale(now + STALE_MS + 1000);

      store.registerAndRestore(ID, "/tree", "master", now + STALE_MS + 2000);
      expect(displayName(store.findBySession(ID)!)).toBe("tooling");
    });
  });

  test("RENAMING THE CONVERSATION does not lose the name", () => {
    // The reason this is keyed on the id and not the title: a title is
    // model-written and rewritten as a conversation develops, so title-keying
    // orphaned a name the moment the conversation was renamed.
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setTitle(ID, "Explore cheap agent communication solutions");
      store.setAlias(ID, "tooling", now);
      store.unregister(ID);

      store.registerAndRestore(ID, "/tree", "master", now);
      store.setTitle(ID, "Something the model renamed it to later");
      expect(displayName(store.findBySession(ID)!)).toBe("tooling");
    });
  });

  test("an untitled session keeps its name — the title is not consulted at all", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "tooling", now);
      store.unregister(ID);
      store.registerAndRestore(ID, "/tree", "master", now);
      expect(displayName(store.findBySession(ID)!)).toBe("tooling");
    });
  });

  test("a different conversation gets nothing", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "tooling", now);
      store.unregister(ID);

      store.registerAndRestore("a-different-uuid", "/tree", "master", now);
      expect(displayName(store.findBySession("a-different-uuid")!)).not.toBe("tooling");
    });
  });

  test("a name a LIVE peer answers to is not restored onto a second session", () => {
    // Two agents on one name makes every msg to it ambiguous.
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "tooling", now);
      store.unregister(ID);
      // Someone else took the freed name in the meantime.
      store.register("other", "/tree", "master", now);
      store.setAlias("other", "tooling", now);

      store.registerAndRestore(ID, "/tree", "master", now);
      expect(displayName(store.findBySession(ID)!)).not.toBe("tooling");
      expect(displayName(store.findBySession("other")!)).toBe("tooling");
    });
  });

  test("a name chosen after the restart wins over the remembered one", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "tooling", now);
      store.unregister(ID);

      store.registerAndRestore(ID, "/tree", "master", now);
      store.setAlias(ID, "terrain-perf", now);
      expect(displayName(store.findBySession(ID)!)).toBe("terrain-perf");
      // And it is the NEW one that comes back next time.
      store.unregister(ID);
      store.registerAndRestore(ID, "/tree", "master", now);
      expect(displayName(store.findBySession(ID)!)).toBe("terrain-perf");
    });
  });

  test("the restored name reaches peers, the board and the log", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "tooling", now);
      store.unregister(ID);
      store.registerAndRestore(ID, "/tree", "master", now);

      expect(store.findByName("tooling", now)?.sessionId).toBe(ID);
      const handle = store.findBySession(ID)!.handle;
      store.post(handle, "say", "back again", now);
      expect(store.recent(1)[0]?.from).toBe("tooling");
    });
  });
});

/**
 * The roster and `msg` must agree about who someone is.
 *
 * These are two functions with two audiences, and they drifted: `rosterName`
 * resolved a name from `handle` while `displayName` resolved it from `alias`,
 * so one agent read `Tooling — Tooling Master` on the roster and answered to
 * `hopper` at `msg`. The operator caught it before any test did, because every
 * test compared a name to a literal instead of comparing the two functions.
 */
describe("the roster name and the addressable name are the same name", () => {
  const ID = "roster-agreement";

  test("a chosen name is what the roster leads with", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "hopper", now);
      store.setRole(ID, "Tooling Master");

      const s = store.findBySession(ID)!;
      expect(rosterName(s)).toBe("Hopper — Tooling Master");
      // The invariant, not the literal: whatever a peer types is what the
      // operator reads, modulo capitalisation and the role suffix.
      expect(rosterName(s).split(" — ")[0]?.toLowerCase()).toBe(displayName(s).toLowerCase());
    });
  });

  test("the topic handle becomes the role when no role is set", () => {
    fresh((store) => {
      const now = Date.now();
      store.register(ID, "/tree", "master", now);
      store.setAlias(ID, "turing", now);

      const s = store.findBySession(ID)!;
      // NOT "Turing — ..." with the handle leading: the handle describes the
      // work, so it stands in for the missing role, never for the name.
      expect(rosterName(s).startsWith("Turing")).toBe(true);
      expect(displayName(s)).toBe("turing");
    });
  });

  test("the two agree for every combination of the three name fields", () => {
    fresh((store) => {
      const now = Date.now();
      for (const [alias, role] of [
        ["", ""],
        ["hopper", ""],
        ["", "Tooling Master"],
        ["hopper", "Tooling Master"],
      ] as const) {
        const id = `${ID}-${alias}-${role}`;
        store.register(id, "/tree", "master", now);
        if (alias !== "") store.setAlias(id, alias, now);
        if (role !== "") store.setRole(id, role);

        const s = store.findBySession(id)!;
        const lead = rosterName(s).split(" — ")[0] ?? "";
        expect(lead.toLowerCase()).toBe(displayName(s).toLowerCase());
      }
    });
  });
});
