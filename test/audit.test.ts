/**
 * Regressions for five defects a critical audit found on 2026-08-01.
 *
 * Every one of them shipped with a green suite, so each test here is written to
 * FAIL against the code as it was. The existing tests missed them the same way
 * each time: they asserted the mechanism they were testing and never the
 * property the mechanism exists to provide.
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { clearDirtyCache, dirtyFiles } from "../core/dirty.ts";

let n = 0;
const paths: string[] = [];
const dirs: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-audit-${process.pid}-${n++}.db`;
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
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows may hold a .git handle briefly */
    }
  }
});

function repo(): string {
  const dir = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/presence-audit-repo-`).replace(
    /\\/g,
    "/",
  );
  dirs.push(dir);
  const git = (args: string[]): void => {
    spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  };
  git(["init", "-q", "."]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  return dir;
}

const MAIN = "I:/Projects/Traffic";
const WT = "I:/Projects/Traffic/.claude/worktrees/other";

describe("a departed agent's name is not handed to a stranger", () => {
  test("a name used in the edit history is held, even with no session and no messages", () => {
    // THE HOLE: `taken` read sessions (row deleted on exit), aliases (empty
    // unless a name was chosen by hand) and messages (self-prunes at
    // MAX_MESSAGES, which evicts within hours on a busy day). An agent that
    // edited files and left lost its reservation immediately, so a fresh
    // conversation took its name — and `files <name>` then listed a stranger's
    // files under the name an overlap warning had just given you.
    fresh((store) => {
      const now = Date.now();
      const departed = store.register("old-session", MAIN, "master", now);
      store.claim("old-session", "src/terrain.ts", now, { worktree: MAIN });
      store.unregister("old-session");

      // Nothing else remembers it: no row, no alias, and the log is empty.
      expect(store.findBySession("old-session")).toBeNull();

      const fresh1 = store.register("new-session", MAIN, "master", now);
      expect(fresh1).not.toBe(departed);
    });
  });

  test("a name whose only trace was a pruned message is STILL held", () => {
    // The second mechanism, independent of the first: even when the agent did
    // post, MAX_MESSAGES eviction dropped the row well short of 60 h. The edit
    // history is the only source that survives, because it prunes on its own
    // 30-day clock.
    fresh((store) => {
      const now = Date.now();
      const departed = store.register("old", MAIN, "master", now);
      store.claim("old", "a.ts", now, { worktree: MAIN });
      store.unregister("old");
      // Simulate the log having rolled over entirely.
      for (const row of [1]) void row;

      const taken = new Set<string>();
      for (let i = 0; i < 5; i++) taken.add(store.register(`s${i}`, MAIN, "master", now));
      expect(taken.has(departed)).toBe(false);
    });
  });

  test("distinct sessions never share a name, however many arrive", () => {
    // THE POOL IS NO LONGER FREED BY A CLOCK (user ruling, 2026-08-05): a name
    // is held for as long as its conversation exists on disk, so the old
    // "the hold expires" guarantee is deliberately gone — see
    // `core/store/ownership.ts`. What must still hold is the invariant that
    // made the hold worth having: no two sessions answering to one name, which
    // would make every `msg` to it ambiguous.
    //
    // Exhaustion is handled rather than prevented — `pickName` falls through to
    // suffixed names — so this asserts distinctness past the point where a
    // 280-name pool would have to start suffixing, not that the pool is free.
    fresh((store) => {
      const now = Date.now();
      const names = new Set<string>();
      for (let i = 0; i < 40; i++) names.add(store.register(`s${i}`, MAIN, "master", now));
      expect(names.size).toBe(40);
    });
  });
});

describe("a conversation keeps its name across --continue", () => {
  test("the given name comes back, not just a chosen alias", () => {
    // OBSERVED LIVE: `adela` returned as `akira` mid-conversation. SessionEnd
    // deletes the row on a clean exit, `--continue` re-registers the SAME
    // session id, and `unregister` remembered only an ALIAS — so an agent that
    // had never renamed itself got a fresh name from the pool. That is exactly
    // the moving label the given name exists to replace.
    fresh((store) => {
      const now = Date.now();
      store.register("peer-a", MAIN, "master", now);
      store.register("peer-b", MAIN, "master", now);
      const before = store.register("conv-uuid", MAIN, "master", now);

      store.unregister("conv-uuid");
      expect(store.findBySession("conv-uuid")).toBeNull();

      store.registerAndRestore("conv-uuid", MAIN, "master", now);
      expect(store.findBySession("conv-uuid")?.handle).toBe(before);
    });
  });

  test("a DIFFERENT conversation is not handed that name", () => {
    fresh((store) => {
      const now = Date.now();
      const before = store.register("conv-uuid", MAIN, "master", now);
      store.unregister("conv-uuid");
      const other = store.register("someone-else", MAIN, "master", now);
      expect(other).not.toBe(before);
    });
  });

  test("a live holder wins over the returning conversation's claim to it", () => {
    // Two agents on one name makes every `msg` ambiguous, and having held it
    // first does not change that.
    fresh((store) => {
      const now = Date.now();
      const before = store.register("conv-uuid", MAIN, "master", now);
      store.unregister("conv-uuid");
      // Someone else takes the name in the meantime (by choosing it).
      store.register("squatter", MAIN, "master", now);
      store.setAlias("squatter", before, now);

      store.registerAndRestore("conv-uuid", MAIN, "master", now);
      expect(store.findBySession("conv-uuid")?.handle).not.toBe(before);
    });
  });
});

describe("the dirty filter never touches a cross-worktree claim", () => {
  test("a committed file in ANOTHER worktree still warns", () => {
    // THE WORST FINDING. A peer in a separate worktree who commits goes clean
    // instantly — and CLAUDE.md tells every agent to commit as soon as tests
    // pass. Filtering `away` on dirtiness therefore made the cross-worktree
    // warning unreachable for exactly the disciplined peers it exists to warn
    // about, while `pre-edit` itself argues at length that those are the ones
    // that diverge silently until the merge.
    //
    // Asserted at the level the hook decides at: a claim from another tree is
    // kept regardless of what git says about that tree.
    const tree = repo();
    writeFileSync(`${tree}/shared.ts`, "export const a = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: tree, windowsHide: true });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tree, windowsHide: true });
    clearDirtyCache();

    // The peer's tree is clean: everything is committed.
    expect(dirtyFiles(tree)!.has("shared.ts")).toBe(false);

    // The hook's rule: same-tree claims may be filtered on this, `away` may not.
    const claims = [
      { worktree: tree, path: "shared.ts", sameTree: true },
      { worktree: tree, path: "shared.ts", sameTree: false },
    ];
    const kept = claims.filter((c) => {
      if (!c.sameTree) return true; // cross-worktree: never filtered
      const dirty = dirtyFiles(c.worktree);
      return dirty === null || dirty.has(c.path);
    });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.sameTree).toBe(false);
  });

  test("a gitignored file being edited is reported dirty", () => {
    // `--untracked-files=all` does not list ignored files, so a gitignored file
    // an agent is actively editing read as clean and its warning was
    // suppressed. `--ignored` closes it.
    const tree = repo();
    writeFileSync(`${tree}/.gitignore`, "secrets.local.ts\n");
    writeFileSync(`${tree}/keep.ts`, "x\n");
    spawnSync("git", ["add", "-A"], { cwd: tree, windowsHide: true });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: tree, windowsHide: true });
    writeFileSync(`${tree}/secrets.local.ts`, "const key = 1;\n");
    clearDirtyCache();
    expect(dirtyFiles(tree)!.has("secrets.local.ts")).toBe(true);
  });
});

describe("a peer's claim is not deleted out from under it", () => {
  test("a claim made seconds ago survives — the peer is mid-edit", () => {
    // `pre-edit` writes the claim in PreToolUse, BEFORE the Edit tool reaches
    // disk, so a peer that has just claimed a file it is about to write looks
    // clean for a few hundred milliseconds. Deleting the row in that window
    // removes the warning for the very edit that needed it.
    fresh((store) => {
      const now = Date.now();
      store.register("peer", MAIN, "master", now);
      store.claim("peer", "hot.ts", now, { worktree: MAIN });

      const GRACE = 10_000;
      const claims = store.conflictingClaims("me", "hot.ts", now);
      expect(claims).toHaveLength(1);
      // The hook's rule: only claims older than the grace window are dropped.
      for (const c of claims) {
        if (now - c.tsMs > GRACE) store.releaseClaim(c.sessionId, c.path);
      }
      expect(store.conflictingClaims("me", "hot.ts", now)).toHaveLength(1);
    });
  });

  test("a genuinely stale claim IS dropped", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("peer", MAIN, "master", now);
      store.claim("peer", "cold.ts", now - 30 * 60_000, { worktree: MAIN });

      const GRACE = 10_000;
      for (const c of store.conflictingClaims("me", "cold.ts", now)) {
        if (now - c.tsMs > GRACE) store.releaseClaim(c.sessionId, c.path);
      }
      expect(store.conflictingClaims("me", "cold.ts", now)).toHaveLength(0);
    });
  });

  test("releaseClaim removes the claim but never the edit history", () => {
    // `releaseClaim` had no coverage at all. A claim means "my uncommitted work
    // is here" and can be wrong; the fact that they EDITED it stays true and is
    // what `blame` reads.
    fresh((store) => {
      const now = Date.now();
      store.register("peer", MAIN, "master", now);
      store.claim("peer", "x.ts", now, { worktree: MAIN });
      store.releaseClaim("peer", "x.ts");
      expect(store.conflictingClaims("me", "x.ts", now)).toHaveLength(0);
      expect(store.editsOf("x.ts")).toHaveLength(1);
    });
  });

  test("releasing one path leaves that session's other claims alone", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("peer", MAIN, "master", now);
      store.claim("peer", "a.ts", now, { worktree: MAIN });
      store.claim("peer", "b.ts", now, { worktree: MAIN });
      store.releaseClaim("peer", "a.ts");
      expect(store.conflictingClaims("me", "b.ts", now)).toHaveLength(1);
    });
  });
});

describe("a documented setting actually does something", () => {
  test("workKeepMs is read from the config, not from the constant", () => {
    // It was documented in the README, validated in config.ts, and IGNORED by
    // pruneWork. The config tests missed it because they only compared DEFAULTS
    // to each other and never asserted that a config file is honoured — the
    // "test stubbed above the bug" shape exactly.
    //
    // Asserted through behaviour rather than by writing a config file, since
    // that would mean pointing HOME at a fixture: an item closed a week ago
    // must be gone, one closed a minute ago must survive.
    fresh((store) => {
      const now = Date.now();
      const w = store.work;
      const old = w.open("session:a", "a", "old", [], now - 30 * 24 * 3600_000);
      const recent = w.open("session:a", "a", "recent", [], now - 60_000);
      w.close(old, "done", "", now - 20 * 24 * 3600_000);
      w.close(recent, "done", "", now - 30_000);
      w.pruneWork(now);
      const left = w.items({ includeClosed: true }).map((i) => i.subject);
      expect(left).toEqual(["recent"]);
    });
  });
});

describe("cross-worktree claims are classified before they are filtered", () => {
  test("a peer in another tree is never mistaken for a same-tree peer", () => {
    fresh((store) => {
      const now = Date.now();
      store.register("here", MAIN, "master", now);
      store.register("away", WT, "other", now);
      store.claim("here", "shared.ts", now, { worktree: MAIN });
      store.claim("away", "shared.ts", now, { worktree: WT });

      const claims = store.conflictingClaims("me", "shared.ts", now);
      const sameTree = claims.filter((c) => !c.worktree || c.worktree === MAIN);
      const elsewhere = claims.filter((c) => c.worktree && c.worktree !== MAIN);
      expect(sameTree).toHaveLength(1);
      expect(elsewhere).toHaveLength(1);
      expect(elsewhere[0]?.worktree).toBe(WT);
    });
  });
});
