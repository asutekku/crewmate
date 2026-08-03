import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";

import { renderStats } from "../cli/diagnostics-renderers.ts";
import type { CliContext } from "../cli/types.ts";
import { withStore } from "../core/store.ts";

test("stats rendering distinguishes an optional-subsystem failure from zero data", () => {
  const path = `${tmpdir().replace(/\\/g, "/")}/presence-diagnostics-${process.pid}.db`;
  try {
    const stats = withStore(path, (store) => store.stats(0));
    const lines: string[] = [];
    const context: CliContext = {
      dbPath: path,
      projectName: "safe\u001b]8;;https://evil.test\u0007name",
      projectRoot: "/project",
      binRoot: "/bin",
      projectKey: "project",
      isGit: false,
      cwd: "/project",
      sessionId: "",
      now: () => 1000,
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
      fail: () => {},
    };
    renderStats(context, {
      stats,
      nowMs: 1000,
      databaseBytes: 0,
      personalError: "unavailable\nretry later\u001b[31m",
    });
    const output = lines.join("\n");
    expect(output).toContain("personal memory unavailable: unavailable retry later");
    expect(output).not.toContain("https://evil.test");
    expect(output).not.toContain("\u001b[31m");
    expect(output).toContain("no activity recorded");
  } finally {
    for (const suffix of ["", "-wal", "-shm"])
      try {
        unlinkSync(path + suffix);
      } catch {
        // Already absent.
      }
  }
});
