/**
 * UserPromptSubmit: heartbeat, deliver unread peer messages, and record what
 * this session was asked to do.
 *
 * ONE OF THREE DOORS. This one fires at a prompt; `tool-batch` delivers between
 * tool batches and `turn-end` after a stop, so a long autonomous run does not
 * have to wait for its next prompt.
 */

import { agoText, displayName, withStore } from "../core/store.ts";
import { agentKey, progress } from "../core/work.ts";
import { loadConfig } from "../core/config.ts";
import { emit, formatMessages, formatRoster, readPayload, TRUST_NOTE } from "../core/shared.ts";
import { currentBranch, resolveProject, worktreeRoot } from "../core/repo.ts";
import { topicOf } from "../core/topic.ts";
import { readTranscript } from "../core/transcript.ts";


/** At most this many items are raised at once; a wall of them gets skipped. */
const STALE_SHOWN = 3;

/**
 * Questions owed by this session, and answers owed to it.
 *
 * BOTH DIRECTIONS IN ONE PLACE, being two halves of one fact. Resolved answers
 * are DRAINED, so each is shown once: a line repeated every turn is a line that
 * gets skipped.
 */
function questionLines(
  store: Parameters<Parameters<typeof withStore>[1]>[0],
  sessionId: string,
  nowMs: number,
): string[] {
  const lines: string[] = [];

  // READS THE OBLIGATION LEDGER. This block used to read `store.questions`,
  // which `ask` has never written to — so it advertised
  // `crew answer <id>` to agents holding a uuid the old integer-only `answer`
  // rejected. A hook that instructs an agent to run a command that cannot
  // succeed is worse than silence: it burns a turn on a guaranteed failure.
  const open = store.obligations.openQuestions(sessionId);
  const live = store.liveSessions(nowMs);
  const nameFor = (id: string): string => {
    const hit = live.find((s) => s.sessionId === id);
    return hit ? displayName(hit) : id.slice(0, 8);
  };

  if (open.mine.length > 0) {
    lines.push(`${open.mine.length} question(s) waiting on you:`);
    for (const q of open.mine) {
      const who = q.asker === "" ? "the operator" : nameFor(q.asker);
      lines.push(`  ${q.id.slice(0, 8)} from ${who}: ${q.text}`);
    }
    lines.push(`  Answer with \`crew answer <id> "<text>"\`, or say why not.`);
  }
  return lines;
}

/**
 * Asks about open work items that have not moved. NEVER AUTO-CLOSED and asked
 * ONCE PER ITEM — see `staleItems` in core/work.ts for why both matter.
 */
function staleWorkLines(
  store: Parameters<Parameters<typeof withStore>[1]>[0],
  sessionId: string,
  nowMs: number,
): string[] {
  const mine = store.work.staleItems(
    agentKey("", sessionId),
    nowMs,
    loadConfig().workStaleMs,
  );
  if (mine.length === 0) return [];

  const shown = mine.slice(0, STALE_SHOWN);
  const lines = [
    shown.length === 1
      ? "One of your work-board items has not moved in a while:"
      : `${shown.length} of your work-board items have not moved in a while:`,
  ];
  for (const item of shown) {
    const p = progress(store.work.steps(item.workId));
    const done = p.total > 0 ? ` (${p.done}/${p.total})` : "";
    lines.push(`  - "${item.subject}"${done}, last touched ${agoText(item.updatedMs, nowMs)}`);
    // Marked here rather than after the agent answers: there is no signal for
    // "it answered", and asking every turn until it does is the noise this is
    // trying not to be.
    store.work.markAsked(item.workId, nowMs);
  }
  lines.push(
    "If one is finished or abandoned, `crew done \"<subject match>\"` (add `--abandoned` if it" +
      " was dropped) closes it. If it is still live, `crew did <n> \"<what changed>\"` or" +
      " `crew step <n> \"<status>\"` moves it on. Either way the board stops advertising work" +
      " nobody is doing — you will not be asked about these again.",
  );
  return lines;
}

async function main(): Promise<void> {
  const payload = await readPayload();
  const sessionId = payload?.session_id;
  const cwd = payload?.cwd;
  if (!sessionId || !cwd) return;

  const project = resolveProject(cwd);
  const tree = worktreeRoot(cwd);

  const report = withStore(project.dbPath, (store) => {
    const now = Date.now();
    store.touch(sessionId, now);

    // Re-registers if the row was reaped: this hook firing proves the session
    // is alive, and a pruned session that cannot come back is invisible to
    // every peer for the rest of its life.
    const handle = store.handleForOrRegister(sessionId, tree, currentBranch(cwd), now);
    if (!handle) return null;
    const self = store.liveSessions(now).find((s) => s.sessionId === sessionId);

    // THE MOST RECENT prompt that names a topic is the session's stated task —
    // not the first. The first-prompt rule made the column describe what a
    // session was asked once rather than what it is doing: measured across four
    // live sessions on 2026-07-31 it produced one agent frozen on its opening
    // question, one frozen on an ANSWER it had given, and two blank. A stale
    // label is worse than a moving one, because a peer reads the roster to
    // decide whether to interrupt.
    //
    // The roster gets a SHORT, NON-VERBATIM label and nothing is posted to the
    // log. Publishing prompts word-for-word sent whatever the user typed —
    // credentials, client names, a pasted stack trace — to every peer in the
    // repo, and produced lines like `turing was asked by its user: "go"` that
    // carried no information at all. A peer needs to know roughly what a session
    // is for; it does not need the transcript.
    //
    // Written only when `topicOf` found something: it returns "" for filler and
    // for pasted output, and clearing a good label because the latest prompt was
    // "yes" would lose the last true thing the column had.
    const topic = payload.prompt !== undefined ? topicOf(payload.prompt) : "";
    if (self && topic !== "") store.setIntent(sessionId, topic);

    // Claude Code's own conversation name, which it rewrites every turn. Read
    // rather than inferred: it is a model-written summary of the whole
    // conversation and costs 0.4 ms, where `topicOf` above can only ever see the
    // single prompt in front of it. Recorded for the OPERATOR's roster — a peer
    // never sees it (see the Session type).
    //
    // The transcript path is also stored, so the summary refresh can find this
    // session's transcript later without reconstructing a path from its id.
    if (payload.transcript_path) {
      store.setTranscript(sessionId, payload.transcript_path);
      const { title } = readTranscript(payload.transcript_path);
      // Only when non-empty: transcripts predating the feature have no title at
      // all, and blanking a good one because today's read came up empty would
      // lose the only description some sessions have.
      if (title !== "") store.setTitle(sessionId, title);
    }

    // A PLACEHOLDER ROW for an agent that has not opened one itself. The board's
    // founding problem is that agents skip optional work — the task board it
    // replaced had zero rows — so an agent that never runs `doing` is a blank
    // where the operator expects to see who is doing what. `autoOpen` is a
    // no-op once that agent opens a real item, and the placeholder is closed
    // when it does.
    //
    // The subject is Claude Code's own conversation title, read a few lines
    // above: model-written, moves as the work does, and costs nothing here
    // because it has already been fetched.
    const selfNow = store.findBySession(sessionId);
    if (selfNow && selfNow.title !== "") {
      store.work.autoOpen(agentKey("", sessionId), displayName(selfNow), selfNow.title, now);
    }

    // ASKED BEFORE the unread check, because an item dangles regardless of
    // whether a peer happened to message you — gating it on peer traffic would
    // make the nudge arrive on a schedule set by other agents' chatter.
    const stale = staleWorkLines(store, sessionId, now);
    // Questions ride the same reasoning: one aimed at you is owed an answer
    // whether or not anyone else has messaged. Expiry runs first so a question
    // whose asker has since died is never presented as still worth answering.
    store.questions.expireStale(now, loadConfig().staleMs);
    const questionText = questionLines(store, sessionId, now);

    const unread = store.drainUnread(sessionId);
    if (unread.length === 0) {
      const quiet = [...stale, ...questionText];
      return quiet.length > 0 ? { text: quiet.join("\n"), count: 0, stale: stale.length } : null;
    }

    // A message is only actionable next to the roster it refers to, so the two
    // are always delivered together.
    const peers = store.liveSessions(now).filter((s) => s.sessionId !== sessionId);
    const claims = store.allClaims(now);
    const lines = [`${unread.length} update(s) from other agents in ${project.name}:`];
    lines.push(...formatMessages(unread, now));
    if (peers.length > 0) {
      lines.push("", "Currently active:");
      lines.push(
        ...formatRoster(peers, claims, now, tree, undefined, false, store.minionCounts(now)),
      );
    }
    lines.push("", TRUST_NOTE);
    if (stale.length > 0) lines.push("", ...stale);
    if (questionText.length > 0) lines.push("", ...questionText);
    return { text: lines.join("\n"), count: unread.length, stale: stale.length };
  }, project.root);

  if (!report) return;
  const what =
    report.count > 0
      ? `presence: ${report.count} peer update(s)`
      : `presence: ${report.stale} work item(s) may be finished`;
  emit("UserPromptSubmit", report.text, what);
}

try {
  await main();
} catch (err) {
  // Fail open — but REPORT. A silent catch makes a programmer error look like
  // "nothing to report", which is how a missing import shipped.
  console.error(`[presence] ${import.meta.file} failed:`, err);
  // Fail open.
}
