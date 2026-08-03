import { bold, dim } from "../core/colour.ts";
import { displayName, type Store } from "../core/store.ts";
import { agentKey } from "../core/work.ts";
import type { CliContext } from "./types.ts";

export function resolveSelf(
  context: CliContext,
  store: Store,
  target: string,
  nowMs: number,
  verb: string,
): ReturnType<Store["findBySession"]> {
  const self =
    target !== ""
      ? store.findByName(target, nowMs)
      : context.sessionId !== ""
        ? store.findBySession(context.sessionId)
        : null;
  if (!self) {
    if (target !== "")
      context.error(`no agent named ${bold(target)} in ${context.projectName}`);
    else {
      context.error(`${verb} acts on the agent that runs it.`);
      context.error(dim("  From a plain terminal, pass `--agent <who>`."));
    }
    context.fail();
  }
  return self;
}

export function callerIdentity(
  context: CliContext,
  store: Store,
): { agentId: string; agentName: string } | null {
  if (context.sessionId === "") return null;
  const self = store.findBySession(context.sessionId);
  const title = self?.title ?? "";
  const name = self
    ? displayName(self)
    : (store.handleFor(context.sessionId) ?? "");
  return { agentId: agentKey(title, context.sessionId), agentName: name };
}

export function notAnAgent(context: CliContext, verb: string): void {
  context.error(`${verb} records work for the agent that runs it.`);
  context.error(
    dim(
      "  No CLAUDE_CODE_SESSION_ID here, so there is no agent to record it against.",
    ),
  );
  context.error(dim("  Read the board with `cli.ts board`."));
  context.fail();
}
