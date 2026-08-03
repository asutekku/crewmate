import { describe, expect, test } from "bun:test";

const entrySource = await Bun.file(
  new URL("../cli.ts", import.meta.url),
).text();
const cliDirectory = new URL("../cli", import.meta.url).pathname.replace(
  /^\/(?=[A-Za-z]:)/,
  "",
);

describe("CLI architecture", () => {
  test("the executable boundary stays thin and side-effect-free to import below it", () => {
    expect(entrySource.split(/\r?\n/).length).toBeLessThan(30);
    expect(entrySource).toContain('import { runCli } from "./cli/main.ts"');
    expect(entrySource).not.toContain("switch (");
    expect(entrySource).not.toContain("withStore");
  });

  test("CLI domain modules keep unsafe boundaries and clocks explicit", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(cliDirectory)];
    const sources = await Promise.all(
      files.map((file) => Bun.file(`${cliDirectory}/${file}`).text()),
    );
    const production = sources.join("\n");
    expect(production).not.toMatch(/\bany\b/);
    expect(production).not.toContain("Date.now()");
    expect(production).not.toContain('"error" in');
    expect(production).not.toMatch(/ok: (?:true|false) as const/);
    expect(production).not.toMatch(/\btakeFlag\b/);
    expect(production).not.toMatch(/\.shift\s*\(/);
    expect(production).not.toMatch(/\.splice\s*\(/);
    expect(production.match(/context\.now\(\)/g)?.length).toBe(
      production.match(/const now = context\.now\(\)/g)?.length,
    );
    expect(production.match(/usageFor\(/g)?.length).toBe(1);
  });

  test("obligation reads do not fetch unused event history", async () => {
    const source = await Bun.file(
      new URL("../cli/obligations.ts", import.meta.url),
    ).text();
    expect(source).not.toContain("obligations.events(");
  });

  test("the roster command remains orchestration over isolated pipeline stages", async () => {
    const source = await Bun.file(
      new URL("../cli/roster.ts", import.meta.url),
    ).text();
    const commandBody = source.slice(
      source.indexOf("export function createRosterCommands"),
    );
    expect(commandBody.split(/\r?\n/).length).toBeLessThan(55);
    expect(source).toContain("synchronizeRosterStore(store, agents, now)");
    expect(source).toContain(
      "collectRosterSnapshot(store, now, SUMMARY_TTL_MS)",
    );
    expect(source).toContain("buildRosterView({");
    expect(source).toContain("renderSessions(");
    expect(source).toContain("renderBackgroundProcesses(");
    expect(source).toContain("renderContentionWarnings(");
    expect(source).not.toContain("dirtyFiles(");

    const renderers = await Bun.file(
      new URL("../cli/roster-renderers.ts", import.meta.url),
    ).text();
    for (const renderer of [
      "renderSession",
      "renderMinions",
      "renderClaims",
      "renderBackgroundProcesses",
      "renderContentionWarnings",
    ]) {
      expect(renderers).toContain(`export function ${renderer}`);
    }
  });
});
