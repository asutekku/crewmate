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
import { takeFlag } from "./args.ts";
import { failUsage } from "./command.ts";
import { resolveSelf } from "./identity.ts";
import type { CliContext, CommandMap } from "./types.ts";

export function createAdminCommands(context: CliContext): CommandMap {
  const rename = (args: string[]): void => {
    const target = takeFlag(args, "--agent");
    const check = validateAlias(args.join(" ").trim());
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
  const role = (args: string[]): void => {
    const target = takeFlag(args, "--agent");
    const check = validateRole(args.join(" ").trim());
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
    clear() {
      withStore(context.dbPath, (store) => {
        const now = context.now();
        for (const session of store.liveSessions(now))
          store.unregister(session.sessionId);
      });
      context.log(
        "Cleared sessions and claims. " +
          dim("(Message log is kept; it self-prunes.)"),
      );
    },
    where() {
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
      const target = args[0];
      if (!target) {
        failUsage(context, "quit");
        return;
      }
      const agents = listAgents();
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const sessions = store.liveSessions(now);
        const match = sessions.find(
          (session) =>
            displayName(session).toLowerCase() === target.toLowerCase() ||
            session.handle === target,
        );
        if (!match) {
          context.error(
            `no agent named ${bold(target)} in ${context.projectName}`,
          );
          context.error(
            dim(
              `  active: ${sessions.map(displayName).join(", ") || "(none)"}`,
            ),
          );
          context.fail();
          return;
        }
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
        store.post(match.handle, "done", "left the roster", now);
        store.unregister(match.sessionId);
        context.log(green("  ✓ deregistered"));
      });
    },
  };
}
