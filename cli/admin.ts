import { copyFileSync, existsSync, statSync } from "node:fs";
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
import { booleanFlag, parseArguments, stringFlag } from "./args.ts";
import { failCommand, failUsage } from "./command.ts";
import { attempt } from "./result.ts";
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
  /**
   * Gives up a name while still alive, so a successor can take it.
   *
   * The outgoing agent runs this; the successor runs `call-me`. Two commands in
   * two sessions, with no third party and no race -- see plans/RELEASE_PLAN.md
   * for the trick this replaces.
   */
  const release = (args: readonly string[]): void => {
    const parsed = parseArguments(args, { valueFlags: ["--agent"] });
    if (!parsed.ok) return failCommand(context, `release: ${parsed.error}`);
    const target = stringFlag(parsed.value, "--agent") ?? "";
    withStore(context.dbPath, (store) => {
      const now = context.now();
      const self = resolveSelf(context, store, target, now, "`release`");
      if (!self) return;
      const was = displayName(self);
      const fresh = store.releaseName(self.sessionId, now);
      if (fresh === null) {
        context.error(`${red("✗")} no session to release a name from`);
        context.fail();
        return;
      }
      context.log(
        `${green("✓")} ${bold(was)} released ${dim("—")} you are now ` +
          `${bold(handleColour(fresh)(fresh))}`,
      );
      context.log(dim(`  A successor may take it with \`crew call-me ${was}\`.`));
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
    release,
    name: rename,
    "call-you": role,
    role,
    clear(args) {
      const parsed = parseArguments(args, {
        booleanFlags: ["--force"],
        maxPositionals: 0,
      });
      if (!parsed.ok) return failCommand(context, `clear: ${parsed.error}`);
      const force = booleanFlag(parsed.value, "--force");
      const now = context.now();
      // NAMES WHAT WOULD GO BEFORE IT GOES. Deregistering is reversible — each
      // hook re-registers — but the CLAIMS are not, and a path two agents both
      // hold loses its collision warning the moment one row disappears. The
      // dry run costs one read and turns an irreversible surprise into a
      // decision.
      const live = withStore(context.dbPath, (store) => {
        const claims = store.allClaims(now);
        return store.liveSessions(now).map((session) => ({
          name: displayName(session),
          sessionId: session.sessionId,
          claims: claims.filter((claim) => claim.handle === session.handle).length,
        }));
      });
      if (!force) {
        if (live.length === 0) {
          context.log(dim("nothing to clear — no live sessions."));
          return;
        }
        context.log(
          `${live.length} live session(s) would be dropped from the roster:`,
        );
        for (const session of live)
          context.log(
            `  ${bold(session.name)} ${dim(`— ${session.claims} claim(s)`)}`,
          );
        context.log(
          dim("The message log is kept. Re-run with `--force` to go ahead."),
        );
        return;
      }
      withStore(context.dbPath, (store) => {
        for (const session of live) store.unregister(session.sessionId, now);
      });
      context.log(
        `Cleared ${live.length} session(s) and their claims. ` +
          dim("(Message log is kept; it self-prunes at 2000 rows.)"),
      );
    },
    /**
     * Copies the store somewhere safe.
     *
     * THE PAIR FOR EVERY DESTRUCTIVE VERB. `clear`, `quit`, `forget` and
     * `done --abandoned` all remove state, and there was no backup path at all
     * — the mitigation was "copy the file `crew where` prints", which is
     * correct, undocumented, and not something anyone does under pressure.
     */
    export(args) {
      const parsed = parseArguments(args, { maxPositionals: 1 });
      if (!parsed.ok) return failCommand(context, `export: ${parsed.error}`);
      const now = context.now();
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      const target =
        parsed.value.positionals[0] ?? `${context.projectName}-${stamp}.db`;
      const result = attempt(() => {
        // The db and its write-ahead log are one unit: copying the db alone
        // can miss committed rows that have not been checkpointed.
        copyFileSync(context.dbPath, target);
        for (const suffix of ["-wal", "-shm"])
          if (existsSync(`${context.dbPath}${suffix}`))
            copyFileSync(`${context.dbPath}${suffix}`, `${target}${suffix}`);
        return statSync(target).size;
      });
      if (!result.ok) return failCommand(context, `export: ${result.error}`);
      context.log(
        `${green("✓")} ${bold(target)} ${dim(`— ${(result.value / 1024).toFixed(1)} KB`)}`,
      );
      context.log(dim(`  from ${context.dbPath}`));
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
      const parsed = parseArguments(args, {
        booleanFlags: ["--force"],
        maxPositionals: 1,
      });
      if (!parsed.ok) return failCommand(context, `quit: ${parsed.error}`);
      const force = booleanFlag(parsed.value, "--force");
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
        // A RUNNING PROCESS NEEDS INTENT. `docs/views.md` explains at length
        // why liveness cannot be DETECTED from a heartbeat -- but Claude Code's
        // own process list can say "this pid is alive", and dropping a peer
        // that is mid-task on a bare `quit` is what the "drop a dead session"
        // blurb wrongly promised was impossible. The check is not a guess: it
        // is the same `listAgents()` the roster already trusts.
        if (live && !force) {
          context.error(
            dim(`  ${displayName(match)} is running (pid ${live.pid}) — ` +
              "`--force` to deregister anyway"),
          );
          context.fail();
          return;
        }
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
