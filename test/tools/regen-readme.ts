/**
 * Rewrites the README's command tables from the verb table.
 *
 * `test/verbs.test.ts` FAILS when a verb is missing from the README, which is
 * the guard; this is the fix. Doing it by hand was fine once and wrong twice --
 * the tables are wholly derived, so regenerating them is mechanical and a
 * hand-edit is just a chance to introduce drift the test then catches.
 *
 * Run: bun test/tools/regen-readme.ts
 */

import { VERB_GROUPS, VERBS } from "../../core/verbs.ts";

const README = new URL("../../README.md", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "");

/** Escapes what would otherwise end a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function tables(): string {
  const out: string[] = [];
  for (const g of VERB_GROUPS) {
    const rows = VERBS.filter((v) => v.group === g.group && v.hidden !== true);
    if (rows.length === 0) continue;
    out.push(`### ${g.title[0]?.toUpperCase()}${g.title.slice(1)}`, "", "| Command | Does |", "|---|---|");
    for (const v of rows) {
      const call = `\`${v.verb}${v.args === "" ? "" : ` ${v.args}`}\``;
      out.push(`| ${cell(call)} | ${cell(v.blurb)} |`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

const START = "<!-- BEGIN GENERATED COMMANDS -->";
const END = "<!-- END GENERATED COMMANDS -->";

const src = await Bun.file(README).text();
// Explicit markers, not headings. This was anchored on the section that
// followed the tables; the 2026-08-05 split moved it into `docs/`, so the
// generator exited 1 unread and the tables drifted by hand for a day.
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end < start) {
  console.error(`markers not found in ${README} — expected ${START} … ${END}`);
  process.exit(1);
}

const next = `${src.slice(0, start + START.length)}\n\n${tables()}\n\n${src.slice(end)}`;
if (next === src) {
  console.log("README command tables already current.");
} else {
  await Bun.write(README, next);
  console.log(`Regenerated ${VERBS.filter((v) => v.hidden !== true).length} verbs into the README.`);
}
