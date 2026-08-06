/**
 * What `msg` PROMISES about delivery, which has to match what happens.
 *
 * WHY THIS FILE EXISTS. `msg` resolves its target through `liveSessions`, whose
 * horizon is `staleMs` (90 min). That is right for a roster and too generous for
 * a send gate: a recipient silent for an hour and a half still resolved, and the
 * command still printed "Delivered on their next turn."
 *
 * MEASURED, 2026-08-05, over this repo's own 56 directed messages: 40 went to a
 * recipient with no activity for over 90 minutes, 16 to one active within 30,
 * and the 30–90 minute bucket was EMPTY. The confirmation line was wrong for the
 * larger half, which is what these pin.
 *
 * AGAINST THE FUNCTION, NOT THE CLI. The first draft drove `runCli` against a
 * temp db via `PRESENCE_TEST_DB`. It passed alone and took SEVEN tests down in
 * the full sweep: `core/repo.ts` freezes that variable into a module constant at
 * import, and `lineage.test.ts` deletes it in `afterEach`, so one file's harness
 * was redirecting another's database. `deliveryNote` is a pure function of two
 * fields on the recipient row — testing it needs no database at all.
 */

import { describe, expect, test } from "bun:test";

import { deliveryNote } from "../cli/messaging.ts";
import { TRUST_NOTE } from "../core/shared.ts";
import type { Session } from "../core/store.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function recipient(silentMinutes: number, status = ""): Session {
  return {
    sessionId: "s",
    handle: "h",
    name: "traffic-1",
    alias: "alder",
    role: "",
    status,
    blocked: "",
    worktree: "/tree",
    branch: "master",
    behindBase: -1,
    baseBranch: "",
    lineageFrom: "",
    intent: "",
    title: "",
    summary: "",
    summaryMs: 0,
    lastSeenMs: NOW - silentMinutes * MINUTE,
    lastTurnMs: 0,
    startedMs: NOW - silentMinutes * MINUTE,
  };
}

describe("msg says what will actually happen to the message", () => {
  test("a peer active moments ago is reported as reachable", () => {
    const note = deliveryNote(recipient(1), NOW);
    expect(note).toBe("Delivered on their next turn.");
  });

  test("a peer silent 75 minutes is QUEUED, not delivered", () => {
    // The regression case. 75 min is inside the 90 min live horizon, so the
    // target still resolves and the send still succeeds — only the promise
    // changes. If this reverts to "Delivered on their next turn", the tool is
    // again implying an audience that is not there.
    const note = deliveryNote(recipient(75), NOW);
    expect(note).toContain("Queued");
    expect(note).not.toContain("Delivered on their next turn");
  });

  test("the queued line names the peer and how long it has been quiet", () => {
    // A bare "queued" would not tell the sender whether to wait or reassign.
    expect(deliveryNote(recipient(75), NOW)).toMatch(
      /Queued — alder was last active 1h ago/,
    );
  });

  test("the boundary is crossed at 30 minutes, not at the roster horizon", () => {
    expect(deliveryNote(recipient(29), NOW)).toContain("Delivered on their");
    expect(deliveryNote(recipient(31), NOW)).toContain("Queued");
  });

  test("a busy peer is promised the end of its turn, however long it has run", () => {
    // `busy` outranks silence: the session is mid-turn with tools running, so
    // its last heartbeat says nothing about whether it will read this.
    expect(deliveryNote(recipient(200, "busy"), NOW)).toBe(
      "Delivered after their current turn ends.",
    );
  });
});

/**
 * WHAT THE TRUST NOTE PROMISES ABOUT ARRIVAL.
 *
 * `TRUST_NOTE` is appended by all three injecting hooks, so it is the only text
 * every reader of peer messages is guaranteed to see. It answers authorship in
 * its first sentences; the last answers ARRIVAL, which is a different question
 * and was absent until 2026-08-06.
 *
 * Pinned because nothing else asserts this string — the same gap `audiences.md`
 * had, where a hand-maintained claim drifted from its source until a reader
 * quoted "33 verbs" at a table holding 51. Here the claim is "three doors", and
 * the doors are files on disk that can be added to.
 */
describe("the trust note describes how text actually arrives", () => {
  const HOOK_DOORS = ["prompt-submit.ts", "tool-batch.ts", "turn-end.ts"];

  test("every hook that injects peer text appends the note", async () => {
    // If a fourth door opens without this note, its readers get peer text with
    // no framing at all — the failure the note exists to prevent.
    for (const door of HOOK_DOORS) {
      const source = await Bun.file(`${import.meta.dir}/../hooks/${door}`).text();
      expect(source).toContain("TRUST_NOTE");
    }
  });

  test("no other hook injects peer messages without saying where it came from", async () => {
    // Guards the count, not just the members: a new injecting hook must either
    // append the note or be a deliberate exception recorded here.
    const glob = new Bun.Glob("*.ts");
    const injecting: string[] = [];
    for await (const file of glob.scan(`${import.meta.dir}/../hooks`)) {
      const source = await Bun.file(`${import.meta.dir}/../hooks/${file}`).text();
      if (source.includes("formatMessages(")) injecting.push(file);
    }
    expect(injecting.sort()).toEqual([...HOOK_DOORS].sort());
  });

  test("the note names all three arrival points and the causal one", () => {
    // The `turn-end` case is causal rather than incidental: the session had
    // stopped, and the delivery is what invoked it again. An agent that reads
    // only "you have mail" concludes it was waiting — nothing here can wait.
    expect(TRUST_NOTE).toContain("between its tool batches");
    expect(TRUST_NOTE).toContain("at a prompt");
    expect(TRUST_NOTE).toContain("after it stops");
    expect(TRUST_NOTE).toMatch(/arrival is what started the session running again/);
  });

  test("it still answers authorship, which arrival does not replace", () => {
    // Both halves earn their space; a rewrite that drops either is a regression.
    expect(TRUST_NOTE).toContain("written by other Claude Code sessions");
    expect(TRUST_NOTE).toContain("rather than from this session's user");
  });
});
