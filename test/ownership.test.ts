/**
 * NAME OWNERSHIP: a name belongs to a conversation for as long as that
 * conversation exists on disk (user ruling, 2026-08-05). Every case here is the
 * failure that produced the rule — headline: session c5ce05bc held `hopper`,
 * was reaped after 90 idle minutes, and came back 68 h later as `akari`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { displayName, withStore } from "../core/store.ts";
import { liveConversations, transcriptDir } from "../core/store/ownership.ts";

let n = 0;
const paths: string[] = [];
const dirs: string[] = [];

/** A project root whose transcript directory we control. */
function fakeProject(conversationIds: readonly string[]): string {
  const root = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/presence-proj-`);
  dirs.push(root);
  // `projectTranscriptDir` slugs the root the way Claude Code does, and reads
  // CLAUDE_CONFIG_DIR — so the test builds the directory it will actually look
  // in rather than asserting against a hand-built path that could drift.
  const base = process.env["CLAUDE_CONFIG_DIR"] ?? `${tmpdir().replace(/\\/g, "/")}/presence-home`;
  process.env["CLAUDE_CONFIG_DIR"] = base;
  dirs.push(base);
  const dir = `${base}/projects/${root.replace(/[^a-zA-Z0-9]+/g, "-")}`;
  mkdirSync(dir, { recursive: true });
  for (const id of conversationIds) writeFileSync(`${dir}/${id}.jsonl`, "{}\n");
  return root;
}

/** Deletes one conversation's transcript — the only thing that frees a name. */
function deleteConversation(root: string, id: string): void {
  const base = process.env["CLAUDE_CONFIG_DIR"] ?? "";
  rmSync(`${base}/projects/${root.replace(/[^a-zA-Z0-9]+/g, "-")}/${id}.jsonl`, { force: true });
}

/** One db reused across calls, so a "returning" session hits the same store. */
function reopen<T>(
  path: string,
  root: string,
  fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T,
): T {
  return withStore(path, fn, root);
}

function dbPath(): string {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-own-${process.pid}-${n++}.db`;
  paths.push(path);
  return path;
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(p + suffix, { force: true });
      } catch {
        /* already gone */
      }
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
});

describe("name ownership", () => {
  // The bug this exists for: the old code kept a name only while it was still
  // in `taken`, built from 60 h activity windows -- so identity expired on a
  // clock measuring how recently the agent had TYPED.
  test("keeps its name across a reap and a long absence", () => {
    const conversation = "c5ce05bc-4024-45ef-8cb0-67c0c08d323d";
    const root = fakeProject([conversation]);
    const path = dbPath();
    const now = Date.now();

    const first = reopen(path, root, (store) =>
      store.registerAndRestore(conversation, "/tree", "master", now),
    );

    // Reaped: idle well past staleMs, exactly as a session left at a prompt is.
    const monthLater = now + 30 * 24 * 60 * 60 * 1000;
    reopen(path, root, (store) => store.pruneStale(monthLater));
    const survived = reopen(path, root, (store) => store.sessions.findBySession(conversation));
    expect(survived).toBeNull();

    // ...and returns a month later, which under the old rule was 12× the hold.
    const second = reopen(path, root, (store) =>
      store.registerAndRestore(conversation, "/tree", "master", monthLater),
    );
    expect(second).toBe(first);
  });

  // Whether a name survived used to depend on having EDITED recently, since
  // `edits` outlived the other sources. A reader must keep its name too.
  test("keeps its name having never edited a file", () => {
    const conversation = "quiet-0000-0000-0000-000000000000";
    const root = fakeProject([conversation]);
    const path = dbPath();
    const now = Date.now();

    const first = reopen(path, root, (store) =>
      store.registerAndRestore(conversation, "/tree", "master", now),
    );
    const later = now + 30 * 24 * 60 * 60 * 1000;
    reopen(path, root, (store) => store.pruneStale(later));
    const second = reopen(path, root, (store) =>
      store.registerAndRestore(conversation, "/tree", "master", later),
    );
    expect(second).toBe(first);
  });

  // A LIVE ROW THAT DISAGREES WITH THE LEDGER IS REPAIRED, not trusted.
  // register() returns early when a session row exists, so a row written under
  // the old rule re-confirmed its wrong name on every heartbeat and the ledger
  // was never consulted. MEASURED 2026-08-05: c5ce05bc read `hopper` in the
  // ledger and `akari` on the roster for hours, with the fix already deployed.
  test("a stale roster row is corrected from the ledger", () => {
    const conversation = "99999999-0000-0000-0000-000000000000";
    const root = fakeProject([conversation]);
    const path = dbPath();
    const now = Date.now();

    const first = reopen(path, root, (store) =>
      store.registerAndRestore(conversation, "/tree", "master", now),
    );
    // The row the old code left behind: right uuid, wrong name. `setAlias`
    // also updates the ledger, so the ledger is put back to what it owned --
    // which is precisely the disagreement the repair has to resolve.
    reopen(path, root, (store) => {
      store.sessions.setAlias(conversation, "wrongname", now);
      store.owners.claim(conversation, first, now);
    });
    reopen(path, root, (store) =>
      store.registerAndRestore(conversation, "/tree", "master", now + 1000),
    );
    // ASSERTED THROUGH displayName, not the return value: `registerAndRestore`
    // puts the alias back afterwards, so the handle it returns looks correct
    // either way. What the operator and every peer actually read is the roster.
    const shown = reopen(path, root, (store) => {
      const self = store.sessions.findBySession(conversation);
      return self ? displayName(self) : "";
    });
    expect(shown).toBe(first);
  });

  // The reservation half: a new conversation must never be handed a name a
  // surviving conversation owns, which is what makes collisions impossible.
  test("a stranger cannot take a surviving conversation's name", () => {
    const mine = "aaaaaaaa-0000-0000-0000-000000000000";
    const stranger = "bbbbbbbb-0000-0000-0000-000000000000";
    const root = fakeProject([mine, stranger]);
    const path = dbPath();
    const now = Date.now();

    const held = reopen(path, root, (store) =>
      store.registerAndRestore(mine, "/tree", "master", now),
    );
    const later = now + 30 * 24 * 60 * 60 * 1000;
    reopen(path, root, (store) => store.pruneStale(later));
    const other = reopen(path, root, (store) =>
      store.registerAndRestore(stranger, "/tree", "master", later),
    );
    expect(other).not.toBe(held);
  });

  // The only release, and it asserts the ROW IS GONE, not just that the name is
  // reusable: `reserved()` filters at read time, so reuse alone stays green
  // against a store that never prunes. Caught by mutation, 2026-08-05.
  test("deleting the conversation frees its name and drops the ledger row", () => {
    const gone = "cccccccc-0000-0000-0000-000000000000";
    const newcomer = "dddddddd-0000-0000-0000-000000000000";
    const root = fakeProject([gone, newcomer]);
    const path = dbPath();
    const now = Date.now();

    const freed = reopen(path, root, (store) =>
      store.registerAndRestore(gone, "/tree", "master", now),
    );
    expect(reopen(path, root, (store) => store.owners.nameFor(gone))).toBe(freed);

    const later = now + 30 * 24 * 60 * 60 * 1000;
    deleteConversation(root, gone);
    reopen(path, root, (store) => store.pruneStale(later));
    // The row itself is gone, so the ledger cannot grow without bound.
    expect(reopen(path, root, (store) => store.owners.nameFor(gone))).toBe("");

    const taken = reopen(path, root, (store) =>
      store.registerAndRestore(newcomer, "/tree", "master", later),
    );
    expect(taken).toBe(freed);
  });

  // A live peer still wins: two agents on one name makes `msg` ambiguous.
  // Reachable only when ledger and roster disagree -- a restored backup.
  test("a live peer on the name still wins", () => {
    const first = "eeeeeeee-0000-0000-0000-000000000000";
    const second = "ffffffff-0000-0000-0000-000000000000";
    const root = fakeProject([first, second]);
    const path = dbPath();
    const now = Date.now();

    const name = reopen(path, root, (store) =>
      store.registerAndRestore(first, "/tree", "master", now),
    );
    // `second` claims the same name in the ledger, as a restored db could.
    reopen(path, root, (store) => store.owners.claim(second, name, now));
    const given = reopen(path, root, (store) =>
      store.registerAndRestore(second, "/tree", "master", now),
    );
    expect(given).not.toBe(name);
  });

  // Fail safe in the direction that KEEPS names: an unreadable dir means
  // "could not tell", and the other reading renames every agent at once.
  test("an unreadable transcript directory keeps every name reserved", () => {
    expect(liveConversations("/nonexistent/definitely/not/here").size).toBe(0);

    const conversation = "11111111-0000-0000-0000-000000000000";
    const stranger = "22222222-0000-0000-0000-000000000000";
    const path = dbPath();
    const now = Date.now();
    // No project root at all: the check is disabled, and nothing is released.
    const held = withStore(path, (store) =>
      store.registerAndRestore(conversation, "/tree", "master", now),
    );
    const later = now + 30 * 24 * 60 * 60 * 1000;
    withStore(path, (store) => store.pruneStale(later));
    const other = withStore(path, (store) =>
      store.registerAndRestore(stranger, "/tree", "master", later),
    );
    expect(other).not.toBe(held);
  });

  test("transcriptDir strips the filename on both separators", () => {
    expect(transcriptDir("/home/u/.claude/projects/P/abc.jsonl")).toBe(
      "/home/u/.claude/projects/P",
    );
    expect(transcriptDir("C:\\Users\\u\\.claude\\projects\\P\\abc.jsonl")).toBe(
      "C:\\Users\\u\\.claude\\projects\\P",
    );
    expect(transcriptDir("")).toBe("");
  });
});
