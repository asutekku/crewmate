/**
 * The detached process that generates one session's summary.
 *
 * Spawned by `refreshSummary` and orphaned immediately, so it must assume the
 * hook that started it is already gone: it takes everything it needs as argv,
 * holds no db connection while the model runs, and writes exactly once at the
 * end. Nothing waits for it and nothing reads its output.
 *
 * Usage: bun summarize-worker.ts <sessionId> <transcriptPath> <dbPath>
 */

import { generateSummary } from "./summary.ts";
import { recentAssistantText } from "./transcript.ts";
import { withStore } from "./store.ts";

async function main(): Promise<void> {
  const [sessionId, transcriptPath, dbPath] = process.argv.slice(2);
  if (!sessionId || !transcriptPath || !dbPath) return;

  // CLAIM THE SLOT BEFORE THE SLOW PART. Two roster reads seconds apart would
  // otherwise both see a stale summary and both spawn a worker; stamping the
  // timestamp first means the second finds the row fresh and does nothing. The
  // db is opened and closed around this write so no connection is held for the
  // ~8 s the model takes — several sessions share this file.
  withStore(dbPath, (store) => {
    const existing = store.findBySession(sessionId);
    if (!existing) return;
    store.setSummary(sessionId, existing.summary, Date.now());
  });

  const activity = recentAssistantText(transcriptPath);
  if (activity.trim() === "") return;

  const summary = await generateSummary(activity);
  if (summary === "") return;

  withStore(dbPath, (store) => {
    // Re-checked: the session may have ended during the call, and resurrecting
    // a row for a dead session would put a ghost in the roster.
    if (!store.findBySession(sessionId)) return;
    store.setSummary(sessionId, summary, Date.now());
  });
}

try {
  await main();
} catch (err) {
  // Nothing reads this process's output, so a failure can only ever mean "the
  // roster keeps the summary it had". Reported for a human running it by hand.
  console.error("[presence] summarize-worker failed:", err);
}
