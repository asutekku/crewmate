/**
 * A diary note is an event on the timeline, not only a scoped finding.
 *
 * WRITTEN AGAINST THE SPEC. `crew log` reads `messages`; the diary is its own
 * table, surfaced by scope-matching when an agent edits a folder. So a note
 * filed by one agent and acted on by another leaves the log holding the REPLY
 * and not the thing replied to.
 *
 * MEASURED 2026-08-06: the operator read `log`, saw akari thank adela for a
 * finding, and could not find anything from adela anywhere in it. The log looks
 * complete, which is worse than an obvious omission -- nothing marks the place
 * where a note was filed.
 *
 * A POINTER, NOT THE BODY. The note keeps living in the diary, where scope and
 * search work. The log line records that it happened, in the channel where
 * causality is read. It is `filed`, never `sent`: a note is durable and scoped
 * on purpose, and must not read as having been delivered to everyone.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, describe, test } from "bun:test";

import { displayName, withStore } from "../core/store.ts";
import { formatMessages } from "../core/shared.ts";

let n = 0;
const paths: string[] = [];

const AGENT = "aaaaaaaa-0000-0000-0000-000000000000";
const PEER = "bbbbbbbb-0000-0000-0000-000000000000";

function fresh<T>(fn: (s: Parameters<Parameters<typeof withStore>[1]>[0]) => T): T {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-logdiary-${process.pid}-${n++}.db`;
  paths.push(path);
  return withStore(path, fn);
}

/**
 * Writes a diary entry and posts its pointer, as `cli/diary.ts` does.
 *
 * The two writes live at the CLI seam because `DiaryStore` cannot reach
 * `messages`. Mirrored here rather than driven through `runCli`, which would
 * need the real store; `test/verbs.test.ts` is what keeps the seam wired.
 */
function file(
  store: Parameters<Parameters<typeof withStore>[1]>[0],
  sessionId: string,
  title: string,
  topic: string,
  scope: string,
  nowMs: number,
): number {
  const agent = store.findBySession(sessionId);
  const name = agent ? displayName(agent) : "someone";
  const id = store.diary.write(
    sessionId,
    name,
    { title, body: "", topic, tags: [], kind: "finding", scope },
    nowMs,
  );
  store.post(name, "diary", `#${id} ${title}`, nowMs);
  return id;
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

describe("a filed note reaches the log", () => {
  test("filing a note puts one line on the timeline", () => {
    fresh((store) => {
      store.registerAndRestore(AGENT, "/tree", "main", 1000);
      file(store, AGENT, "the suite flakes when two agents run it", "testing", "test", 1000);
      const log = store.recent(50);
      const diary = log.filter((m) => m.kind === "diary");
      expect(diary).toHaveLength(1);
      expect(diary[0]?.body).toContain("the suite flakes");
    });
  });

  test("the line names the note's id, so the body is reachable", () => {
    // A pointer is only useful if it points. Without the id the reader has the
    // fact that something was filed and no way to read it.
    fresh((store) => {
      store.registerAndRestore(AGENT, "/tree", "main", 1000);
      const id = file(store, AGENT, "forget is not gated across agents", "memory", "core", 1000);
      const line = store.recent(50).find((m) => m.kind === "diary");
      expect(line?.body).toContain(String(id));
    });
  });

  test("it is attributed to the agent that filed it", () => {
    fresh((store) => {
      store.registerAndRestore(AGENT, "/tree", "main", 1000);
      store.setAlias(AGENT, "adela", 1000);
      file(store, AGENT, "a finding", "docs", "docs", 2000);
      const line = store.recent(50).find((m) => m.kind === "diary");
      expect(line?.from.toLowerCase()).toBe("adela");
    });
  });

  test("it reads as FILED, never as sent to everyone", () => {
    // The distinction is load-bearing. A note is durable and scoped; rendering
    // it like a broadcast would claim a delivery that never happened.
    fresh((store) => {
      store.registerAndRestore(AGENT, "/tree", "main", 1000);
      store.setAlias(AGENT, "adela", 1000);
      file(store, AGENT, "ownership.test expects the old allocation order", "testing", "test", 2000);
      const rendered = formatMessages(store.recent(50), 3000).join("\n");
      expect(rendered).toMatch(/filed/i);
      expect(rendered).not.toMatch(/to everyone: ownership\.test/);
    });
  });

  test("every agent sees it — a note is not addressed to one peer", () => {
    // `recent(limit, forSession)` filters directed messages by recipient. A
    // note has no recipient, so it must survive that filter for any reader.
    fresh((store) => {
      store.registerAndRestore(AGENT, "/tree", "main", 1000);
      store.registerAndRestore(PEER, "/tree", "main", 1000);
      file(store, AGENT, "a finding for whoever comes next", "docs", "docs", 2000);
      expect(store.recent(50, PEER).filter((m) => m.kind === "diary")).toHaveLength(1);
    });
  });

  test("`crew note` itself posts the pointer — the seam is wired", () => {
    /**
     * THE TESTS ABOVE PIN THE CONTRACT, NOT THE WIRING. `file()` mirrors what
     * `cli/diary.ts` does, so every one of them passes with the real `post`
     * call deleted -- verified by mutation 2026-08-06. This reads the source
     * instead, which is the only thing that fails when the seam is unhooked.
     *
     * Source-reading is a poor test and deliberately narrow: it asserts the
     * call exists next to the write, nothing about behaviour. The alternative
     * is driving `runCli` against the operator's real store, which no test here
     * may touch.
     */
    const source = Bun.file(
      new URL("../cli/diary.ts", import.meta.url),
    ).text();
    return source.then((text) => {
      const noteCommand = text.slice(text.indexOf("store.diary.write("));
      expect(noteCommand).toMatch(/store\.post\([^)]*"diary"/);
    });
  });

  test("the timeline keeps the order the events happened in", () => {
    // The whole point: the reply must follow the thing it replies to.
    fresh((store) => {
      store.registerAndRestore(AGENT, "/tree", "main", 1000);
      store.setAlias(AGENT, "adela", 1000);
      file(store, AGENT, "the test asserts the old order", "testing", "test", 2000);
      store.post("akari", "say", "thanks — fixed in 4c6432a", 3000);

      const kinds = store.recent(50).map((m) => m.kind);
      expect(kinds.indexOf("diary")).toBeLessThan(kinds.indexOf("say"));
    });
  });
});
