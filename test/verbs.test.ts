/**
 * The verb table against the dispatcher it documents.
 *
 * THE ONE TEST THAT MATTERS IS `drift`. Everything else here is ordinary
 * coverage; that one is the reason the file exists. A hand-maintained usage
 * string reached 13 of 33 verbs before anyone noticed, because nothing failed
 * when a verb shipped without help text -- the feature worked, the tests passed,
 * and it was simply invisible to every agent that had not read CLAUDE.md.
 *
 * The CLI application is importable without process side effects, so this
 * compares the registry itself to the table rather than parsing source text.
 */

import { describe, expect, test } from "bun:test";

import {
  allVerbSpellings,
  findVerb,
  usage,
  usageFor,
  VERB_GROUPS,
  VERBS,
} from "../core/verbs.ts";
import { commandNames } from "../cli/main.ts";
import type { CliContext } from "../cli/types.ts";

const context: CliContext = {
  dbPath: "",
  projectName: "test",
  projectRoot: "",
  projectKey: "test",
  isGit: false,
  cwd: "",
  binRoot: "",
  sessionId: "",
  now: () => 0,
  log: () => {},
  error: () => {},
  fail: () => {},
};

const dispatcherVerbs = (): string[] => commandNames(context);

describe("the table and the dispatcher cannot drift", () => {
  test("every dispatched verb is in the table", () => {
    const documented = new Set(allVerbSpellings());
    const missing = dispatcherVerbs().filter((v) => !documented.has(v));
    // Names the offenders rather than asserting a count, so the failure tells
    // you which verb to add instead of that some verb is absent.
    expect(missing).toEqual([]);
  });

  test("every table entry is actually dispatched", () => {
    const dispatched = new Set(dispatcherVerbs());
    const phantom = allVerbSpellings().filter((v) => !dispatched.has(v));
    expect(phantom).toEqual([]);
  });

  test("the registry really was read -- an empty result would not pass", () => {
    expect(dispatcherVerbs().length).toBeGreaterThan(25);
    expect(VERBS.length).toBeGreaterThan(25);
  });
});

describe("the README documents what ships", () => {
  // Same drift, one file over. The module tables listed 12 of 18 `core/` files
  // and 12 of 14 hooks -- `diary.ts`, `personal.ts` and `commit-landed.ts` had
  // shipped and appeared nowhere, in the very README that explains why the
  // usage string must not drift.
  const README = Bun.file(new URL("../README.md", import.meta.url));

  /**
   * Modules in a sibling folder.
   *
   * The count is asserted by every caller, because a glob that resolves to
   * nothing makes `files.filter(...)` an empty array and the drift check passes
   * VACUOUSLY -- the exact shape of failure this whole file was written to
   * catch, one level up. Windows paths are the plausible way it breaks.
   */
  function modulesIn(folder: string, atLeast: number): string[] {
    const dir = new URL(`../${folder}`, import.meta.url).pathname.replace(
      /^\/(?=[A-Za-z]:)/,
      "",
    );
    const files = [...new Bun.Glob("*.ts").scanSync(dir)];
    expect(files.length).toBeGreaterThanOrEqual(atLeast);
    return files;
  }

  test("every core module is in the module table", async () => {
    const text = await README.text();
    expect(
      modulesIn("core", 15).filter((f) => !text.includes(`\`${f}\``)),
    ).toEqual([]);
  });

  test("every hook is in the hook table", async () => {
    const text = await README.text();
    expect(
      modulesIn("hooks", 12).filter((f) => !text.includes(`\`${f}\``)),
    ).toEqual([]);
  });

  test("every verb reaches the README, not just --help", async () => {
    const text = await README.text();
    expect(
      VERBS.filter((v) => v.hidden !== true && !text.includes(`\`${v.verb}`)),
    ).toEqual([]);
  });
});

describe("the table is well formed", () => {
  test("no verb is listed twice, including as an alias", () => {
    const all = allVerbSpellings();
    expect(all.length).toBe(new Set(all).size);
  });

  test("every verb has a group the renderer knows about", () => {
    const groups = new Set(VERB_GROUPS.map((g) => g.group));
    for (const v of VERBS) expect(groups.has(v.group)).toBe(true);
  });

  test("every verb carries a blurb, lowercase and without a trailing period", () => {
    for (const v of VERBS) {
      expect(v.blurb.length).toBeGreaterThan(0);
      expect(v.blurb.endsWith(".")).toBe(false);
      expect(v.blurb[0]).toBe((v.blurb[0] ?? "").toLowerCase());
    }
  });

  test("findVerb resolves aliases to their canonical row", () => {
    expect(findVerb("name")?.verb).toBe("call-me");
    expect(findVerb("role")?.verb).toBe("call-you");
    expect(findVerb("nonsense")).toBeUndefined();
  });
});

describe("usageFor", () => {
  test("states a verb's arguments once, for both help and argument errors", () => {
    expect(usageFor("msg")).toBe(
      'usage: cli.ts msg <name> "<text>" [--from <name>]',
    );
  });

  test("omits the space when a verb takes no arguments", () => {
    expect(usageFor("mine")).toBe("usage: cli.ts mine");
  });

  test("an unknown verb degrades instead of throwing", () => {
    // Reached only from an error path, so throwing here would replace a bad
    // -arguments message with a crash.
    expect(usageFor("nonsense")).toBe("usage: cli.ts nonsense");
  });
});

describe("rendered help", () => {
  const text = usage(100);

  test("lists every non-hidden verb", () => {
    for (const v of VERBS) {
      if (v.hidden === true) continue;
      expect(text).toContain(v.verb);
    }
  });

  test("includes the verbs that were missing from the old hand-written string", () => {
    // The specific regression. These existed, worked, and appeared nowhere.
    for (const v of [
      "note",
      "recall",
      "remember",
      "breaks",
      "needs",
      "blame",
      "files",
    ]) {
      expect(text).toContain(v);
    }
  });

  test("shows every group heading", () => {
    for (const g of VERB_GROUPS) expect(text).toContain(g.title);
  });

  test("never truncates an argument spec", () => {
    // A cut-off spec is worse than a wrapped one: it reads as complete and is
    // wrong. Long calls move their blurb to the next line instead.
    expect(text).not.toContain("…");
    for (const v of VERBS) {
      if (v.args === "" || v.hidden === true) continue;
      expect(text).toContain(`${v.verb} ${v.args}`);
    }
  });

  test("respects the width it is given", () => {
    // Every line, both forms. An earlier version exempted the stacked form and
    // a 108-char line sailed through a 100-char budget, because the check was
    // computed from the UNPADDED call while the renderer padded to a column.
    for (const w of [80, 100, 120]) {
      for (const line of usage(w).split("\n"))
        expect(line.length).toBeLessThanOrEqual(w);
    }
  });

  test("one wide spec does not cost every other verb its column", () => {
    // THE REGRESSION THIS FILE EXISTS FOR, after drift. `note`'s 62-char spec
    // padded all 33 verbs to 62 and pushed the worst pair to 126 columns, so
    // the table never fired even at 120 and every verb stacked. A wide row now
    // stacks alone.
    const wide = usage(120).split("\n");
    const tabled = wide.filter((l) => /^ {4}\S.* {2,}\S/.test(l));
    expect(tabled.length).toBeGreaterThan(20);
  });

  test("the column is a fixed point, not one pass", () => {
    // Dropping a wide row shrinks the column, which can readmit a row dropped
    // earlier. A single pass settles on a column wider than necessary, so the
    // table is narrower than the widest call it contains.
    const lines = usage(120).split("\n");
    const pairs = lines.filter((l) => /^ {4}\S.* {2,}\S/.test(l));
    const widest = Math.max(...pairs.map((l) => l.length));
    expect(widest).toBeLessThanOrEqual(120);
  });
});
