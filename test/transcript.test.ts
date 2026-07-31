/**
 * Reading Claude Code's own records out of a transcript.
 *
 * The risk here is silence: every function returns "" on failure, so a broken
 * reader is indistinguishable from a session that has no title. These tests
 * assert the values actually come back, against files shaped like real ones.
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { readTranscript, recentAssistantText } from "../core/transcript.ts";
import { parseSummary, SUMMARY_MAX } from "../core/summary.ts";
import { isInternalSession, readPayload } from "../core/shared.ts";

let n = 0;
const paths: string[] = [];

function writeTranscript(lines: readonly string[]): string {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-tx-${process.pid}-${n++}.jsonl`;
  paths.push(path);
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

const titleLine = (t: string): string => JSON.stringify({ type: "ai-title", aiTitle: t });
const promptLine = (p: string): string => JSON.stringify({ type: "last-prompt", lastPrompt: p });
const textLine = (t: string): string => JSON.stringify({ type: "text", text: t });

afterEach(() => {
  for (const p of paths.splice(0)) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
  }
});

describe("readTranscript", () => {
  test("reads the conversation title Claude Code wrote", () => {
    const path = writeTranscript([titleLine("Explore cheap agent communication solutions")]);
    expect(readTranscript(path).title).toBe("Explore cheap agent communication solutions");
  });

  test("takes the LAST title, because a renamed conversation rewrites it", () => {
    const path = writeTranscript([titleLine("Initial guess"), titleLine("What it became")]);
    expect(readTranscript(path).title).toBe("What it became");
  });

  test("returns empty for a transcript with no title rather than throwing", () => {
    // Measured: 3 of 25 real transcripts (all predating the feature) have no
    // ai-title record anywhere, so callers must treat "" as ordinary.
    const path = writeTranscript([promptLine("do the thing")]);
    expect(readTranscript(path).title).toBe("");
  });

  test("returns empty for a file that does not exist", () => {
    expect(readTranscript(`${tmpdir()}/presence-definitely-absent.jsonl`).title).toBe("");
  });

  test("unescapes quotes and newlines in a title", () => {
    const path = writeTranscript([titleLine('Fix the "water" bug\nand its test')]);
    expect(readTranscript(path).title).toBe('Fix the "water" bug\nand its test');
  });

  test("finds the title when it sits behind megabytes of other records", () => {
    // The read is a fixed tail, so a title buried under a large turn is the
    // case that decides whether the window is big enough.
    const filler = Array.from({ length: 4000 }, (_, i) =>
      JSON.stringify({ type: "message", body: `padding ${i} `.repeat(12) }),
    );
    const path = writeTranscript([titleLine("Buried early"), ...filler, titleLine("Current name")]);
    expect(readTranscript(path).title).toBe("Current name");
  });

  test("reads the latest prompt alongside the title", () => {
    const path = writeTranscript([titleLine("A title"), promptLine("optimize the water sim")]);
    expect(readTranscript(path).lastPrompt).toBe("optimize the water sim");
  });
});

describe("recentAssistantText", () => {
  test("collects assistant prose in the order it happened", () => {
    const a = `First substantive paragraph about the water simulation work. ${"x".repeat(60)}`;
    const b = `Second paragraph describing the benchmark results found. ${"y".repeat(60)}`;
    const path = writeTranscript([textLine(a), textLine(b)]);
    const out = recentAssistantText(path);
    expect(out.indexOf(a)).toBeLessThan(out.indexOf(b));
  });

  test("drops short acknowledgements that crowd out real content", () => {
    const long = `A real explanation of what was changed and why it matters. ${"z".repeat(60)}`;
    const path = writeTranscript([textLine("Done."), textLine("Let me check."), textLine(long)]);
    const out = recentAssistantText(path);
    expect(out).toContain(long);
    expect(out).not.toContain("Let me check.");
  });

  test("never includes tool inputs, so file contents cannot leak into a prompt", () => {
    // Only `"type":"text"` blocks match. Tool results carry file contents and
    // command output, and this text is later sent to a summarising model.
    const secret = `AKIA${"S".repeat(40)}`;
    const path = writeTranscript([
      JSON.stringify({ type: "tool_result", content: `credentials: ${secret}` }),
      textLine(`An ordinary explanatory paragraph about the change. ${"q".repeat(60)}`),
    ]);
    expect(recentAssistantText(path)).not.toContain(secret);
  });

  test("caps its output so a huge turn cannot produce an unbounded prompt", () => {
    const big = Array.from({ length: 200 }, (_, i) => textLine(`Paragraph ${i}. ${"w".repeat(200)}`));
    const path = writeTranscript(big);
    expect(recentAssistantText(path, 1000).length).toBeLessThanOrEqual(1000);
  });
});

describe("internal sessions", () => {
  // The summariser runs `claude -p`, which is a REAL Claude session and fires
  // SessionStart / UserPromptSubmit like any other. Five summary refreshes put
  // FIVE agents on the roster whose stated task was the summariser's own prompt
  // — "You label background jobs." They held handles and could have raised
  // overlap warnings against genuine work.
  //
  // The guard lives in `readPayload`, so every hook is covered at one seam and a
  // hook added later cannot forget it.
  const KEY = "PRESENCE_INTERNAL";

  afterEach(() => {
    delete process.env[KEY];
  });

  test("a hook does nothing when it is running inside our own claude call", async () => {
    process.env[KEY] = "1";
    expect(isInternalSession()).toBe(true);
    // Null is precisely what every hook treats as "no payload, do nothing".
    expect(await readPayload()).toBeNull();
  });

  test("an ordinary session is not treated as internal", () => {
    delete process.env[KEY];
    expect(isInternalSession()).toBe(false);
  });

  test("only the exact flag counts, so an unrelated value cannot silence hooks", () => {
    // A stray `PRESENCE_INTERNAL=0` in someone's profile must not mute the tool.
    process.env[KEY] = "0";
    expect(isInternalSession()).toBe(false);
    process.env[KEY] = "true";
    expect(isInternalSession()).toBe(false);
  });
});

describe("parseSummary", () => {
  test("takes the first line and drops surrounding quotes", () => {
    expect(parseSummary('"Optimizing terrain water vertex processing"\n')).toBe(
      "Optimizing terrain water vertex processing",
    );
  });

  test("rejects the unclear sentinel", () => {
    expect(parseSummary("unclear")).toBe("");
  });

  test("rejects a conversational reply rather than storing it as a finding", () => {
    // Measured: asked without the labelling framing, Haiku replied "I don't have
    // any current work to summarize. This is a fresh session…". Storing that
    // would put a refusal in the roster looking like a description.
    expect(parseSummary("I don't have any current work to summarize.")).toBe("");
    expect(parseSummary("There are no recent changes to describe.")).toBe("");
  });

  test("caps an over-long line at the roster width", () => {
    const out = parseSummary("Optimizing ".repeat(40));
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX);
  });

  test("returns empty for empty output", () => {
    expect(parseSummary("")).toBe("");
    expect(parseSummary("\n\n  \n")).toBe("");
  });
});
