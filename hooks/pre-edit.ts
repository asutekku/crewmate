/**
 * PreToolUse on Edit/Write: claim the file being edited, and warn if a live peer
 * has already claimed it.
 *
 * ADVISORY BY CHOICE. This never blocks. Returning a block here would strand an
 * agent mid-task on a file a peer merely *touched* an hour ago, and the repo's
 * real overlap rule is a review question ("is this someone else's work?") that a
 * path match cannot answer. Surfacing the overlap is what lets an agent apply
 * CLAUDE.md's commit rules — stage explicit paths, never `git add .` — knowingly
 * rather than by luck.
 */

import type { Claim } from "../core/store.ts";
import { agoText, claimName, withStore } from "../core/store.ts";
import { emit, readPayload } from "../core/shared.ts";
import { currentBranch, relPath, resolveProject, worktreeRoot } from "../core/repo.ts";
import { dirtyFiles } from "../core/dirty.ts";

/** One notice per peer, however many claim rows they hold on the path. */
function dedupeBySession(claims: readonly Claim[]): Claim[] {
  const seen = new Map<string, Claim>();
  for (const c of claims) if (!seen.has(c.sessionId)) seen.set(c.sessionId, c);
  return [...seen.values()];
}

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  const filePath = payload?.tool_input?.file_path;
  if (!sessionId || !cwd || !filePath) return;

  const project = resolveProject(cwd);
  const tree = worktreeRoot(cwd);
  // Relative to THIS session's worktree, so two checkouts of one repo name the
  // same file identically and their claims actually meet.
  const path = relPath(filePath, tree);

  // `relPath` returns the input unchanged when it lies outside the tree, so an
  // absolute path here means a file no peer can collide with — a scratchpad
  // note, a file in ~/.claude, a sibling project. Claiming those filled the
  // roster with unreadable temp paths (observed live 2026-07-31: a session's
  // claim list led with a 100-character scratchpad path) and pushed the real,
  // in-repo claims past the display cap.
  const outsideTree = /^(?:[A-Za-z]:\/|\/)/.test(path.replace(/\\/g, "/"));
  if (outsideTree) return;

  const warning = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);
    // The tree is re-read from the cwd of the EDIT, which is the most current
    // evidence available and the only one that has to be right for the advice
    // below to be right.
    //
    // SessionStart's cwd is where the session was LAUNCHED, and `CwdChanged`
    // only fires on an actual `cd`, so a session working in a worktree it did
    // not cd into is recorded in the main tree forever. Observed 2026-07-31: a
    // session editing files that exist ONLY in .claude/worktrees/… was listed on
    // master, which inverts the same-tree/cross-worktree classification and made
    // this hook report a cross-worktree overlap as an on-disk collision.
    // Only when it actually differs: `currentBranch` is a subprocess (~30 ms)
    // and this runs on every edit, so the common case — a session that has not
    // moved — must not pay for it.
    if (store.worktreeOf(sessionId) !== tree) store.setWorktree(sessionId, tree, currentBranch(cwd));
    // Re-registers a reaped session. Losing THIS hook is the worst case of all:
    // a session that records no claims raises no overlap warnings, which is the
    // blindness the tool exists to end.
    const handle = store.handleForOrRegister(sessionId, tree, currentBranch(cwd), now);
    if (!handle) return null;

    // Read peers' claims BEFORE recording our own, so this session's claim
    // cannot appear in its own conflict list.
    const claimed = store.conflictingClaims(sessionId, path, now);
    // The tool is recorded because a Write is a whole-file replacement and an
    // Edit is a hunk — reading "Write" against a file two agents share is worth
    // more alarm than reading "Edit".
    store.claim(sessionId, path, now, { tool: payload.tool_name ?? "", worktree: tree });
    if (claimed.length === 0) return null;

    // A COMMITTED FILE IS NOT A COLLISION. A claim is released by nothing but a
    // 2-hour timer, so an agent that edited a file, committed it and moved on
    // still holds it. Measured on the live roster: 38 of 42 claims were on files
    // with NO uncommitted changes — 90% of this channel pointing at conflicts
    // that a commit had already resolved, with peers replying "that's committed"
    // and the operator reading the exchange.
    //
    // This is why the check runs HERE and not on every edit: `git status` is
    // ~40 ms, and by this line a conflicting claim already exists, which is rare.
    // A null answer means git could not tell us — every warning stands, because
    // "no dirty files" and "we do not know" must not look the same.
    const others = claimed.filter((o) => {
      const dirty = dirtyFiles(o.worktree !== "" ? o.worktree : tree);
      return dirty === null || dirty.has(o.path);
    });
    if (others.length === 0) {
      // The claim is stale, not merely quiet: drop it so the next agent through
      // this file does not pay for the same git call to reach the same answer.
      for (const o of claimed) store.releaseClaim(o.sessionId, o.path);
      return null;
    }

    // Same tree means their edits are literally in these files right now; a
    // separate worktree is an independent checkout, so the risk is a merge later
    // rather than an overwrite now. The two need different advice, so they are
    // reported separately instead of averaged into one vague warning.
    const here = others.filter((o) => !o.worktree || o.worktree === tree);
    const away = others.filter((o) => o.worktree && o.worktree !== tree);

    // Announce the overlap to the log too, so the other agent learns about it on
    // its next turn rather than only at commit time.
    //
    // THE LOG LINE CARRIES THE SAME/OTHER-TREE DISTINCTION, which it used to
    // drop — the split above was computed for the injected warning and thrown
    // away here. That made a harmless cross-checkout overlap indistinguishable
    // from a real one: two agents editing waterTexture.ts, one on master and one
    // in a worktree, produced a line reading exactly like an on-disk collision,
    // and the reader could not tell which it was without querying the db.
    //
    // Session names, not handles: this text is read by an agent that may go on
    // to message the peer, and `cli.ts msg knuth` works only by luck.
    const label = (cs: typeof others, where: string): string =>
      cs.length > 0 ? `${cs.map((o) => claimName(o)).join(", ")}${where}` : "";
    const parts = [label(here, " in this tree"), label(away, " in another worktree")].filter(
      (p) => p !== "",
    );
    // Announced once per file per window, not once per edit. The WARNING below
    // still fires every time — this session needs it before each edit — but the
    // shared log does not need the same sentence ten times while an agent works
    // through a contested file.
    //
    // ADDRESSED TO THE PEERS IT CONCERNS, not broadcast. A broadcast reaches a
    // peer only at its next PROMPT: `Stop` delivers directed mail only, so a
    // session mid-autonomous-run would not learn that someone else is rewriting
    // the file it holds until its human next typed something. "Another agent is
    // editing the function you are in" is exactly the news worth ending a turn
    // for. One message per affected peer, so each is addressed rather than
    // relying on one of them noticing a shared line.
    if (!store.announcedOverlapRecently(handle, path, now)) {
      const body = `also editing ${path} (held by ${parts.join("; ")})`;
      for (const o of dedupeBySession(others)) {
        store.post(handle, "claim", body, now, { sessionId: o.sessionId, name: claimName(o) });
      }
    }
    const names = (cs: typeof others): string =>
      cs.map((o) => `${claimName(o)} (claimed ${agoText(o.tsMs, now)})`).join(", ");

    // Stated as consequences rather than orders: HOOKS.MD warns that imperative
    // injected text can read as an out-of-band command and trip Claude's
    // prompt-injection defenses. The facts carry the same weight.
    const lines = [`Another session is editing ${path}.`];
    if (here.length > 0) {
      lines.push(
        `- ${names(here)} — in THIS working tree. Their changes are uncommitted here, ` +
          `so \`git add .\` would stage their work and a revert or stash would discard ` +
          `it. CLAUDE.md's commit rules cover this case.`,
      );
    }
    if (away.length > 0) {
      // NOT "there is no collision, carry on". The absence of an on-disk clash
      // is the least interesting fact about this case: both sessions are editing
      // the same logical code, and two divergent rewrites of one function are
      // discovered at MERGE, when both are finished and expensive to unpick.
      // The earlier wording led with "no on-disk collision", which reads as
      // permission to ignore it.
      lines.push(
        `- ${names(away)} — in a separate worktree, so nothing is overwritten on ` +
          `disk. The two versions of ${path} still have to reconcile: changes to ` +
          `the same functions diverge silently until the merge, and behaviour ` +
          `changes here can invalidate the other session's measurements or tests ` +
          `even where the text does not conflict.`,
      );
    }
    // The channel is named at the point of use. An agent that has just been told
    // a peer is in the same code is exactly where "you can ask them" belongs —
    // stating it once at session start is too far from the moment it is needed.
    if (others.length > 0) {
      const first = claimName(others[0] as Claim);
      // LOOK BEFORE ASKING. This warning names ONE file — the one about to be
      // edited — and the question that follows is always "what else are they
      // in?". `files` answers it from the record without spending a peer's turn,
      // and it keeps answering after that peer's session has ended, which is
      // when a live claim would already have vanished. Asking is the fallback,
      // not the first move.
      lines.push(
        `Before asking, look: \`bun ~/.claude/agent-presence/bin/cli.ts files ${first}\` ` +
          `lists every file they have touched and what they say they are doing; ` +
          `\`cli.ts blame ${path}\` shows who has been in this one. If that leaves a ` +
          `real question, \`cli.ts msg ${first} "<text>"\` reaches them — what each of ` +
          `you is changing, and which parts are load-bearing, is knowledge the ` +
          `other cannot derive from the file.`,
      );
    }
    return lines.join("\n");
  });

  if (!warning) return;
  emit("PreToolUse", warning, "presence: file also claimed by another agent");
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A silent catch turns a programmer error into a
  // hook that exits 0 having done nothing, which is indistinguishable from
  // "nothing to report" and is exactly how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
  // Fail open: never block an edit because coordination state is unavailable.
}
