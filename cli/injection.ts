import { briefAgo } from "../core/board.ts";
import { bold, dim, green, red, yellow } from "../core/colour.ts";
import { pack } from "../core/injection.ts";
import { baseBranch, baseDistance, worktreeRoot } from "../core/repo.ts";
import { sessionEnvelope } from "../core/sessionBlock.ts";
import { baseStalenessLines } from "../core/shared.ts";
import {
  displayName,
  withStore,
  type Session,
  type Store,
} from "../core/store.ts";
import type { CliContext, CommandMap } from "./types.ts";
import {
  parseArguments,
  parseSubjectSelector,
  type SubjectSelector,
} from "./args.ts";
import { failCommand } from "./command.ts";
import { resolveLiveName } from "./identity.ts";
import { TerminalReport } from "./terminal.ts";

function subject(
  context: CliContext,
  store: Store,
  selector: SubjectSelector,
  now: number,
): Session | null {
  const live = store.liveSessions(now);
  const wanted = selector.session ?? "";
  if (wanted) {
    const hit = live.find((session) => session.sessionId === wanted);
    if (hit) return hit;
    context.error(red(`no live session with id ${wanted}`));
    context.fail();
    return null;
  }
  const named = selector.agent ?? "";
  if (named) {
    const hit = resolveLiveName(live, named);
    if (hit.ok) return hit.value;
    context.error(
      red(
        hit.kind === "ambiguous"
          ? `ambiguous live session ${named}: ${hit.candidates.join(", ")}`
          : `no live session named ${named}`,
      ),
    );
    context.fail();
    return null;
  }
  if (context.sessionId) {
    const hit = live.find((session) => session.sessionId === context.sessionId);
    if (hit) return hit;
    context.error(
      red("this session is not on the roster") + dim(" — pass --agent <name>"),
    );
    context.fail();
    return null;
  }
  if (live.length === 1) return live[0] ?? null;
  context.error(
    red("cannot tell which session to report on") +
      dim(` — pass --agent <name> or --session <id> (${live.length} live)`),
  );
  context.fail();
  return null;
}

function clip(text: string, max = 52): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function createInjectionCommands(context: CliContext): CommandMap {
  const parseSelector = (command: string, args: readonly string[]): SubjectSelector | undefined => {
    const parsed = parseArguments(args, {
      valueFlags: ["--agent", "--session"],
      maxPositionals: 0,
    });
    if (!parsed.ok) {
      failCommand(context, `${command}: ${parsed.error}`);
      return undefined;
    }
    const selector = parseSubjectSelector(parsed.value);
    if (!selector.ok) {
      failCommand(context, `${command}: ${selector.error}`);
      return undefined;
    }
    return selector.value;
  };
  return {
    inbox(args) {
      const selector = parseSelector("inbox", args);
      if (!selector) return;
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const recipient = subject(context, store, selector, now);
        if (!recipient) return;
        const owed = store.injectionOmissions(recipient.sessionId);
        if (owed.length === 0) {
          context.log(
            dim("nothing was omitted from your session-start context"),
          );
          return;
        }
        context.log(bold(`${owed.length} item(s) omitted for length:\n`));
        for (const omission of owed) {
          context.log(`${bold(omission.key)} ${dim(`(${omission.reason})`)}`);
          context.log(`${omission.text}\n`);
        }
      });
    },
    injection(args) {
      const selector = parseSelector("injection", args);
      if (!selector) return;
      withStore(context.dbPath, (store) => {
        const now = context.now();
        const recipient = subject(context, store, selector, now);
        if (!recipient) return;
        const sessionId = recipient.sessionId;
        const name = displayName(recipient);
        const cwd = recipient.worktree || context.cwd.replace(/\\/g, "/");
        const tree = worktreeRoot(cwd);
        const inWorktree = context.isGit && tree !== context.projectRoot;
        const base = inWorktree ? baseBranch(cwd) : "";
        const distance = inWorktree ? baseDistance(cwd, base) : null;
        const envelope = sessionEnvelope(store, {
          me: name,
          projectName: context.projectName,
          sessionId,
          tree,
          now,
          staleness: baseStalenessLines(distance, base, inWorktree),
          lineageFrom: recipient.lineageFrom,
        });
        const packed = pack(envelope, store.injectionExposures(sessionId));
        context.log(
          `${dim("recipient")} ${name} ${dim(sessionId.slice(0, 8))}`,
        );
        context.log("");
        context.log(bold("mandatory"));
        for (const line of envelope.mandatoryHeader.filter(Boolean))
          context.log(
            `  ${green("✓")} ${dim(clip(line))} ${dim(`${line.length}`)}`,
          );
        const framed = packed.selected.some(
          (selected) => selected.candidate.requiresPeerFraming,
        );
        for (const line of envelope.peerFraming)
          context.log(
            `  ${framed ? green("✓") : dim("–")} ${dim(clip(line))} ${dim(`${line.length}`)}${framed ? "" : dim(" (no peer text selected)")}`,
          );
        context.log("");
        context.log(bold("selected"));
        if (packed.selected.length === 0) context.log(dim("  nothing"));
        for (const selected of packed.selected)
          context.log(
            `  ${green("✓")} ${selected.candidate.key.padEnd(18)} ${dim(`p${selected.candidate.priority}`)} ${dim(`${selected.text.length}`)}${selected.form === "compact" ? yellow(" compact") : ""}`,
          );
        context.log("");
        context.log(bold("omitted"));
        if (packed.omitted.length === 0) context.log(dim("  nothing"));
        for (const omitted of packed.omitted)
          context.log(
            `  ${dim("–")} ${omitted.candidate.key.padEnd(18)} ${dim(`p${omitted.candidate.priority}`)} ${red(omitted.reason)}`,
          );
        const history = store.injectionHistory(sessionId, 40);
        if (history.length > 0) {
          const delivery = history[0]?.deliveryId ?? 0;
          const latest = history.filter(
            (entry) => entry.deliveryId === delivery,
          );
          context.log("");
          context.log(
            bold(
              `last delivered ${dim(briefAgo(latest[0]?.tsMs ?? now, now))}`,
            ),
          );
          for (const entry of latest)
            context.log(
              `  ${entry.outcome === "selected" ? green("✓") : dim("–")} ${entry.key.padEnd(18)} ${dim(`p${entry.priority}`)}${entry.outcome === "selected" ? `${entry.form === "compact" ? yellow(" compact") : ""} ${dim(`${entry.chars}`)}` : ` ${red(entry.reason)}`}`,
            );
          const deliveries = new Set(history.map((entry) => entry.deliveryId))
            .size;
          if (deliveries > 1)
            context.log(dim(`  (${deliveries} deliveries in history)`));
        }
        const budget = new TerminalReport()
          .blank()
          .line(bold("budget"))
          .field("target", envelope.targetChars)
          .field("rendered", packed.renderedChars)
          .field("reserved", `${packed.reservedChars} (header + framing)`);
        if (packed.mandatoryOverflow)
          budget.line(
            `  ${red("mandatory overflow")} — the header alone exceeds the target and renders anyway`,
          );
        budget.emit(context.log);
      });
    },
  };
}
