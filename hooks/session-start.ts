/**
 * SessionStart: register this session, then tell it who else is already working
 * in the repo and what they most recently said.
 *
 * Recent log lines are shown here as a one-off orientation summary and are NOT
 * treated as unread mail — `register` parks the cursor at the current max id so
 * the first turn does not also replay them.
 */

import { displayName, withStore } from "../core/store.ts";
import { baseStalenessLines, emit, readPayload } from "../core/shared.ts";
import {
  baseBranch,
  baseDistance,
  currentBranch,
  installedVersion,
  installManifest,
  resolveProject,
  worktreeRoot,
} from "../core/repo.ts";
import { listAgents } from "../core/agents.ts";
import { nameCase } from "../core/names.ts";
import { isContinuation, pack, renderBlock } from "../core/injection.ts";
import { loadConfig } from "../core/config.ts";
import { sessionEnvelope } from "../core/sessionBlock.ts";

// Re-exported because the identity wording is the tested part and its tests
// have always addressed this module. The text itself now lives with the block
// it heads, in core/sessionBlock.ts.
export { identityLines } from "../core/sessionBlock.ts";

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const project = resolveProject(cwd);
  const tree = worktreeRoot(cwd);

  // Two git calls, ~123 ms measured, and only in a linked worktree — `root` is
  // the MAIN working tree, so this comparison is the "am I in a worktree" test
  // without asking git a third time. Skipped in the main tree, where the answer
  // is always zero and the line would be noise on every session in the repo.
  const inWorktree = project.isGit && tree !== project.root;
  const base = inWorktree ? baseBranch(cwd) : "";
  const distance = inWorktree ? baseDistance(cwd, base) : null;

  // ~950 ms, so it belongs here and nowhere on a per-prompt path. Session start
  // is rare and already slow, and this is the moment the roster is read.
  const agents = listAgents();

  const report = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.pruneStale(now);
    const handle = store.registerAndRestore(sessionId, tree, currentBranch(cwd), now);
    // Recorded once, here, because this is the moment the scripts were loaded —
    // stamping it later would report the version installed by then, not the one
    // actually running.
    const build=installManifest();
    store.setCodeVersion(sessionId, installedVersion(),build?.featureSet??[],now,build?.featureSetVersion??0);
    // Cached for the roster, which cannot afford a git call per peer. -1 when
    // unmeasured or in the main tree — distinct from 0, which claims in-sync.
    store.setBaseDistance(sessionId, distance?.behind ?? -1, base);
    // Registered first, so this session's own name is filled in too.
    if (agents.length > 0) store.syncAgents(agents);

    const self = store.liveSessions(now).find((s) => s.sessionId === sessionId);
    const me = self ? displayName(self) : handle;

    // SUPPRESSION IS ONLY REAL IF IT IS PERSISTED. `pack` defaults `seen` to an
    // empty map, so a caller that omits it silently gets no suppression while
    // every unit test still passes.
    //
    // BUT EXPOSURE ONLY MEANS SOMETHING WHILE THE CONTEXT HOLDS IT. This event
    // re-fires on `clear`, `compact` and `fork` with the same session id and a
    // context that has been wiped — measured, 19 identity injections after one
    // compact boundary in this tool's own transcript. Suppressing an unchanged
    // roster there would leave a block of nothing but the header, so only a
    // `resume` carries its exposures forward.
    const continuing = isContinuation(payload?.source);
    const packed = pack(
      sessionEnvelope(store, {
        me,
        projectName: project.name,
        sessionId,
        tree,
        now,
        staleness: baseStalenessLines(distance, base, inWorktree),
        lineageFrom: self?.lineageFrom ?? "",
      }),
      continuing ? store.injectionExposures(sessionId) : new Map(),
    );
    // The real peer count, not the selected-candidate count: the user's status
    // line answers "who else is in the tree", which is true whether or not the
    // roster line survived the budget.
    const peerCount = store.liveSessions(now).filter((s) => s.sessionId !== sessionId).length;
    return { text: renderBlock(packed.lines), name: me, peerCount, packed, continuing, now };
  });

  emit(
    "SessionStart",
    report.text,
    // The USER's copy of the same claim, and phrased the same way. They are
    // looking at several windows and need to know which agent this one is;
    // quoting the name here while asserting it in the context would show them
    // a label where the agent was told a name.
    `presence: you are ${nameCase(report.name)} — ${report.peerCount} peer(s) active`,
  );

  // RECORDED AFTER EMITTING, DELIBERATELY. `emit` is a `console.log`, and a
  // closed pipe throws — so writing the delivery first would leave the store
  // claiming a session had been shown a block that never left the process, and
  // the next start would suppress it. At-least-once is the safe direction here:
  // a repeated roster is noise, a silently withheld one is the failure this
  // whole feature exists to prevent.
  //
  // One transaction, because exposures without their omissions is the worst of
  // both: content marked delivered whose inbox is empty.
  withStore(project.dbPath, (store) => {
    store.recordInjectionResult(sessionId, {
      // The FORM and RANK go in too, not just the version: reconstructing what
      // an agent was shown means knowing whether it got the full roster or the
      // one-line compact of it, and where that sat against everything else.
      shown: report.packed.selected.map((s) => ({
        key: s.candidate.key,
        dedupeKey: s.candidate.dedupeKey,
        stateVersion: s.candidate.stateVersion,
        form: s.form,
        priority: s.candidate.priority,
        chars: s.text.length,
        actionable: s.candidate.actionable,
      })),
      // EVERY OMISSION, whatever the reason. The inbox wants only the
      // actionable ones dropped for space — but the LEDGER wants all of them,
      // and passing one pre-filtered list served the inbox's need and silently
      // imposed it on the history: `duplicate`, `unchanged` and non-actionable
      // drops never reached the record at all. "Why was this agent never told?"
      // is most often answered by `unchanged`, which was the outcome least
      // likely to be there. The store decides which subset is owed.
      omitted: report.packed.omitted.map((o) => ({
        key: o.candidate.key,
        dedupeKey: o.candidate.dedupeKey,
        // WHICH VERSION was withheld. Without it an inbox entry for a key
        // whose content has since moved cannot say which one was missed.
        stateVersion: o.candidate.stateVersion,
        text: o.candidate.text,
        reason: o.reason,
        priority: o.candidate.priority,
        actionable: o.candidate.actionable,
      })),
      nowMs: report.now,
      // A fresh context generation: forget what the previous one was shown.
      clearFirst: !report.continuing,
    });
    store.pruneInjectionState(report.now, loadConfig().injectionKeepMs);
  });
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A silent catch turns a programmer error into a
  // hook that exits 0 having done nothing, which is indistinguishable from
  // "nothing to report" and is exactly how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
  // Fail open: coordination is a convenience, never a reason to break a session.
}
