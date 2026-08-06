/**
 * Is the code agents are RUNNING the code in this checkout?
 *
 * WRITTEN AGAINST THE SPEC. Hooks execute from `~/.claude/agent-presence/bin`,
 * never from the working tree, so editing a file here changes nothing until
 * `install.ts` copies it. Nothing detected the gap.
 *
 * MEASURED 2026-08-06. The name allocator was fixed, tested, committed, and
 * reported as shipped while every agent kept running yesterday's build: two new
 * sessions were named `akira` and `alder` -- pool positions 3 and 4, the
 * alphabetical behaviour the fix removed. The operator noticed, not the tool.
 * A full day of work, mine and another agent's, was absent from the running
 * install. `bun test` cannot catch this by construction: tests import from the
 * checkout, which is exactly the copy that is NOT running.
 *
 * The manifest already records `sourceRevision`. This is the comparison nobody
 * was making.
 */

import { describe, expect, test } from "bun:test";

import { driftFromInstalled, type InstallDrift } from "../core/repo.ts";

const MANIFEST = {
  installedAt: 1_785_986_435_671,
  sourceRevision: "ef07ac09909cf8e0672173faa5f5a8a4084f4516",
  contentHash: "74502704",
  schemaVersion: 3,
  featureSetVersion: 1,
  featureSet: ["who", "msg"],
};

const drift = (
  head: string | null,
  manifest: unknown = MANIFEST,
): InstallDrift => driftFromInstalled(manifest, head);

describe("driftFromInstalled", () => {
  test("same revision is not drift", () => {
    expect(drift(MANIFEST.sourceRevision).stale).toBe(false);
  });

  test("a different HEAD is drift, and names both revisions", () => {
    // THE MEASURED CASE: HEAD had moved a day past what was installed.
    const d = drift("3ff42f6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(d.stale).toBe(true);
    expect(d.installed).toBe(MANIFEST.sourceRevision);
    expect(d.head).toBe("3ff42f6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("a short HEAD matching the installed prefix is not drift", () => {
    // `git rev-parse --short` is what a human pastes; comparing raw strings
    // would report permanent drift and train everyone to ignore the warning.
    expect(drift("ef07ac0").stale).toBe(false);
  });

  test("no manifest is not drift — it is not installed at all", () => {
    // A checkout with nothing installed must not nag on every session start.
    // Silence is correct: there is no installed copy to be stale.
    expect(drift(MANIFEST.sourceRevision, null).stale).toBe(false);
  });

  test("a malformed manifest is not drift, and does not throw", () => {
    expect(drift("abc123", { installedAt: "yesterday" }).stale).toBe(false);
    expect(drift("abc123", "not an object").stale).toBe(false);
  });

  test("an unreadable HEAD is not drift — absence is not evidence", () => {
    // `install.ts` legitimately runs outside a git checkout, and a hook that
    // cannot read HEAD knows nothing. Claiming drift here would fire the
    // warning in every worktree where `git` is unavailable.
    expect(drift(null).stale).toBe(false);
    expect(drift("").stale).toBe(false);
  });

  test("a manifest built outside git records no revision and cannot drift", () => {
    // `parseManifest` accepts an empty `sourceRevision` on purpose: a build
    // with no traceable commit is a fact, not corruption. Nothing to compare.
    const d = drift("abc123", { ...MANIFEST, sourceRevision: "" });
    expect(d.stale).toBe(false);
  });

  test("case and whitespace do not manufacture drift", () => {
    expect(drift(` ${MANIFEST.sourceRevision.toUpperCase()} `).stale).toBe(false);
  });

  test("drift carries when the install happened, for a readable warning", () => {
    // "installed 2 days ago" is what makes the message actionable; a bare pair
    // of hashes tells the reader nothing about how far behind they are.
    expect(drift("3ff42f6").installedAt).toBe(MANIFEST.installedAt);
  });
});
