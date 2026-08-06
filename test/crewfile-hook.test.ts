/**
 * pre-edit × crew.json, run as the REAL subprocess with a payload on stdin —
 * the pure halves live in crewfile.test.ts; this pins the wiring: a generated
 * path records no claim at all, a hot path warns with nobody else live.
 *
 * `PRESENCE_TEST_DB` goes to the CHILD's environment only, so the freeze-at-
 * import trap that took seven files down (see msg-delivery.test.ts) cannot
 * reach any other test in this process.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { withStore } from "../core/store.ts";

const HOOK = new URL("../hooks/pre-edit.ts", import.meta.url).pathname.replace(
  /^\/(?=[A-Za-z]:)/,
  "",
);

let n = 0;
const roots: string[] = [];

function fixture(crewJson: Record<string, unknown>): { root: string; db: string } {
  const root = `${tmpdir().replace(/\\/g, "/")}/crewhook-${process.pid}-${n++}`;
  mkdirSync(`${root}/.claude`, { recursive: true });
  writeFileSync(`${root}/.claude/crew.json`, JSON.stringify(crewJson));
  roots.push(root);
  return { root, db: `${root}/presence.db` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runHook(root: string, db: string, filePath: string): string {
  const payload = JSON.stringify({
    session_id: "hook-test-session",
    cwd: root,
    tool_name: "Edit",
    tool_input: { file_path: filePath },
  });
  const proc = Bun.spawnSync(["bun", HOOK], {
    env: { ...process.env, PRESENCE_TEST_DB: db },
    stdin: Buffer.from(payload),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
  expect(proc.stderr.toString()).toBe("");
  return proc.stdout.toString();
}

function claimCount(db: string): number {
  return withStore(db, (store) => store.allClaims(Date.now()).length);
}

describe("pre-edit reads crew.json", () => {
  test("a generated path is never claimed and produces no output", () => {
    const { root, db } = fixture({ generated: ["dist/**"] });
    const out = runHook(root, db, `${root}/dist/bundle.js`);
    expect(out).toBe("");
    expect(claimCount(db)).toBe(0);
  }, 15000);

  test("an ordinary path is still claimed — the opt-out must not widen", () => {
    const { root, db } = fixture({ generated: ["dist/**"] });
    runHook(root, db, `${root}/src/index.ts`);
    expect(claimCount(db)).toBe(1);
  }, 15000);

  test("a hot path warns even with no other session live, and is still claimed", () => {
    const { root, db } = fixture({ hot: ["package.json"] });
    const out = runHook(root, db, `${root}/package.json`);
    expect(out).toContain("hot");
    expect(out).toContain("crew blame package.json");
    expect(claimCount(db)).toBe(1);
  }, 15000);

  test("with no crew.json at all the hook behaves as before", () => {
    const root = `${tmpdir().replace(/\\/g, "/")}/crewhook-${process.pid}-${n++}`;
    mkdirSync(root, { recursive: true });
    roots.push(root);
    const db = `${root}/presence.db`;
    const out = runHook(root, db, `${root}/src/index.ts`);
    expect(out).toBe("");
    expect(claimCount(db)).toBe(1);
  }, 15000);
});
