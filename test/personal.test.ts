/**
 * The personal diary — what one agent knows about the operator.
 *
 * Two properties carry this feature and both are easy to break silently: a
 * memory must not leak into a project it is not about, and one agent's read of
 * the operator must not become another's.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  checkMemory,
  MEMORY_TITLE_MAX,
  personalDbPath,
  withPersonal,
} from "../core/personal.ts";

let n = 0;
let base = "";
const paths: string[] = [];

beforeEach(() => {
  // An ABSOLUTE path, not /tmp: under Git Bash a /tmp path resolves to a
  // different file per process, so a harness silently writes one db and reads
  // another. That cost real debugging time on 2026-08-01.
  base = `${tmpdir().replace(/\\/g, "/")}/presence-personal-${process.pid}-${n++}`;
  process.env["PRESENCE_TEST_DB"] = base;
  paths.push(base);
});

afterEach(() => {
  delete process.env["PRESENCE_TEST_DB"];
  for (const p of paths.splice(0)) {
    for (const suffix of ["", ".personal", ".personal-wal", ".personal-shm", "-wal", "-shm"]) {
      try {
        unlinkSync(p + suffix);
      } catch {
        /* already gone */
      }
    }
  }
});

const HOPPER = "hopper-conversation-uuid";
const LUNA = "luna-conversation-uuid";

function ok(title: string, body = "", tags: string[] = []) {
  const c = checkMemory(title, body, tags);
  if (!c.ok) throw new Error(`fixture rejected: ${c.why}`);
  return c;
}

describe("where it lives", () => {
  test("NOT in a per-project db, or it is not personal", () => {
    // The whole point: this is about a PERSON, so it outlives any one repo.
    // Routing it through `resolveProject` would quietly make it per-repo again.
    expect(personalDbPath()).toBe(`${base}.personal`);
    expect(personalDbPath()).not.toContain("agent-presence/I--");
  });

  test("PRESENCE_TEST_DB redirects it, like everything else", () => {
    // A test that reaches the real store is how the live roster got polluted
    // with fake agents once already.
    expect(personalDbPath().startsWith(base)).toBe(true);
  });
});

describe("project scope", () => {
  test("a project memory does NOT follow the agent to another repo", () => {
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("run water tests alone, this box is loaded"), "Traffic", false, 1);
      expect(p.forSession(HOPPER, "Traffic").length).toBe(1);
      // The failure this prevents: carrying one repo's specifics into another
      // and acting on them confidently.
      expect(p.forSession(HOPPER, "wardatrobe").length).toBe(0);
    });
  });

  test("a --global memory travels", () => {
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("wants the numbers in the commit message"), "", true, 1);
      expect(p.forSession(HOPPER, "Traffic").length).toBe(1);
      expect(p.forSession(HOPPER, "wardatrobe").length).toBe(1);
      expect(p.forSession(HOPPER, "anything-at-all").length).toBe(1);
    });
  });

  test("a session sees its project's memories AND its globals together", () => {
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("global one"), "", true, 1);
      p.remember(HOPPER, "hopper", ok("traffic one"), "Traffic", false, 2);
      p.remember(HOPPER, "hopper", ok("elsewhere one"), "wardatrobe", false, 3);

      expect(p.forSession(HOPPER, "Traffic").map((m) => m.title).sort()).toEqual([
        "global one",
        "traffic one",
      ]);
    });
  });

  test("--all-projects shows everything, which is how the operator audits it", () => {
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("global one"), "", true, 1);
      p.remember(HOPPER, "hopper", ok("traffic one"), "Traffic", false, 2);
      p.remember(HOPPER, "hopper", ok("elsewhere one"), "wardatrobe", false, 3);
      expect(p.forSession(HOPPER, "Traffic", { allProjects: true }).length).toBe(3);
    });
  });
});

describe("one agent's read is not another's", () => {
  test("Luna does not inherit what Hopper learned", () => {
    // THE FEATURE, not a limitation: two agents can hold different and even
    // contradictory reads of the same person, and inheritance is how one
    // agent's misread would become permanent for everyone.
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("prefers a plan before code"), "Traffic", false, 1);
      expect(p.forSession(HOPPER, "Traffic").length).toBe(1);
      expect(p.forSession(LUNA, "Traffic").length).toBe(0);
    });
  });

  test("the operator can list who holds memories about them", () => {
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("a"), "Traffic", false, 1);
      p.remember(HOPPER, "hopper", ok("b"), "Traffic", false, 2);
      p.remember(LUNA, "luna", ok("c"), "Traffic", false, 3);

      const agents = p.agents();
      expect(agents.length).toBe(2);
      expect(agents.find((a) => a.agent === "hopper")?.count).toBe(2);
      expect(agents.find((a) => a.agent === "luna")?.count).toBe(1);
    });
  });
});

describe("forgetting", () => {
  test("forget DELETES, where the shared diary deprecates", () => {
    // Asymmetric on purpose. A shared finding that stopped being true is still
    // history somebody believed for a reason. A wrong belief about a PERSON is
    // injected every session and compounds — and a tombstone would mean the
    // agent could still read what it was told to forget.
    withPersonal((p) => {
      const id = p.remember(HOPPER, "hopper", ok("a wrong read of them"), "Traffic", false, 1);
      expect(p.forget(id)).toBe(true);
      expect(p.get(id)).toBeNull();
      expect(p.forSession(HOPPER, "Traffic", { allProjects: true }).length).toBe(0);
    });
  });

  test("forgetting something twice is not an error the second time", () => {
    withPersonal((p) => {
      const id = p.remember(HOPPER, "hopper", ok("x"), "Traffic", false, 1);
      expect(p.forget(id)).toBe(true);
      expect(p.forget(id)).toBe(false);
    });
  });
});

describe("validation", () => {
  test("the length cap names WHY it is short", () => {
    const r = checkMemory("x".repeat(MEMORY_TITLE_MAX + 1), "", []);
    expect(r.ok).toBe(false);
    // These are injected at EVERY session start, so length is paid repeatedly —
    // the refusal should say so rather than reading as an arbitrary limit.
    if (!r.ok) {
      expect(r.why).toContain("session start");
      expect(r.why).toContain("--body");
    }
  });

  test("empty is refused", () => {
    expect(checkMemory("   ", "", []).ok).toBe(false);
  });

  test("tags are deduplicated and lowercased", () => {
    const r = checkMemory("t", "", ["Style", "style", " COMMITS "]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tags).toEqual(["style", "commits"]);
  });
});

describe("the project filter cannot be tricked", () => {
  test("A PROJECT NAME THAT IS A SQL WILDCARD matches only itself", () => {
    // `forSession` filters with `project = ?`, an equality bind — so `%` is a
    // literal name and not a pattern. Asserted rather than assumed because the
    // sibling filter one file over (`tags LIKE ?`) IS a pattern, and the day
    // this becomes a LIKE for some reason, every agent starts carrying every
    // repo's private preferences into every other repo.
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("learned in a repo literally named %"), "%", false, 1);
      p.remember(HOPPER, "hopper", ok("learned in Traffic"), "Traffic", false, 2);

      expect(p.forSession(HOPPER, "Traffic").map((m) => m.title)).toEqual(["learned in Traffic"]);
      expect(p.forSession(HOPPER, "%").map((m) => m.title)).toEqual([
        "learned in a repo literally named %",
      ]);
      // An underscore is the other LIKE metacharacter, and a one-character
      // project name would match it if this were ever a pattern.
      p.remember(HOPPER, "hopper", ok("underscore repo"), "_", false, 3);
      expect(p.forSession(HOPPER, "x").length).toBe(0);
    });
  });

  test("an EMPTY project name is a project, not a wildcard", () => {
    // "" is the column default and the value a global carries, so a query for
    // it must not become "everything". A hook that failed to resolve a project
    // name would pass "" here.
    withPersonal((p) => {
      p.remember(LUNA, "luna", ok("no project recorded"), "", false, 1);
      p.remember(LUNA, "luna", ok("traffic one"), "Traffic", false, 2);

      expect(p.forSession(LUNA, "").map((m) => m.title)).toEqual(["no project recorded"]);
      expect(p.forSession(LUNA, "Traffic").map((m) => m.title)).toEqual(["traffic one"]);
    });
  });

  test("a GLOBAL learned in a named project still travels", () => {
    // `--global` and a project name are not mutually exclusive: the column
    // records WHERE it was learned even on a global, because "where did I learn
    // this" is the first question when one turns out to be wrong. The travel
    // must key on the flag, not on the project being blank.
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("wants numbers in the commit message"), "Traffic", true, 1);
      expect(p.forSession(HOPPER, "wardatrobe").map((m) => m.title)).toEqual([
        "wants numbers in the commit message",
      ]);
      expect(p.get(1)?.project).toBe("Traffic");
      expect(p.get(1)?.global).toBe(true);
    });
  });

  test("one agent's memories never reach another, whatever the project", () => {
    // The isolation is per-SESSION and must not be weakened by the project
    // filter in either direction — including for globals, which are the ones
    // that travel furthest.
    withPersonal((p) => {
      p.remember(HOPPER, "hopper", ok("a global of hopper's"), "", true, 1);
      p.remember(HOPPER, "hopper", ok("a local of hopper's"), "Traffic", false, 2);
      for (const project of ["Traffic", "wardatrobe", "", "%"]) {
        expect(p.forSession(LUNA, project)).toEqual([]);
      }
      expect(p.forSession(LUNA, "Traffic", { allProjects: true })).toEqual([]);
    });
  });
});

describe("the store survives what an agent will actually type", () => {
  test("a body at the cap round-trips intact", () => {
    withPersonal((p) => {
      const body = "x".repeat(2000);
      const c = checkMemory("a title", body, []);
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      const id = p.remember(HOPPER, "hopper", c, "Traffic", false, 1);
      expect(p.get(id)?.body.length).toBe(2000);
    });
  });

  test("a title is measured in CODE POINTS, not UTF-16 units", () => {
    // An astral character is two UTF-16 units and one character. Counting units
    // would reject a title half the stated length — and the cap is quoted to
    // the agent in the refusal, so being wrong about it teaches a wrong lesson.
    const astral = "\u{1D518}".repeat(MEMORY_TITLE_MAX);
    expect([...astral].length).toBe(MEMORY_TITLE_MAX);
    expect(astral.length).toBe(MEMORY_TITLE_MAX * 2);
    expect(checkMemory(astral, "", []).ok).toBe(true);
    expect(checkMemory(astral + "\u{1D518}", "", []).ok).toBe(false);
  });

  test("a multi-line title collapses to one line", () => {
    // These are injected at session start, so a title carrying newlines would
    // break the block it is rendered into.
    const c = checkMemory("first line\n\n   second line", "", []);
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.title).toBe("first line second line");
  });

  test("a renamed agent is listed ONCE, with all of its memories counted", () => {
    // The operator reads `about-me` to audit who holds what. An agent that
    // renamed itself must not appear as two agents, or the audit under-reports
    // each of them and the count the operator acts on is wrong.
    //
    // WHAT IS NOT ASSERTED: which of the names is shown. `agents()` groups by
    // session and selects a BARE `agent` column, so SQLite is free to pick any
    // row in the group — measured 2026-08-01 it returns the last one INSERTED,
    // which is not the same as the most recent by `ts_ms` (a memory written
    // with an older timestamp after a newer one still wins). Pinning a
    // particular name here would be asserting an implementation accident. The
    // grouping is the contract; the label is cosmetic.
    withPersonal((p) => {
      p.remember(HOPPER, "tooling", ok("learned early"), "Traffic", false, 1);
      p.remember(HOPPER, "hopper", ok("learned later"), "Traffic", false, 2);
      const rows = p.agents().filter((a) => a.sessionId === HOPPER);
      expect(rows.length).toBe(1);
      expect(rows[0]?.count).toBe(2);
      // Whichever it picked, it must be one the agent actually used.
      expect(["tooling", "hopper"]).toContain(rows[0]?.agent ?? "");
    });
  });
});
