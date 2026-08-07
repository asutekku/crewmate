import { randomUUID } from "node:crypto";

import { featureForVerb, helpFeatures } from "../core/features.ts";
import { resolveProject } from "../core/repo.ts";
import { withStore } from "../core/store.ts";
import { terminalWidth } from "../core/layout.ts";
import { allVerbSpellings, findVerb, usage } from "../core/verbs.ts";
import { createAdminCommands } from "./admin.ts";
import { showUsage } from "./command.ts";
import { createDiagnosticCommands } from "./diagnostics.ts";
import { createDiaryCommands } from "./diary.ts";
import { createInitCommands } from "./init.ts";
import { createInjectionCommands } from "./injection.ts";
import { createMessagingCommands } from "./messaging.ts";
import { createObligationCommands } from "./obligations.ts";
import { createPersonalCommands } from "./personal.ts";
import { createQuestionCommands } from "./questions.ts";
import { CommandRegistry } from "./registry.ts";
import { createRosterCommands } from "./roster.ts";
import { createSessionCommands } from "./sessions.ts";
import type { CliContext, CommandFactory } from "./types.ts";
import { createWorkCommands } from "./work.ts";

const COMMAND_FAMILIES: readonly CommandFactory[] = [
  createObligationCommands,
  createWorkCommands,
  createQuestionCommands,
  createDiaryCommands,
  createPersonalCommands,
  createMessagingCommands,
  createRosterCommands,
  createSessionCommands,
  createAdminCommands,
  createDiagnosticCommands,
  createInjectionCommands,
  createInitCommands,
];

export interface CliRunOptions {
  readonly cwd: string;
  readonly binRoot: string;
  readonly sessionId?: string;
  readonly log?: (message: string) => void;
  readonly error?: (message: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly now?: () => number;
}

export function buildCommandRegistry(context: CliContext): CommandRegistry {
  const registry = new CommandRegistry();
  for (const createCommands of COMMAND_FAMILIES)
    registry.add(createCommands(context));
  return registry;
}

export function commandNames(context: CliContext): string[] {
  buildCommandRegistry(context);
  return [...allVerbSpellings()];
}

export function runCli(argv: readonly string[], options: CliRunOptions): void {
  const project = resolveProject(options.cwd);
  let failed = false;
  const context: CliContext = {
    dbPath: project.dbPath,
    projectName: project.name,
    projectRoot: project.root,
    projectKey: project.key,
    isGit: project.isGit,
    cwd: options.cwd,
    binRoot: options.binRoot,
    sessionId: options.sessionId ?? "",
    now: options.now ?? Date.now,
    log: options.log ?? console.log,
    error: options.error ?? console.error,
    fail: () => {
      failed = true;
      (
        options.setExitCode ??
        ((code) => {
          process.exitCode = code;
        })
      )(1);
    },
  };

  const registry = buildCommandRegistry(context);

  const [rawCommand, ...rawArgs] = argv;
  const command = rawCommand ?? "who";
  const args = [...rawArgs];

  const metadata = findVerb(command);
  if (metadata?.verb === "help") {
    if (context.sessionId) {
      withStore(context.dbPath, (store) => {
        const now = context.now();
        for (const feature of helpFeatures()) {
          store.recordFeatureEvent({
            sessionId: context.sessionId,
            feature,
            stage: "exposure",
            surface: "help",
            opportunityId: context.sessionId,
            sourceKey: "cli-help",
            nowMs: now,
          });
        }
      });
    }
    context.log(usage(terminalWidth()));
    return;
  }

  const registered = registry.command(command);
  if (!registered) {
    context.error(`unknown command: ${command}\n`);
    context.error(usage(terminalWidth()));
    context.fail();
    return;
  }

  // `--help` ON EVERY VERB, ANSWERED BEFORE THE HANDLER RUNS.
  //
  // This is a SAFETY property, not a convenience one. Unknown flags do abort
  // (`parseArguments` fails and the handler returns), so probing was harmless
  // in fact -- but that was invisible at the prompt, and the safest probe of a
  // destructive verb was indistinguishable from a trigger until after it had
  // been typed. Measured 2026-08-05: `crew clear --help` could not be shown
  // safe without reading `cli/admin.ts`, which an operator at a terminal has
  // no way to do.
  //
  // Intercepted HERE rather than in each handler for the same reason the verb
  // table exists: 51 handlers that each have to remember are 51 chances to
  // forget, and the ones most worth probing are the ones least likely to be
  // updated.
  if (args.includes("--help") || args.includes("-h")) {
    showUsage(context, registered.spelling, registered.metadata.blurb);
    return;
  }

  registered.handler(args);

  if (!failed && context.sessionId && registered.metadata.trackUse !== false) {
    const feature = featureForVerb(command);
    if (feature) {
      withStore(context.dbPath, (store) => {
        const now = context.now();
        store.recordFeatureEvent({
          sessionId: context.sessionId,
          feature,
          stage: "use",
          surface: "cli",
          opportunityId: context.sessionId,
          sourceKey: `${command}:${randomUUID()}`,
          nowMs: now,
        });
      });
    }
  }
}
