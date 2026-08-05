/**
 * P2 — what the verb table CLAIMS must match what the code does.
 *
 * WRITTEN AGAINST THE SPEC. These are not tests of string formatting; each one
 * pins a promise that was measured false:
 *
 * - `clear` was described as "wipe the roster and message log". It deletes
 *   sessions and claims only and prints "(Message log is kept; it
 *   self-prunes.)" -- wrong in BOTH directions. An audit declined to run it on
 *   the strength of a blast radius it does not have, and a reviewer inferred
 *   from the same line that a `--help` probe might have destroyed history.
 * - `quit` was described as dropping a "dead" session. There is no liveness
 *   check; `quit <live peer>` deregisters a working agent mid-task.
 *
 * A blurb is not decoration here. It is the only description most operators
 * ever read, it is what `--help` prints, and `docs/audiences.md` is generated
 * from this table -- so a wrong blurb propagates into the documentation that is
 * supposed to correct it.
 */

import { describe, expect, test } from "bun:test";

import { findVerb, VERBS, type Verb } from "../core/verbs.ts";

const verb = (name: string): Verb => {
  const found = findVerb(name);
  if (!found) throw new Error(`no such verb: ${name}`);
  return found;
};

describe("P2-1 — `clear` describes its real blast radius", () => {
  test("it does not claim to wipe the message log", () => {
    // `cli/admin.ts` deletes from `sessions` and `claims`. It never touches
    // `messages`, and says so in its own success output.
    expect(verb("clear").blurb).not.toMatch(/message log\b(?!.*kept)/i);
  });

  test("it says the message log survives, since that is the surprising half", () => {
    expect(verb("clear").blurb).toMatch(/log is kept|keeps the (message )?log/i);
  });

  test("it still warns that the roster goes", () => {
    // Under-promising is its own defect: this verb IS destructive.
    expect(verb("clear").blurb).toMatch(/wipe|clear|drop/i);
  });
});

describe("P2-3 — `quit` does not promise a liveness check it lacks", () => {
  test("it does not claim to drop only dead sessions", () => {
    // THE DEFECT: "drop a dead session off the roster" reads as a guarantee
    // that a live peer is safe. `crew quit <live peer>` deregisters it.
    expect(verb("quit").blurb).not.toMatch(/\bdead\b/i);
  });

  test("it says there is no liveness check, because that is what bites", () => {
    expect(verb("quit").blurb).toMatch(/no liveness|does not check|any session/i);
  });
});

describe("P2 — the table is the single description of every verb", () => {
  test("no blurb promises behaviour with a bare absolute", () => {
    // `always`/`never` in a one-line blurb is how `quit`'s "dead" and `clear`'s
    // "message log" got written: a strong claim with no room for the caveat.
    // Flagged rather than banned outright -- if one is genuinely warranted the
    // verb's own docs page is the place for it.
    for (const v of VERBS)
      expect(v.blurb, `${v.verb}: ${v.blurb}`).not.toMatch(/\balways\b|\bnever\b/i);
  });

  test("every blurb fits the two-column help layout", () => {
    // `usage()` drops a row to the stacked form when it cannot fit; a blurb
    // long enough to do that at 100 columns costs every other verb its layout.
    for (const v of VERBS)
      expect(v.blurb.length, `${v.verb}`).toBeLessThan(70);
  });

  test("destructive verbs are reachable from help without being run", () => {
    // The safety property behind P4-9: the description of a verb that destroys
    // state must be readable at the prompt.
    for (const name of ["clear", "quit", "forget", "done"]) {
      expect(verb(name).blurb.trim().length).toBeGreaterThan(0);
      expect(verb(name).audience).toBeDefined();
    }
  });
});
