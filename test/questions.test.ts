/**
 * Questions: a message that is owed an answer, and that stops being owed one.
 *
 * THE ROW NOBODY CLOSES is the failure this file is really guarding against.
 * `asked_turn_ms` shipped with a column, a setter and no caller for months, so
 * every work item dangled on the board forever. A question aimed at a session
 * that then dies is the same shape of bug, so expiry is tested harder than the
 * happy path -- including the two orderings that decide whether the asker is
 * left waiting on someone who will never reply.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";
import { ANSWER_MAX, clampText, QUESTION_MAX, questionState } from "../core/questions.ts";

let n = 0;
const paths: string[] = [];

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-q-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}

afterEach(() => {
  for (const p of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${p}${suffix}`);
      } catch {
        // Already gone, or never created.
      }
    }
  }
});

const ASKER = "aaaa-1111";
const TARGET = "bbbb-2222";
const STALE = 90 * 60 * 1000;

/** Registers both sides so `expireStale`'s join has real rows to read. */
function bothLive(s: Parameters<Parameters<typeof withStore>[1]>[0], nowMs: number): void {
  s.handleForOrRegister(ASKER, "/repo", "", nowMs);
  s.handleForOrRegister(TARGET, "/repo", "", nowMs);
}

describe("asking and answering", () => {
  test("a question reaches its target and nobody else", () => {
    fresh((s) => {
      bothLive(s, 1000);
      s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done with roadSection?", 1000);
      expect(s.questions.openFor(TARGET)).toHaveLength(1);
      expect(s.questions.openFor(ASKER)).toHaveLength(0);
    });
  });

  test("the asker sees what it is waiting for", () => {
    fresh((s) => {
      bothLive(s, 1000);
      s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      expect(s.questions.pendingFrom(ASKER)).toHaveLength(1);
    });
  });

  test("answering closes it and the answer reaches the asker once", () => {
    fresh((s) => {
      bothLive(s, 1000);
      const id = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      expect(s.questions.answer(id, "yes, landed in 4eb260b", 2000)).toBe(true);

      const first = s.questions.drainResolved(ASKER, 3000);
      expect(first).toHaveLength(1);
      expect(first[0]?.answer).toBe("yes, landed in 4eb260b");
      // DRAINED, not re-read. A line repeated every turn is a line that gets
      // skipped, and then the one that mattered is skipped too.
      expect(s.questions.drainResolved(ASKER, 4000)).toHaveLength(0);
    });
  });

  test("a second answer is refused", () => {
    fresh((s) => {
      bothLive(s, 1000);
      const id = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      expect(s.questions.answer(id, "yes", 2000)).toBe(true);
      expect(s.questions.answer(id, "actually no", 3000)).toBe(false);
      expect(s.questions.get(id)?.answer).toBe("yes");
    });
  });

  test("answering an unknown question fails rather than inventing one", () => {
    fresh((s) => expect(s.questions.answer(9999, "hi", 1000)).toBe(false));
  });
});

describe("expiry — the row nobody would otherwise close", () => {
  test("a question against a session that went away expires", () => {
    fresh((s) => {
      bothLive(s, 1000);
      s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      // The target has not been seen for longer than the staleness window.
      const expired = s.questions.expireStale(1000 + STALE + 1, STALE);
      expect(expired).toHaveLength(1);
      expect(questionState(expired[0]!)).toBe("expired");
    });
  });

  test("a question against a session that never existed expires", () => {
    // The LEFT JOIN's null branch: a target whose row was reaped entirely.
    fresh((s) => {
      s.handleForOrRegister(ASKER, "/repo", "", 1000);
      s.questions.ask(ASKER, "hopper", "ghost-9999", "ghost", "still there?", 1000);
      expect(s.questions.expireStale(2000, STALE)).toHaveLength(1);
    });
  });

  test("a live target's question is NOT expired, however old", () => {
    // Age alone gets this backwards: a question asked two hours ago of an agent
    // still working is live; one asked a minute ago of a dead session is not.
    fresh((s) => {
      bothLive(s, 1000);
      s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      const later = 1000 + 5 * STALE;
      s.touch(TARGET, later);
      expect(s.questions.expireStale(later, STALE)).toHaveLength(0);
      expect(s.questions.openFor(TARGET)).toHaveLength(1);
    });
  });

  test("THE ASKER IS TOLD, rather than left waiting forever", () => {
    fresh((s) => {
      bothLive(s, 1000);
      s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      s.questions.expireStale(1000 + STALE + 1, STALE);

      const drained = s.questions.drainResolved(ASKER, 9000);
      expect(drained).toHaveLength(1);
      expect(drained[0]?.expiredMs).toBeGreaterThan(0);
      expect(drained[0]?.answer).toBe("");
    });
  });

  test("an expired question can still be answered — late beats never", () => {
    // The timer exists to prevent SILENCE, not to prevent honesty. Refusing a
    // late reply throws away the very thing the asker wanted.
    fresh((s) => {
      bothLive(s, 1000);
      const id = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      s.questions.expireStale(1000 + STALE + 1, STALE);
      expect(s.questions.answer(id, "sorry — yes", 99_000)).toBe(true);

      const q = s.questions.get(id);
      expect(questionState(q!)).toBe("answered");
      expect(q?.expiredMs).toBe(0);
    });
  });

  test("an answered question is never expired afterwards", () => {
    fresh((s) => {
      bothLive(s, 1000);
      const id = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      s.questions.answer(id, "yes", 1100);
      expect(s.questions.expireStale(1000 + STALE + 1, STALE)).toHaveLength(0);
      expect(questionState(s.questions.get(id)!)).toBe("answered");
    });
  });

  test("expiry is idempotent — a second sweep re-reports nothing", () => {
    fresh((s) => {
      bothLive(s, 1000);
      s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      expect(s.questions.expireStale(1000 + STALE + 1, STALE)).toHaveLength(1);
      expect(s.questions.expireStale(1000 + STALE + 2, STALE)).toHaveLength(0);
    });
  });
});

describe("text handling", () => {
  test("a question is capped, not stored whole", () => {
    fresh((s) => {
      bothLive(s, 1000);
      const id = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "x".repeat(5000), 1000);
      expect((s.questions.get(id)?.text ?? "").length).toBeLessThanOrEqual(QUESTION_MAX);
    });
  });

  test("an answer is capped too", () => {
    fresh((s) => {
      bothLive(s, 1000);
      const id = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      s.questions.answer(id, "y".repeat(9000), 2000);
      expect((s.questions.get(id)?.answer ?? "").length).toBeLessThanOrEqual(ANSWER_MAX);
    });
  });

  test("clampText collapses whitespace so a pasted block stays one line", () => {
    expect(clampText("  a\n\n  b   c  ", 100)).toBe("a b c");
  });

  test("a NUL survives storage — it is text, not an FTS query", () => {
    // The diary's FTS path throws on a NUL (SQLite binds a JS string as a C
    // string). Questions never reach MATCH, so this must simply round-trip.
    fresh((s) => {
      bothLive(s, 1000);
      const id = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", `a${String.fromCharCode(0)}b`, 1000);
      expect(s.questions.get(id)).not.toBeNull();
    });
  });
});

describe("pruning", () => {
  test("delivered and resolved questions age out; open ones never do", () => {
    fresh((s) => {
      bothLive(s, 1000);
      const answered = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "old one", 1000);
      s.questions.answer(answered, "yes", 1100);
      s.questions.drainResolved(ASKER, 1200);
      s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "still open", 1000);

      const keep = 24 * 60 * 60 * 1000;
      expect(s.questions.prune(1100 + keep + 1, keep)).toBe(1);
      expect(s.questions.pendingFrom(ASKER)).toHaveLength(1);
    });
  });

  test("an undelivered answer is never pruned — the asker has not seen it", () => {
    fresh((s) => {
      bothLive(s, 1000);
      const id = s.questions.ask(ASKER, "hopper", TARGET, "ambrose", "done?", 1000);
      s.questions.answer(id, "yes", 1100);
      const keep = 24 * 60 * 60 * 1000;
      expect(s.questions.prune(1100 + keep + 1, keep)).toBe(0);
    });
  });
});
