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
 * `pre-edit` is a PreToolUse hook: it records the claim before the Edit tool
 * touches disk, so between those two moments a peer's file is claimed and still
 * clean. Deleting the row in that window removes the warning for the very edit
 * that needed it. Ten seconds is far longer than the gap (milliseconds) and far
 * shorter than a stale claim (minutes to hours).
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
 * NAME AND PLACE BOTH, deliberately narrow. `audit_reports/` and `docs/plans/`
 * are where this repo keeps them, and the PLAN/ROADMAP/EFFORT stems are what it
 * calls them — measured against the 82 real ones. A looser rule (any `.md`
 * under `docs/`) would fire on every system note and turn the suggestion into
 * the kind of line agents learn to scroll past.
 *
 * Cheap by construction: a regex against a string already in hand, on a hook
 * that runs before every edit.
 */
export function looksLikePlan(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  if (!/\.md$/i.test(p)) return false;
  // A DEDICATED PLANS FOLDER IS ENOUGH ON ITS OWN. `docs/plans/junction-editor.md`
  // is a plan and its filename never says so — measured against this repo's real
  // corpus, where requiring the stem missed 6 of 76 for exactly that reason. The
  // folder has already made the claim; asking the filename to repeat it rejects
  // the files whose authors trusted the folder.
  if (/(?:^|\/)(?:docs\/plans|plans)\//i.test(p)) return true;
  // Elsewhere the NAME has to carry it. `audit_reports/` holds findings and
  // audits as well as plans, so a bare `.md` there is usually neither.
  if (!/(?:^|\/)audit_reports\//i.test(p)) return false;
  return /(?:^|\/)[^/]*(?:PLAN|ROADMAP|EFFORT)[^/]*\.md$/i.test(p);
}

/**
 * Offers to link the open work item to the plan being edited.
 *
 * WHY THIS EXISTS AT ALL. `--plan-doc` and `link` shipped and nothing pointed
 * at them, which is the exact shape of the `breaks`/`needs` failure: two verbs
 * that worked, were advertised nowhere, and were used by nobody but their
 * author. `crew plans` is only as good as the links it has, and as of writing
 * it holds ONE plan out of 82.
 *
 * THREE CONDITIONS, and each one is a way this could become noise:
 *   - the path must look like a plan (see above);
 *   - the agent must have an open item — with none there is nothing to link,
 *     and suggesting `doing` here would be a different, unasked-for lecture;
 *   - that item must not already name a plan. This covers both "already linked
 *     to THIS one" and "deliberately linked to another": in the second case the
 *     agent has already decided, and a hook that argues with a decision is one
 *     that gets ignored on the occasion it is right.
 *
 * IT REPEATS while all three hold, and that is deliberate rather than an
 * oversight. The condition is not "have we said this" but "is the item still
 * unlinked" — a state the agent clears in one command. Recording a
 * said-it-once flag would add a column whose only job is to SUPPRESS true
 * advice, and this tool has already shipped one row nobody ever cleared.
 *
 * Silent whenever any condition fails. A hook that speaks on every plan edit
 * gets scrolled past, and then the diary lines above it get scrolled past too.
 */
export function planLinkLine(store: StoreHandle, sessionId: string, path: string): string[] {
  if (!looksLikePlan(path)) return [];
  const item = store.work.target(agentKey("", sessionId));
  if (!item || item.planDoc !== "") return [];
  const plan = normalisePlanPath(path);
  if (plan === "") return [];
  // THE COMMAND GETS ITS OWN LINE, and the subject is not interpolated into it.
  // Measured by driving this against a real item: putting both inline produced
  // a 156-character line, because a work subject is a sentence and a plan path
  // is 40-odd characters. The command is the part meant to be copied, so it is
  // the part that must not wrap.
  return [
    `You are editing a plan and your open item does not name one.`,
    `  \`crew link ${plan}\``,
    `  links it to "${fit(item.subject, 44)}", so \`crew plans\` can report what`,
    `  actually shipped against this plan rather than what it claims.`,
  ];
}

/**
 * What the diary knows about the folder this edit lands in.
 *
 * THE POINT OF THE WHOLE FEATURE. A diary nobody reads is a diary nobody
 * writes, and this is the only moment where a past finding is worth more than
 * it costs: the agent is about to touch the code the finding is about.
 *
 * A POINTER, NOT A DUMP, with one exception. Entry bodies cost hundreds of
 * tokens and are paid by every agent on every edit; a count and a command cost
 * one line. The exception is `warning` and `error`, whose titles are quoted —
 * those are the ones somebody wrote down specifically so the next person would
 * not repeat them, and a pointer they have to follow is a pointer they will not.
 */
/**
 * "Someone already knows this ground, and they are gone" — offered once, at the
 * moment the file is touched.
 *
 * THE CASE THE OPERATOR NAMED: "I might start a new session with roadworks, and
 * if I forget a roadwork agent already exists, it might create a completely new
 * empty state that has to learn everything from scratch." Naming a lineage
 * fixes nothing if the new agent never learns one exists, so it has to be TOLD.
 *
 * WHY THE SHARED DIARY IS THE INDEX and not the personal store: a memory is
 * about the OPERATOR and carries no scope, so it cannot answer "who knows this
 * folder". A scoped finding can, and measured 2026-08-02, all 11 scopes in this
 * repo have exactly one author — the signal is clean.
 *
 * SILENT UNLESS ALL OF THESE HOLD. A live author is a peer to ASK, not a
 * lineage to take (`msg` already covers that, and `inherit` would refuse it
 * anyway); an author with nothing in the personal store has no knowledge to
 * pass on; and a session that already has a lineage has decided.
 */
/**
 * Which lineages have anything worth inheriting, lowercased.
 *
 * Opened separately from the project store because the personal db is the one
 * store that is NOT per-repo. Cheap (one grouped read of a small table) and on
 * the per-edit path, so it is called once and passed in rather than queried per
 * candidate author.
 */
export function lineagesHeld(): Set<string> {
  return withPersonal(
    (personal) => new Set(personal.lineages().map((l) => l.lineage.toLowerCase())),
  );
}

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

export function diaryLines(store: StoreHandle, path: string): string[] {
  const total = store.diary.countForPath(path);
  if (total === 0) return [];

  const loud = store.diary.forPath(path, { limit: LOUD_SHOWN, kinds: LOUD_KINDS });
  const lines: string[] = [];
  for (const e of loud) {
    const where = e.scope !== "" ? ` [${e.scope}]` : "";
    // AN UNFIXED ERROR SAYS SO. `forPath` already surfaces errors here, so the
    // gap this closes is narrow and real: without the marker an error reads the
    // same whether someone fixed it last week or nobody ever has, and "still
    // open" is the half that decides whether you act on it now.
    const open = e.kind === "error" && e.fixedMs === 0 ? " STILL OPEN" : "";
    // TITLES only — the body is what `crew note <id>` is for. A title states
    // the claim, which is enough to decide whether the body is worth opening.
    lines.push(`- ${e.kind}${open}${where}: ${e.title} (${e.agent}, \`crew note ${e.id}\`)`);
  }

  // THE POINTER MUST NAME A COMMAND THAT RETURNS WHAT IT PROMISES, and the two
  // counts here are NOT the same set. `countForPath` includes repo-wide entries
  // (scope ""); `recall --scope` deliberately excludes them, because a repo-wide
  // note is not "about this folder". Measured 2026-08-01 by driving this hook
  // with two repo-wide entries and no scoped ones: it printed "2 more entries
  // cover this folder — `crew recall --scope <file>`" and that command
  // returned nothing at all. Same defect class as the `--scope` equality bug
  // this file already carries a note about — advice that fails when followed.
  //
  // So the remainder is split by what each half is reachable BY.
  const shownIds = new Set(loud.map((e) => e.id));
  const covering = store.diary
    .forPath(path, { limit: 200 })
    .filter((e) => !shownIds.has(e.id));
  const scoped = covering.filter((e) => e.scope !== "").length;
  const repoWide = covering.filter((e) => e.scope === "").length;

  if (scoped > 0) {
    // THE PATH, not its directory. Caught live 2026-08-01 by this hook firing
    // on its own file: entries scoped to `.claude/hooks/presence` were reported
    // while the pointer read `--scope .claude/hooks/presence/hooks`, which
    // matched nothing. `--scope` covers a path the way this lookup does — every
    // enclosing folder — so handing it the file is what makes the advice true.
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
  // absolute path here means a file no peer can collide with — a scratchpad
  // note, a file in ~/.claude, a sibling project. Claiming those filled the
  // roster with unreadable temp paths (observed live 2026-07-31: a session's
  // claim list led with a 100-character scratchpad path) and pushed the real,
  // in-repo claims past the display cap.
  const outsideTree = /^(?:[A-Za-z]:\/|\/)/.test(path.replace(/\\/g, "/"));
  if (outsideTree) return;

  const notice = withStore(project.dbPath, (store) => {
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

    // Read on EVERY edit, not only when a peer collides: the two are unrelated
    // questions ("is someone else in this file" vs "what do we already know
    // about this code"), and gating the diary on an overlap would surface it
    // almost never. Bounded by path depth against an index — see `scopeCandidates`.
    const diary = diaryLines(store, path);
    // Appended to the diary block rather than carried separately: both answer
    // "what should you know before touching this file", and a second delivery
    // path is a second place for one of them to be silently dropped.
    diary.push(...planLinkLine(store, sessionId, path));
    // The lineage offer goes LAST in this block: the diary findings above it are
    // about the file being edited right now, which outranks an offer to adopt
    // somebody's accumulated knowledge.
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

    // A COMMITTED FILE IS NOT A COLLISION — IN THIS TREE. A claim is released by
    // nothing but a 2-hour timer, so an agent that edited a file here, committed
    // it and moved on still holds it, and the warning points at a conflict the
    // commit already resolved.
    //
    // THIS MUST NOT BE APPLIED TO A CROSS-WORKTREE CLAIM, and an earlier version
    // did, which quietly disabled half this hook. A peer in another worktree who
    // commits goes clean instantly — but for them a commit is when the merge risk
    // STARTS, not when it ends, and CLAUDE.md tells every agent to commit as soon
    // as tests pass. So filtering `away` made the warning unreachable for exactly
    // the disciplined peers it exists to warn about. Demonstrated: two worktrees
    // editing one line, peer commits, warning suppressed, `git merge` conflicts.
    //
    // The 38-of-42 measurement that motivated the filter counted cross-worktree
    // claims as false positives. They were not.
    //
    // `git status` is ~40 ms, so this runs only once a conflicting claim exists.
    // A null answer means git could not tell us — the warning stands, because
    // "no dirty files" and "we do not know" must not look the same.
    const here = sameTree.filter((o) => {
      const dirty = dirtyFiles(o.worktree !== "" ? o.worktree : tree);
      return dirty === null || dirty.has(o.path);
    });
    const others = [...here, ...away];
    if (others.length === 0) {
      // Only the claims actually PROVED stale are dropped — those in this tree
      // whose file is clean. Dropping `claimed` wholesale would delete a
      // cross-worktree peer's row on evidence that says nothing about them.
      //
      // A claim is written in PreToolUse, BEFORE the edit reaches disk, so a peer
      // that has just claimed a file it is about to write looks clean for a few
      // hundred milliseconds. Deleting its row in that window destroys the one
      // warning that mattered, so the drop is limited to claims older than that
      // window — a claim made seconds ago is a peer mid-edit, not a stale row.
      for (const o of sameTree) {
        if (now - o.tsMs > MID_EDIT_GRACE_MS) store.releaseClaim(o.sessionId, o.path);
      }
      return diaryOnly();
    }

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
    // to message the peer, and `crew msg knuth` works only by luck.
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
  // Fail open — but REPORT. A silent catch turns a programmer error into a
  // hook that exits 0 having done nothing, which is indistinguishable from
  // "nothing to report" and is exactly how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
  // Fail open: never block an edit because coordination state is unavailable.
}
