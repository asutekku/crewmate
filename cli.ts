#!/usr/bin/env bun

/** Thin executable boundary for the presence CLI. */

import { runCli } from "./cli/main.ts";

runCli(Bun.argv.slice(2), {
  cwd: process.cwd(),
  binRoot: import.meta.dir,
  sessionId: process.env["CLAUDE_CODE_SESSION_ID"] ?? "",
});
