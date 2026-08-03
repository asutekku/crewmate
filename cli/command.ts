import { red } from "../core/colour.ts";
import { usageFor } from "../core/verbs.ts";
import type { CliContext } from "./types.ts";

export function failCommand(context: CliContext, message: string): void {
  context.error(`${red("✗")} ${message}`);
  context.fail();
}

export function failUsage(context: CliContext, command: string): void {
  context.error(usageFor(command));
  context.fail();
}
