import { listAgents } from "../core/agents.ts";
import { bold, cyan, dim, green, handleColour, red } from "../core/colour.ts";
import {
  baseBranch,
  baseDistance,
  currentBranch,
  worktreeRoot,
} from "../core/repo.ts";
import {
  agoText,
  claimName,
  displayName,
  rosterName,
  withStore,
} from "../core/store.ts";
import { validateAlias, validateRole } from "../core/topic.ts";
import { parseArguments, stringFlag } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { resolveLiveName, resolveSelf } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

export function createAdminCommands(context: CliContext): CommandMap {
  const rename = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { valueFlags: ["--agent"] });
    if (!parsed.ok) return failCommand(context, `call-me: ${parsed.error}`);
    const target = stringFlag(parsed.value, "--agent") ?? "";
    const check = validateAlias(parsed.value.positionals.join(" ").trim());
    if (!check.ok) {
      context.error(`${red("✗")} ${check.why}`);
      context.fail();
      return;
    }
    withStore(context.dbPath, (store) => {
      const now = context.now();
      const self = resolveSelf(context, store, target, now, "`call-me`");
      if (!self) return;
      const was = displayName(self);
      if (store.setAlias(self.sessionId, check.alias, now) === null) {
        context.error(
          `${red("✗")} another live agent already answers to ${bold(check.alias)}`,
        );
        context.fail();
        return;
      }
      context.log(
        `${green("✓")} ${dim(was)} ${dim("→")} ${bold(handleColour(check.alias)(check.alias))}`,
      );
      context.log(
        dim(
          `  Peers reach you at this name; \`msg ${check.alias} "…"\` works now.`,
        ),
      );
    });
  };
  const role = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { valueFlags: ["--agent"] });
    if (!parsed.ok) return failCommand(context, `call-you: ${parsed.error}`);
    const target = stringFlag(parsed.value, "--agent") ?? "";
    const check = validateRole(parsed.value.positionals.join(" ").trim());
    if (!check.ok) {
      context.error(`${red("✗")} ${check.why}`);
      context.fail();
      return;
    }
    withStore(context.dbPath, (store) => {
      const now = context.now();
      const self = resolveSelf(context, store, target, now, "`call-you`");
      if (!self) return;
      store.setRole(self.sessionId, check.role);
      const name = displayName(self);
      context.log(
        `${green("✓")} ${bold(handleColour(name)(rosterName({ ...self, role: check.role })))}`,
      );
      context.log(
        dim(
          `  Peers still reach them at \`${name}\` — the role is for you to read.`,
        ),
      );
    });
  };
  return {
    "call-me": rename,
    name: rename,
    "call-you": role,
    role,
    clear(args) {
      const parsed = parseArguments(args, { maxPositionals: 0 });
      if (!parsed.ok) return failCommand(context, `clear: ${parsed.error}`);
      withStore(context.dbPath, (store) => {
        const now = context.now();
        for (const session of store.liveSessions(now))
          store.unregister(session.sessionId, now);
      });
      context.log(
        "Cleared sessions and claims. " +
          dim("(Message log is kept; it self-prunes.)"),
      );
    },
    where(args) {
      const parsed = parseArguments(args, { maxPositionals: 0 });
      if (!parsed.ok) return failCommand(context, `where: ${parsed.error}`);
      const note = context.isGit
        ? ""
        : dim("  (no git repo — keyed on directory)");
      context.log(`${dim("project:")} ${bold(context.projectName)}`);
      context.log(`${dim("key:    ")} ${cyan(context.projectKey)}${note}`);
      context.log(`${dim("root:   ")} ${context.projectRoot}`);
      context.log(`${dim("db:     ")} ${context.dbPath}`);
      if (!context.isGit) return;
      const tree = worktreeRoot(context.cwd);
      const inWorktree = tree !== context.projectRoot;
      context.log(
        `${dim("tree:   ")} ${tree}${inWorktree ? "" : dim("  (main tree)")}`,
      );
      const branch = currentBranch(context.cwd);
      if (branch) context.log(`${dim("branch: ")} ${branch}`);
      const base = baseBranch(context.cwd);
      if (!inWorktree && branch === base) return;
      const distance = baseDistance(context.cwd, base);
      if (!base || distance === null) {
        context.log(`${dim("base:   ")} ${dim("unknown")}`);
        return;
      }
      context.log(
        `${dim("base:   ")} ${distance.behind === 0 ? `up to date with ${base}` : `${distance.behind} behind ${base}`}, ${distance.ahead > 0 ? `${distance.ahead} of its own` : "nothing of its own"}`,
      );
    },
    quit(args) {
      const parsed = parseArguments(args, { maxPositionals: 1 });
      if (!parsed.ok) return failCommand(context, `quit: ${parsed.error}`);
      const target = parsed.value.positionals[0];
      if (!target) {
        failUsage(context, "quit");
        return;
      }
      const agents = listAgents();
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const sessions = store.liveSessions(now);
        const resolved = resolveLiveName(sessions, target);
        if (!resolved.ok) {
          context.error(
            resolved.kind === "ambiguous"
              ? `ambiguous agent ${bold(target)}: ${resolved.candidates.join(", ")}`
              : `no agent named ${bold(target)} in ${context.projectName}`,
          );
          context.error(
            dim(
              `  active: ${sessions.map(displayName).join(", ") || "(none)"}`,
            ),
          );
          context.fail();
          return;
        }
        const match = resolved.value;
        const claims = store.allClaims(now);
        const mine = claims.filter((claim) => claim.handle === match.handle);
        const counts = new Map<string, number>();
        for (const claim of claims)
          counts.set(claim.path, (counts.get(claim.path) ?? 0) + 1);
        const contested = mine.filter(
          (claim) => (counts.get(claim.path) ?? 0) > 1,
        );
        const live = agents.find(
          (agent) => agent.sessionId === match.sessionId,
        );
        context.log(
          `${bold(displayName(match))} ${dim(`— ${agoText(match.lastSeenMs, now)}`)}`,
        );
        if (live)
          context.log(
            dim(
              `  process ${live.pid} is still running; this only clears the roster row`,
            ),
          );
        for (const claim of contested) {
          const others = claims
            .filter(
              (other) =>
                other.path === claim.path && other.handle !== match.handle,
            )
            .map(claimName);
          context.log(
            red(`  ⚠ holds ${claim.path}, also held by ${others.join(", ")}`),
          );
        }
        if (mine.length > 0)
          context.log(dim(`  releasing ${mine.length} claim(s)`));
        if (!store.departSession(match.sessionId, now)) {
          context.error(`${red("✗")} session disappeared before it could be removed`);
          context.fail();
          return;
        }
        context.log(green("  ✓ deregistered"));
      });
    },
  };
}
