import { red } from "../core/colour.ts";
import { usageFor } from "../core/verbs.ts";
import type { CliContext } from "./types.ts";

export function failCommand(context: CliContext, message: string): void {
  context.error(`${red("✗")} ${message}`);
  context.fail();
}

/**
 * A verb's usage line, ASKED FOR or PROVOKED — one call site, two outcomes.
 *
 * `--help` and a bad argument print identical text and differ in everything
 * else: help goes to stdout and succeeds, an error goes to stderr and sets the
 * exit code. They share this function so `usageFor` is reached exactly once in
 * `cli/` — the rule `cli-architecture.test.ts` enforces, which exists so a
 * verb's arguments are stated in `core/verbs.ts` and nowhere else.
 */
function renderUsage(
  context: CliContext,
  command: string,
  opts: { readonly asError: boolean; readonly blurb?: string },
): void {
  const line = usageFor(command);
  if (opts.asError) {
    context.error(line);
    context.fail();
    return;
  }
  context.log(line);
  if (opts.blurb) context.log(`  ${opts.blurb}`);
}

export function failUsage(context: CliContext, command: string): void {
  renderUsage(context, command, { asError: true });
}

/** The usage line as an ANSWER: stdout, no failure, with the verb's blurb. */
export function showUsage(
  context: CliContext,
  command: string,
  blurb: string,
): void {
  renderUsage(context, command, { asError: false, blurb });
}
