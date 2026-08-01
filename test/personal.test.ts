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
