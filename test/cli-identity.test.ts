import { describe, expect, test } from "bun:test";

import type { Session } from "../core/store.ts";
import { resolveLiveName } from "../cli/identity.ts";

function session(name: string, handle: string, alias = ""): Session {
  return {
    sessionId: `${name}-id`,
    name,
    handle,
    alias,
    role: "",
    status: "idle",
    blocked: "",
    worktree: "",
    branch: "",
    behindBase: 0,
    baseBranch: "",
    lineageFrom: "",
    intent: "",
    title: "",
    summary: "",
    summaryMs: 0,
    lastSeenMs: 1,
    startedMs: 1,
  };
}

describe("live-name resolution policy", () => {
  const sessions = [session("traffic-a", "ada"), session("traffic-b", "alder")];

  test("prefers exact names over prefixes", () => {
    expect(resolveLiveName(sessions, "ada")).toMatchObject({
      ok: true,
      value: { handle: "ada" },
    });
  });

  test("accepts one historical-style prefix but rejects multiple candidates", () => {
    expect(resolveLiveName(sessions, "traffic-a")).toMatchObject({ ok: true });
    expect(resolveLiveName(sessions, "traffic-")).toEqual({
      ok: false,
      kind: "ambiguous",
      query: "traffic-",
      candidates: ["ada", "alder"],
    });
  });

  test("distinguishes no match from ambiguity", () => {
    expect(resolveLiveName(sessions, "nobody")).toEqual({
      ok: false,
      kind: "not_found",
      query: "nobody",
      candidates: [],
    });
  });
});
