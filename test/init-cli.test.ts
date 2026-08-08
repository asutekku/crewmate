/**
 * `crew init` — the handler, driven through a fake CliContext on temp roots.
 *
 * AGAINST THE HANDLER, NOT `runCli`: `core/repo.ts` freezes PRESENCE_TEST_DB
 * at import, and one file's env harness has taken seven other files down
 * before (see msg-delivery.test.ts). The context object carries everything
 * the handler needs, so no database and no env var are involved at all.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";

import { clearCrewfileCache, crewfilePath } from "../core/crewfile.ts";
import { BLOCK_BEGIN, BLOCK_END } from "../core/initBlock.ts";
import type { Detected } from "../core/detect.ts";
import {
  createInitCommands,
  crewSizeLabel,
  deriveCrewJson,
  deriveTunables,
  mergeSettings,
  type InitOptions,
} from "../cli/init.ts";
import type { CliContext } from "../cli/types.ts";

const NO_OPTIONS: InitOptions = { overnight: false, baseRef: "head" };

const EMPTY_DETECTED: Detected = {
  units: [],
  generated: [],
  hot: [],
  sequenced: [],
  checks: { test: "", testScoped: "", lint: "" },
  codegen: [],
};

const DETECTED: Detected = {
  ...EMPTY_DETECTED,
  generated: ["dist/**"],
  hot: ["bun.lock", "package.json"],
  checks: { test: "bun test", testScoped: "bun test {path}", lint: "" },
};

describe("crewSizeLabel", () => {
  test("maps the documented answers and defaults to the honest range", () => {
    expect(crewSizeLabel(undefined)).toBe("3–10");
    expect(crewSizeLabel("2-3")).toBe("2–3");
    expect(crewSizeLabel("4-8")).toBe("4–8");
    expect(crewSizeLabel("more")).toBe("8+");
    expect(crewSizeLabel("12")).toBe("12");
    expect(crewSizeLabel("lots")).toBe("3–10");
  });
});

describe("deriveTunables: only what a flag can defend", () => {
  test("no flags, no keys — defaults are never restated", () => {
    expect(deriveTunables(NO_OPTIONS)).toEqual({});
  });

  test("a big crew raises the injection budget", () => {
    expect(deriveTunables({ ...NO_OPTIONS, crewSize: "more" })).toEqual({
      injectionTargetChars: 9000,
    });
    expect(deriveTunables({ ...NO_OPTIONS, crewSize: "12" })).toEqual({
      injectionTargetChars: 9000,
    });
    expect(deriveTunables({ ...NO_OPTIONS, crewSize: "4-8" })).toEqual({});
  });

  test("long tasks stretch claims and the board's patience", () => {
    expect(deriveTunables({ ...NO_OPTIONS, taskLength: "long" })).toEqual({
      claimTtlMs: 4 * 60 * 60 * 1000,
      workStaleMs: 3 * 60 * 60 * 1000,
    });
  });

  test("overnight sessions stretch the roster horizon", () => {
    expect(deriveTunables({ ...NO_OPTIONS, overnight: true })).toEqual({
      staleMs: 12 * 60 * 60 * 1000,
    });
  });
});

describe("deriveCrewJson: detection layered over the existing file", () => {
  test("empty detection over no file yields the bare version stamp", () => {
    expect(deriveCrewJson(EMPTY_DETECTED, null, NO_OPTIONS)).toEqual({ v: 1 });
  });

  test("detection populates the shipped-consumer keys", () => {
    const derived = deriveCrewJson(DETECTED, null, NO_OPTIONS);
    expect(derived["generated"]).toEqual(["dist/**"]);
    expect(derived["hot"]).toEqual(["bun.lock", "package.json"]);
    expect(derived["checks"]).toEqual({ test: "bun test", testScoped: "bun test {path}", lint: "" });
  });

  test("a scoped form defaults the policy to scoped-only; a flag overrides", () => {
    expect(deriveCrewJson(DETECTED, null, NO_OPTIONS)["testPolicy"]).toBe("scoped-only");
    expect(
      deriveCrewJson(DETECTED, null, { ...NO_OPTIONS, testPolicy: "full-ok" })["testPolicy"],
    ).toBe("full-ok");
    expect(deriveCrewJson(EMPTY_DETECTED, null, NO_OPTIONS)["testPolicy"]).toBeUndefined();
  });

  test("hand-added hot entries survive re-derivation", () => {
    const derived = deriveCrewJson(DETECTED, { hot: ["schema.sql"] }, NO_OPTIONS);
    expect(derived["hot"]).toEqual(["schema.sql", "bun.lock", "package.json"]);
  });

  test("hand-written checks beat detection", () => {
    const derived = deriveCrewJson(
      DETECTED,
      { checks: { test: "make test", testScoped: "", lint: "" } },
      NO_OPTIONS,
    );
    expect((derived["checks"] as Record<string, string>)["test"]).toBe("make test");
    expect((derived["checks"] as Record<string, string>)["testScoped"]).toBe("bun test {path}");
  });

  test("commit is absent until something asks for it", () => {
    expect(deriveCrewJson(DETECTED, null, NO_OPTIONS)["commit"]).toBeUndefined();
  });

  test("--sign writes the policy", () => {
    const derived = deriveCrewJson(DETECTED, null, { ...NO_OPTIONS, sign: true });
    expect(derived["commit"]).toEqual({ sign: true, sessionUrl: false });
  });

  test("a hand-written policy survives a re-run with no flag", () => {
    const derived = deriveCrewJson(DETECTED, { commit: { sign: true } }, NO_OPTIONS);
    expect((derived["commit"] as Record<string, boolean>)["sign"]).toBe(true);
  });

  test("--no-sign beats the hand-written value", () => {
    const derived = deriveCrewJson(DETECTED, { commit: { sign: true } }, {
      ...NO_OPTIONS,
      sign: false,
    });
    expect(derived["commit"]).toBeUndefined();
  });

  test("pending, reserved and unknown keys pass through verbatim", () => {
    const derived = deriveCrewJson(
      DETECTED,
      {
        units: ["apps/*"],
        sequenced: ["migrations"],
        codegen: [{ edits: "a", stales: "", run: "gen" }],
        topics: ["db"],
        myExperiment: { x: 1 },
      },
      NO_OPTIONS,
    );
    expect(derived["units"]).toEqual(["apps/*"]);
    expect(derived["sequenced"]).toEqual(["migrations"]);
    expect(derived["codegen"]).toEqual([{ edits: "a", stales: "", run: "gen" }]);
    expect(derived["topics"]).toEqual(["db"]);
    expect(derived["myExperiment"]).toEqual({ x: 1 });
  });

  test("existing tunables survive; flags override per key", () => {
    const derived = deriveCrewJson(
      EMPTY_DETECTED,
      { tunables: { staleMs: 111, workStaleMs: 222 } },
      { ...NO_OPTIONS, taskLength: "long" },
    );
    expect(derived["tunables"]).toEqual({
      staleMs: 111,
      workStaleMs: 3 * 60 * 60 * 1000,
      claimTtlMs: 4 * 60 * 60 * 1000,
    });
  });

  test("deriving over its own output is a fixed point", () => {
    const once = deriveCrewJson(DETECTED, null, NO_OPTIONS);
    const twice = deriveCrewJson(DETECTED, once, NO_OPTIONS);
    expect(twice).toEqual(once);
  });
});

describe("mergeSettings", () => {
  test("no file: a fresh object carrying only the worktree key", () => {
    const merged = mergeSettings(null, "head");
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(JSON.parse(merged.text)).toEqual({ worktree: { baseRef: "head" } });
      expect(merged.text.endsWith("\n")).toBe(true);
    }
  });

  test("existing keys — including other worktree keys — are preserved", () => {
    const merged = mergeSettings(
      JSON.stringify({ permissions: { allow: ["x"] }, worktree: { keep: true, baseRef: "old" } }),
      "main",
    );
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(JSON.parse(merged.text)).toEqual({
        permissions: { allow: ["x"] },
        worktree: { keep: true, baseRef: "main" },
      });
    }
  });

  test("invalid JSON aborts — never a silent overwrite", () => {
    expect(mergeSettings("{oops", "head").ok).toBe(false);
    expect(mergeSettings("[1,2]", "head").ok).toBe(false);
  });
});

// ---- the handler end to end, on temp roots

interface Run {
  readonly logs: string[];
  readonly errors: string[];
  readonly failed: boolean;
}

function runInit(root: string, args: readonly string[], isGit = false): Run {
  const logs: string[] = [];
  const errors: string[] = [];
  let failed = false;
  const context: CliContext = {
    dbPath: `${root}/unused.db`,
    projectName: "fixture",
    projectRoot: root,
    projectKey: root,
    binRoot: root,
    isGit,
    cwd: root,
    sessionId: "",
    now: () => 1_700_000_000_000,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    fail: () => {
      failed = true;
    },
  };
  const commands = createInitCommands(context);
  commands["init"]!(args);
  return { logs, errors, failed };
}

describe("the init handler on a temp root", () => {
  const roots: string[] = [];
  let n = 0;
  const fresh = (files: Record<string, string> = {}): string => {
    const root = `${tmpdir().replace(/\\/g, "/")}/init-cli-${process.pid}-${n++}`;
    mkdirSync(root, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = `${root}/${rel}`;
      mkdirSync(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      writeFileSync(abs, content);
    }
    roots.push(root);
    return root;
  };
  afterEach(() => {
    clearCrewfileCache();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("bare init on a bun repo writes crew.json and the CLAUDE.md block, no prompts", () => {
    const root = fresh({ "package.json": "{}", "bun.lock": "", "test/x.test.ts": "" });
    const run = runInit(root, []);
    expect(run.failed).toBe(false);
    const crew = JSON.parse(readFileSync(crewfilePath(root), "utf8")) as Record<string, unknown>;
    expect(crew["v"]).toBe(1);
    expect(crew["testPolicy"]).toBe("scoped-only");
    expect((crew["checks"] as Record<string, string>)["testScoped"]).toBe("bun test {path}");
    const claude = readFileSync(`${root}/CLAUDE.md`, "utf8");
    expect(claude).toContain(BLOCK_BEGIN);
    expect(claude).toContain(BLOCK_END);
  });

  test("reinit is stable: same bytes, one block, hand edits kept", () => {
    const root = fresh({ "package.json": "{}", "bun.lock": "" });
    runInit(root, []);
    const crew = JSON.parse(readFileSync(crewfilePath(root), "utf8")) as Record<string, unknown>;
    crew["hot"] = [...(crew["hot"] as string[]), "schema.sql"];
    (crew as Record<string, unknown>)["topics"] = ["db"];
    writeFileSync(crewfilePath(root), JSON.stringify(crew, null, 2));
    clearCrewfileCache();

    const second = runInit(root, []);
    expect(second.failed).toBe(false);
    const after = JSON.parse(readFileSync(crewfilePath(root), "utf8")) as Record<string, unknown>;
    expect(after["hot"]).toContain("schema.sql");
    expect(after["topics"]).toEqual(["db"]);
    const claudeAfter = readFileSync(`${root}/CLAUDE.md`, "utf8");
    expect(claudeAfter.split(BLOCK_BEGIN).length - 1).toBe(1);

    const third = runInit(root, []);
    expect(third.failed).toBe(false);
    expect(readFileSync(`${root}/CLAUDE.md`, "utf8")).toBe(claudeAfter);
    expect(JSON.parse(readFileSync(crewfilePath(root), "utf8"))).toEqual(after);
  });

  test("an existing lowercase claude.md is edited, not shadowed", () => {
    const root = fresh({ "claude.md": "# Hand rules\n", "package.json": "{}" });
    runInit(root, []);
    expect(existsSync(`${root}/CLAUDE.md`)).toBe(existsSync(`${root}/claude.md`));
    const text = readFileSync(`${root}/claude.md`, "utf8");
    expect(text.startsWith("# Hand rules")).toBe(true);
    expect(text).toContain(BLOCK_BEGIN);
  });

  test("damaged markers fail loudly and leave the file alone", () => {
    const root = fresh({ "CLAUDE.md": `# x\n${BLOCK_BEGIN}\nno end marker\n` });
    const before = readFileSync(`${root}/CLAUDE.md`, "utf8");
    const run = runInit(root, []);
    expect(run.failed).toBe(true);
    expect(run.errors.join("\n")).toContain("marker");
    expect(readFileSync(`${root}/CLAUDE.md`, "utf8")).toBe(before);
  });

  test("--no-claude-md leaves the file untouched", () => {
    const root = fresh({ "CLAUDE.md": "# mine\n" });
    runInit(root, ["--no-claude-md"]);
    expect(readFileSync(`${root}/CLAUDE.md`, "utf8")).toBe("# mine\n");
    expect(existsSync(crewfilePath(root))).toBe(true);
  });

  test("a git repo also gets settings.json with the base ref; a plain dir does not", () => {
    const root = fresh({ "package.json": "{}" });
    runInit(root, ["--base-ref", "main"], true);
    const settings = JSON.parse(readFileSync(`${root}/.claude/settings.json`, "utf8")) as Record<
      string,
      unknown
    >;
    expect(settings["worktree"]).toEqual({ baseRef: "main" });

    const plain = fresh({ "package.json": "{}" });
    runInit(plain, []);
    expect(existsSync(`${plain}/.claude/settings.json`)).toBe(false);
  });

  test("invalid settings.json aborts that file and fails, but still writes crew.json", () => {
    const root = fresh({ ".claude/settings.json": "{not json" });
    const before = readFileSync(`${root}/.claude/settings.json`, "utf8");
    const run = runInit(root, [], true);
    expect(run.failed).toBe(true);
    expect(readFileSync(`${root}/.claude/settings.json`, "utf8")).toBe(before);
    expect(existsSync(crewfilePath(root))).toBe(true);
  });

  test("--check writes nothing and fails while things are missing", () => {
    const root = fresh({ "package.json": "{}" });
    const run = runInit(root, ["--check", "--repo"]);
    expect(run.failed).toBe(true);
    expect(existsSync(crewfilePath(root))).toBe(false);
    expect(existsSync(`${root}/CLAUDE.md`)).toBe(false);
    expect(run.logs.join("\n")).toContain("derived crew.json");
  });

  test("--check --repo passes once init has run", () => {
    const root = fresh({ "package.json": "{}", "bun.lock": "" });
    runInit(root, []);
    clearCrewfileCache();
    const run = runInit(root, ["--check", "--repo"]);
    expect(run.failed).toBe(false);
  });

  test("--check reports reserved and unknown keys as unread", () => {
    const root = fresh({
      ".claude/crew.json": JSON.stringify({ topics: ["db"], banana: 1 }),
    });
    const run = runInit(root, ["--check", "--repo"]);
    const out = run.logs.join("\n");
    expect(out).toContain("reserved keys present");
    expect(out).toContain("topics");
    expect(out).toContain("unknown keys");
    expect(out).toContain("banana");
  });

  test("--check names detected keys whose consumer is pending", () => {
    const root = fresh({
      "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
    });
    const run = runInit(root, ["--check", "--repo"]);
    expect(run.logs.join("\n")).toContain("consumer pending");
    expect(run.logs.join("\n")).toContain("units");
  });

  test("--repo without --check is refused", () => {
    const run = runInit(fresh(), ["--repo"]);
    expect(run.failed).toBe(true);
    expect(run.errors.join("\n")).toContain("--repo only narrows --check");
  });

  test("unknown flags and bad enum values are refused before anything writes", () => {
    const root = fresh();
    expect(runInit(root, ["--frobnicate"]).failed).toBe(true);
    expect(runInit(root, ["--test-policy", "sometimes"]).failed).toBe(true);
    expect(runInit(root, ["--task-length", "epic"]).failed).toBe(true);
    expect(existsSync(crewfilePath(root))).toBe(false);
  });

  test("tunable flags land in crew.json", () => {
    const root = fresh();
    runInit(root, ["--crew-size", "more", "--task-length", "long", "--overnight"]);
    const crew = JSON.parse(readFileSync(crewfilePath(root), "utf8")) as Record<string, unknown>;
    expect(crew["tunables"]).toEqual({
      injectionTargetChars: 9000,
      claimTtlMs: 4 * 60 * 60 * 1000,
      workStaleMs: 3 * 60 * 60 * 1000,
      staleMs: 12 * 60 * 60 * 1000,
    });
  });
});
