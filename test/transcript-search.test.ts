/**
 * FINDING A CRASHED CONVERSATION: the window is gone, the roster row with it,
 * and the transcript on disk is the only durable record. Every case here is
 * something that would make the search point the operator at the wrong session
 * -- or at one that cannot be resumed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import {
  everyProjectDir,
  searchTranscripts,
  transcriptFiles,
} from "../core/transcript-search.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function projectDir(): string {
  const dir = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/scan-`);
  dirs.push(dir);
  return dir;
}

/** One assistant text block, as Claude Code records it. */
function assistantLine(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    timestamp: "2026-08-06T12:00:00.000Z",
    cwd: "I:\\Projects\\demo",
  });
}

function writeTranscript(dir: string, id: string, lines: readonly string[]): void {
  writeFileSync(`${dir}/${id}.jsonl`, `${lines.join("\n")}\n`);
}

describe("transcript search", () => {
  test("finds a conversation by prose and reports it as resumable", async () => {
    const dir = projectDir();
    writeTranscript(dir, "aaaaaaaa-1111-2222-3333-444444444444", [
      assistantLine("I rewrote the battlepass tier table and the claim path."),
    ]);
    const hits = await searchTranscripts(transcriptFiles([dir]), "battlepass");
    expect(hits).toHaveLength(1);
    // The uuid is what `claude --resume` takes, so it must be the FILENAME.
    expect(hits[0]?.sessionId).toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(hits[0]?.count).toBe(1);
    expect(hits[0]?.snippet).toContain("battlepass");
    // `cwd` names the real project, which a slugged directory name cannot.
    expect(hits[0]?.projectPath).toBe("I:\\Projects\\demo");
  });

  test("ranks the session that did the work above the one that mentioned it", async () => {
    const dir = projectDir();
    writeTranscript(dir, "11111111-1111-1111-1111-111111111111", [
      assistantLine("A passing remark about the battlepass, nothing more."),
    ]);
    writeTranscript(dir, "22222222-2222-2222-2222-222222222222", [
      assistantLine("battlepass rewards wired"),
      assistantLine("battlepass migration written"),
      assistantLine("battlepass tests pass"),
    ]);
    const hits = await searchTranscripts(transcriptFiles([dir]), "battlepass");
    expect(hits.map((hit) => hit.count)).toEqual([3, 1]);
    expect(hits[0]?.sessionId).toBe("22222222-2222-2222-2222-222222222222");
  });

  test("a term only in tool output is not a hit", async () => {
    const dir = projectDir();
    // The word appears in a file the session READ. That means the file was
    // open, never that the session worked on it -- counting these makes every
    // conversation look equally relevant, which is the whole ranking gone.
    writeTranscript(dir, "33333333-3333-3333-3333-333333333333", [
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: "export const battlepass = 1;" },
          ],
        },
      }),
    ]);
    const hits = await searchTranscripts(transcriptFiles([dir]), "battlepass");
    expect(hits).toHaveLength(0);
  });

  test("subagent transcripts are never offered, because --resume cannot reach them", async () => {
    const dir = projectDir();
    const nested = `${dir}/44444444-4444-4444-4444-444444444444/subagents`;
    mkdirSync(nested, { recursive: true });
    writeFileSync(`${nested}/agent-abc.jsonl`, `${assistantLine("battlepass work")}\n`);
    expect(transcriptFiles([dir])).toHaveLength(0);
  });

  test("matches across a chunk boundary and ignores case", async () => {
    const dir = projectDir();
    // The byte prefilter reads in chunks; a term split across two of them is
    // the case the carried overlap exists for.
    const filler = assistantLine("x".repeat(4000));
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(filler);
    lines.push(assistantLine("Finished the BattlePass audit."));
    writeTranscript(dir, "55555555-5555-5555-5555-555555555555", lines);
    const hits = await searchTranscripts(transcriptFiles([dir]), "battlepass");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.count).toBe(1);
  });

  test("an unreadable file is skipped rather than failing the search", async () => {
    const dir = projectDir();
    writeTranscript(dir, "66666666-6666-6666-6666-666666666666", [
      assistantLine("battlepass work"),
    ]);
    const files = [...transcriptFiles([dir]), `${dir}/gone.jsonl`];
    const hits = await searchTranscripts(files, "battlepass");
    expect(hits).toHaveLength(1);
  });

  test("an empty term matches nothing, rather than everything", async () => {
    const dir = projectDir();
    writeTranscript(dir, "77777777-7777-7777-7777-777777777777", [
      assistantLine("anything at all"),
    ]);
    expect(await searchTranscripts(transcriptFiles([dir]), "")).toHaveLength(0);
  });

  test("every project directory is discovered, and a missing root is empty", () => {
    const root = projectDir();
    mkdirSync(`${root}/one`, { recursive: true });
    mkdirSync(`${root}/two`, { recursive: true });
    expect(everyProjectDir(root)).toHaveLength(2);
    expect(everyProjectDir(`${root}/absent`)).toEqual([]);
  });
});
