/**
 * Regenerates the audience tables in `docs/audiences.md` from `core/verbs.ts`.
 *
 * WHY THIS EXISTS. The audience split was prose, and prose drifted immediately:
 * `docs/audiences.md` mis-stated its own totals ("4 confirmed code defects"
 * against six, "11 absent features" against twelve), and the plan written to
 * fix that drift reproduced it inside itself. Hand-maintained counts in this
 * repo have a 100% measured drift rate across four instances.
 *
 * So the tables are DERIVED, exactly like the README's command tables
 * (`regen-readme.ts`) and the `--help` text (`usage()`). `test/audiences.test.ts`
 * fails when the file disagrees with the verb table; this is the fix.
 *
 * Run: bun test/tools/regen-audiences.ts
 */

import { VERBS, type VerbAudience } from "../../core/verbs.ts";

const DOC = new URL("../../docs/audiences.md", import.meta.url).pathname.replace(
  /^\/(?=[A-Za-z]:)/,
  "",
);

const START = "<!-- BEGIN GENERATED AUDIENCES -->";
const END = "<!-- END GENERATED AUDIENCES -->";

const SECTIONS: ReadonlyArray<{
  readonly audience: VerbAudience;
  readonly title: string;
  readonly blurb: string;
}> = [
  {
    audience: "agent",
    title: "Agent",
    blurb:
      "Reached from an injection, a hook, or another agent's coordination. A " +
      "human *can* run any of these; almost none are worth typing.",
  },
  {
    audience: "human",
    title: "Human",
    blurb:
      "Operator surfaces, built for a terminal window. Two fields in `who` — " +
      "the conversation title and the model-written `doing:` line — are never " +
      "spent on an agent's injection budget; see [Views](views.md).",
  },
  {
    audience: "shared",
    title: "Shared",
    blurb:
      "Symmetric: both parties do the same thing. The sender is identified " +
      "from `CLAUDE_CODE_SESSION_ID`, so an agent's message attributes to that " +
      "agent and one typed in a terminal attributes to you.",
  },
  {
    audience: "oversight",
    title: "Oversight",
    blurb:
      "Asymmetric: agents write it, the operator audits it. Distinct from " +
      "*shared* on purpose — collapsing the two hid the real gap, which is " +
      "that the operator had no aggregate read surface at all.",
  },
];

/** Escapes what would otherwise end a markdown table cell. */
const cell = (text: string): string => text.replace(/\|/g, "\\|");

function generated(): string {
  const out: string[] = [
    "",
    "| Audience | Count |",
    "| -------- | ----- |",
  ];
  for (const s of SECTIONS)
    out.push(`| ${s.audience} | ${VERBS.filter((v) => v.audience === s.audience).length} |`);
  out.push(
    "",
    `Derived from \`core/verbs.ts\` by \`test/tools/regen-audiences.ts\`; ` +
      `${VERBS.length} verbs in total. Do not edit between the markers.`,
    "",
  );

  for (const s of SECTIONS) {
    const rows = VERBS.filter((v) => v.audience === s.audience && v.hidden !== true);
    if (rows.length === 0) continue;
    out.push(`## ${s.title}`, "", s.blurb, "", "| Verb | Does |", "| ---- | ---- |");
    for (const v of rows) out.push(`| \`${cell(v.verb)}\` | ${cell(v.blurb)} |`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}

const src = await Bun.file(DOC).text();
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end < start) {
  console.error(
    `markers not found in ${DOC} — expected ${START} … ${END}`,
  );
  process.exit(1);
}
const next =
  src.slice(0, start + START.length) + "\n" + generated() + "\n\n" + src.slice(end);
await Bun.write(DOC, next);
console.log(
  `regenerated ${VERBS.length} verbs: ` +
    SECTIONS.map(
      (s) => `${s.audience} ${VERBS.filter((v) => v.audience === s.audience).length}`,
    ).join(", "),
);
