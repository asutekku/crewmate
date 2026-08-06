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
import { agoText, claimName, displayName, withStore } from "../core/store.ts";
import { discipleName } from "../core/names.ts";
import { withPersonal } from "../core/personal.ts";
import { emit, readPayload } from "../core/shared.ts";
import { currentBranch, relPath, resolveProject, worktreeRoot } from "../core/repo.ts";
import { dirtyFiles } from "../core/dirty.ts";
import { LOUD_KINDS } from "../core/diary.ts";
import { agentKey, normalisePlanPath } from "../core/work.ts";
import { fit } from "../core/layout.ts";

/**
 * How recent a claim must be to count as "they are mid-edit, leave it alone".
 *
 * A claim is written before the Edit tool touches disk, so a peer's file is
 * briefly claimed and still clean. Deleting that row drops the warning for the
 * very edit that needed it.
 */
const MID_EDIT_GRACE_MS = 10_000;

/** One notice per peer, however many claim rows they hold on the path. */
function dedupeBySession(claims: readonly Claim[]): Claim[] {
  const seen = new Map<string, Claim>();
  for (const c of claims) if (!seen.has(c.sessionId)) seen.set(c.sessionId, c);
  return [...seen.values()];
}

/** At most this many loud entries are quoted in full before the pointer wins. */
const LOUD_SHOWN = 2;

/** `withStore`'s callback argument, so a helper can take one. */
type StoreHandle = Parameters<Parameters<typeof withStore>[1]>[0];

/**
 * Does this path look like a plan document?
 *
 * NAME AND PLACE BOTH, deliberately narrow. A looser rule (any `.md` under
 * `docs/`) fires on every system note and becomes a line agents scroll past.
 */
export function looksLikePlan(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (!/\.md$/i.test(p)) return false;
  // A DEDICATED PLANS FOLDER IS ENOUGH ON ITS OWN. The folder has made the
  // claim, so asking the filename to repeat it rejects `plans/junction.md`.
  if (/(?:^|\/)(?:docs\/plans|plans)\//i.test(p)) return true;
  // Elsewhere the NAME has to carry it. `audit_reports/` holds findings and
  // audits as well as plans, so a bare `.md` there is usually neither.
  if (!/(?:^|\/)audit_reports\//i.test(p)) return false;
  return /(?:^|\/)[^/]*(?:PLAN|ROADMAP|EFFORT)[^/]*\.md$/i.test(p);
}

/**
 * Offers to link the open work item to the plan being edited.
 *
 * Speaks only when the path looks like a plan, the agent has an open item, and
 * that item names no plan yet. It repeats while all three hold, because the
 * condition is "is the item still unlinked", not "have we said this".
 */
export function planLinkLine(store: StoreHandle, sessionId: string, path: string): string[] {
  if (!looksLikePlan(path)) return [];
  const item = store.work.target(agentKey("", sessionId));
  if (!item || item.planDoc !== "") return [];
  const plan = normalisePlanPath(path);
  if (plan === "") return [];
  // THE COMMAND GETS ITS OWN LINE. It is the part meant to be copied, so it
  // must not wrap — and a subject plus a path inline runs past 150 characters.
  return [
    `You are editing a plan and your open item does not name one.`,
    `  \`crew link ${plan}\``,
    `  links it to "${fit(item.subject, 44)}", so \`crew plans\` can report what`,
    `  actually shipped against this plan rather than what it claims.`,
  ];
}

/**
 * Which lineages have anything worth inheriting, lowercased.
 *
 * Opened separately from the project store because the personal db is the one
 * store that is NOT per-repo. Called once and passed in, not per author.
 */
export function lineagesHeld(): Set<string> {
  return withPersonal(
    (personal) => new Set(personal.lineages().map((l) => l.lineage.toLowerCase())),
  );
}

/**
 * "Someone already knows this ground, and they are gone" — offered at the
 * moment the file is touched.
 *
 * Silent unless the author is gone, holds memories, and this session has no
 * lineage. See docs/design-notes.md, "Offering a lineage".
 */
export function lineageLines(
  store: StoreHandle,
  sessionId: string,
  path: string,
  held: ReadonlySet<string>,
): string[] {
  const self = store.findBySession(sessionId);
  if (!self || self.lineageFrom !== "") return [];
  const me = displayName(self).toLowerCase();

  const now = Date.now();
  const authors = new Set<string>();
  for (const e of store.diary.forPath(path, { limit: 40 })) {
    const who = e.agent.trim().toLowerCase();
    // Not me, has memories to pass on, and gone — `liveHolder` covers both a
    // live session under that name and one that already took the lineage up.
    if (who === "" || who === me || !held.has(who)) continue;
    if (store.liveHolder(who, now) !== null) continue;
    authors.add(who);
  }
  if (authors.size === 0) return [];

  // ONE line, naming ONE lineage. Two would be a menu, and a menu at edit time
  // is the thing that gets scrolled past — taking the diary findings above it
  // along with it.
  const [first] = [...authors];
  return [
    `- ${first} worked this ground and is gone. \`crew inherit ${first}\` takes up what` +
      ` it learned, as ${discipleName(displayName(self), first ?? "")}.`,
  ];
}

/**
 * What the diary knows about the folder this edit lands in.
 *
 * A POINTER, NOT A DUMP: bodies cost hundreds of tokens on every edit. Only
 * `warning` and `error` titles are quoted, because those are the ones written
 * down so the next agent does not repeat them.
 */
export function diaryLines(store: StoreHandle, path: string): string[] {
  const total = store.diary.countForPath(path);
  if (total === 0) return [];

  const loud = store.diary.forPath(path, { limit: LOUD_SHOWN, kinds: LOUD_KINDS });
  const lines: string[] = [];
  for (const e of loud) {
    const where = e.scope !== "" ? ` [${e.scope}]` : "";
    // AN UNFIXED ERROR SAYS SO. Without the marker an error reads the same
    // whether it was fixed last week or never, which decides whether you act.
    const open = e.kind === "error" && e.fixedMs === 0 ? " STILL OPEN" : "";
    // TITLES only — the body is what `crew note <id>` is for. A title states
    // the claim, which is enough to decide whether the body is worth opening.
    lines.push(`- ${e.kind}${open}${where}: ${e.title} (${e.agent}, \`crew note ${e.id}\`)`);
  }

  // THE POINTER MUST NAME A COMMAND THAT RETURNS WHAT IT PROMISES. The two
  // counts are not one set: `countForPath` includes repo-wide entries and
  // `recall --scope` excludes them, so the remainder splits by reachability.
  const shownIds = new Set(loud.map((e) => e.id));
  const covering = store.diary
    .forPath(path, { limit: 200 })
    .filter((e) => !shownIds.has(e.id));
  const scoped = covering.filter((e) => e.scope !== "").length;
  const repoWide = covering.filter((e) => e.scope === "").length;

  if (scoped > 0) {
    // THE PATH, not its directory. `--scope` covers every enclosing folder the
    // way this lookup does, so handing it the file makes the advice true.
    lines.push(
      `- ${scoped} more diary ${scoped === 1 ? "entry covers" : "entries cover"} this folder — ` +
        `\`crew recall --scope ${path}\``,
    );
  }
  if (repoWide > 0) {
    // Named as what they are. Calling a repo-wide note an entry "about this
    // folder" is how a reader learns to distrust the count.
    lines.push(
      `- ${repoWide} repo-wide diary ${repoWide === 1 ? "entry applies" : "entries apply"} ` +
        `everywhere — \`crew recall --limit ${repoWide}\``,
    );
  }
  if (lines.length === 0) return [];
  return [
    `The diary has ${total} ${total === 1 ? "entry" : "entries"} covering this file:`,
    ...lines,
  ];
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
  // absolute path here names a file no peer can collide with. Claiming those
  // fills the roster with temp paths and pushes real claims past the cap.
  const outsideTree = /^(?:[A-Za-z]:\/|\/)/.test(path.replace(/\\/g, "/"));
  if (outsideTree) return;

  const notice = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);
    // The tree is re-read from the cwd of the EDIT. SessionStart's cwd is where
    // the session LAUNCHED, so a worktree it never cd'd into reads as the main
    // tree and inverts the same-tree/cross-worktree split. Only on a change,
    // because `currentBranch` is a subprocess and this runs on every edit.
    if (store.worktreeOf(sessionId) !== tree) store.setWorktree(sessionId, tree, currentBranch(cwd));
    // Re-registers a reaped session. A session that records no claims raises no
    // overlap warnings, which is the blindness the tool exists to end.
    const handle = store.handleForOrRegister(sessionId, tree, currentBranch(cwd), now);
    if (!handle) return null;

    // Read on EVERY edit, not only when a peer collides: "is someone in this
    // file" and "what do we know about this code" are unrelated questions.
    const diary = diaryLines(store, path);
    // Appended to the same block, because both answer "what should you know
    // before touching this file" and a second path is a second place to drop it.
    diary.push(...planLinkLine(store, sessionId, path));
    // The lineage offer goes LAST: findings about the file being edited now
    // outrank an offer to adopt accumulated knowledge.
    diary.push(...lineageLines(store, sessionId, path, lineagesHeld()));

    /** The diary alone, when there is no overlap to report alongside it. */
    const diaryOnly = (): string | null => (diary.length > 0 ? diary.join("\n") : null);

    // Read peers' claims BEFORE recording our own, so this session's claim
    // cannot appear in its own conflict list.
    const claimed = store.conflictingClaims(sessionId, path, now);
    // The tool is recorded because a Write is a whole-file replacement and an
    // Edit is a hunk — reading "Write" against a file two agents share is worth
    // more alarm than reading "Edit".
    store.claim(sessionId, path, now, { tool: payload.tool_name ?? "", worktree: tree });
    if (claimed.length === 0) return diaryOnly();

    // Same tree means their edits are literally in these files right now; a
    // separate worktree is an independent checkout, so the risk is a merge later
    // rather than an overwrite now. The two need different advice, so they are
    // reported separately instead of averaged into one vague warning.
    //
    // THE SPLIT COMES FIRST, because only one half may be filtered.
    const sameTree = claimed.filter((o) => !o.worktree || o.worktree === tree);
    const away = claimed.filter((o) => o.worktree && o.worktree !== tree);

    // A COMMITTED FILE IS NOT A COLLISION — IN THIS TREE ONLY. Never filter
    // `away` this way: for a peer in another worktree a commit is when the
    // merge risk STARTS. A null answer means git could not tell us, so the
    // warning stands — "clean" and "unknown" must not look the same.
    const here = sameTree.filter((o) => {
      const dirty = dirtyFiles(o.worktree !== "" ? o.worktree : tree);
      return dirty === null || dirty.has(o.path);
    });
    const others = [...here, ...away];
    if (others.length === 0) {
      // Only claims PROVED stale are dropped: in this tree, clean, and older
      // than the grace window. Dropping `claimed` wholesale would delete a
      // cross-worktree row on evidence that says nothing about it.
      for (const o of sameTree) {
        if (now - o.tsMs > MID_EDIT_GRACE_MS) store.releaseClaim(o.sessionId, o.path);
      }
      return diaryOnly();
    }

    // Announced to the log so the other agent learns of it on its next turn.
    // THE LINE CARRIES THE SAME/OTHER-TREE DISTINCTION, or a cross-checkout
    // overlap reads exactly like an on-disk collision. Session names, not
    // handles, because the reader may go on to `msg` the peer.
    const label = (cs: typeof others, where: string): string =>
      cs.length > 0 ? `${cs.map((o) => claimName(o)).join(", ")}${where}` : "";
    const parts = [label(here, " in this tree"), label(away, " in another worktree")].filter(
      (p) => p !== "",
    );
    // Announced once per file per window, not per edit. The warning below still
    // fires every time. ADDRESSED TO EACH PEER, not broadcast: `Stop` delivers
    // directed mail only, so a broadcast waits for the peer's next prompt.
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
      // NOT "there is no collision, carry on". Both sessions edit the same
      // logical code, and divergent rewrites surface at MERGE, when both are
      // finished and expensive to unpick.
      lines.push(
        `- ${names(away)} — in a separate worktree, so nothing is overwritten on ` +
          `disk. The two versions of ${path} still have to reconcile: changes to ` +
          `the same functions diverge silently until the merge, and behaviour ` +
          `changes here can invalidate the other session's measurements or tests ` +
          `even where the text does not conflict.`,
      );
    }
    // The channel is named at the point of use, where "you can ask them"
    // belongs. LOOK BEFORE ASKING: this warning names one file, and `files`
    // answers "what else are they in" without spending a peer's turn.
    if (others.length > 0) {
      const first = claimName(others[0] as Claim);
      lines.push(
        `Before asking, look: \`crew files ${first}\` ` +
          `lists every file they have touched and what they say they are doing; ` +
          `\`crew blame ${path}\` shows who has been in this one. If that leaves a ` +
          `real question, \`crew msg ${first} "<text>"\` reaches them — what each of ` +
          `you is changing, and which parts are load-bearing, is knowledge the ` +
          `other cannot derive from the file.`,
      );
    }
    // The overlap first: it is about THIS edit colliding right now, where the
    // diary is background about the folder. A reader skimming gets the urgent
    // half without having to pass the reference half.
    return [...lines, ...(diary.length > 0 ? ["", ...diary] : [])].join("\n");
  }, project.root);

  if (!notice) return;
  // The status line names the OVERLAP only when there is one — a diary pointer
  // is not a warning, and labelling it as one is how a genuine collision stops
  // being read as urgent.
  const overlap = notice.startsWith("Another session is editing");
  emit(
    "PreToolUse",
    notice,
    overlap ? "presence: file also claimed by another agent" : "presence: diary notes on this folder",
  );
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A silent catch makes a programmer error look like
  // "nothing to report", which is how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
}
