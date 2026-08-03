import { bold, dim } from "../core/colour.ts";
import { displayName, type Session, type Store } from "../core/store.ts";
import { agentKey } from "../core/work.ts";
import type { CliContext } from "./types.ts";

export type LiveNameResolution =
  | { readonly ok: true; readonly value: Session }
  | {
      readonly ok: false;
      readonly kind: "not_found" | "ambiguous";
      readonly query: string;
      readonly candidates: readonly string[];
    };

/** Exact visible names win; prefixes are accepted only when uniquely identifying. */
export function resolveLiveName(
  live: readonly Session[],
  query: string,
): LiveNameResolution {
  const wanted = query.trim().toLowerCase();
  const exactAlias = live.filter(
    (session) => session.alias.toLowerCase() === wanted,
  );
  const exact =
    exactAlias.length > 0
      ? exactAlias
      : live.filter(
          (session) =>
            session.name.toLowerCase() === wanted ||
            session.handle.toLowerCase() === wanted,
        );
  const matches =
    exact.length > 0
      ? exact
      : live.filter((session) =>
          [session.alias, session.name, session.handle].some((name) =>
            name.toLowerCase().startsWith(wanted),
          ),
        );
  if (matches.length === 1) return { ok: true, value: matches[0]! };
  return {
    ok: false,
    kind: matches.length === 0 ? "not_found" : "ambiguous",
    query,
    candidates: matches.map(displayName).sort((a, b) => a.localeCompare(b)),
  };
}

export function resolveSelf(
  context: CliContext,
  store: Store,
  target: string,
  nowMs: number,
  verb: string,
): ReturnType<Store["findBySession"]> {
  const named = target !== "" ? resolveLiveName(store.liveSessions(nowMs), target) : undefined;
  const self = named?.ok
    ? named.value
    : target === "" && context.sessionId !== ""
      ? store.findBySession(context.sessionId)
      : null;
  if (!self) {
    if (target !== "") {
      context.error(
        named && !named.ok && named.kind === "ambiguous"
          ? `ambiguous agent ${bold(target)}: ${named.candidates.join(", ")}`
          : `no agent named ${bold(target)} in ${context.projectName}`,
      );
    }
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
