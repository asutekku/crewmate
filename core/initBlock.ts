/**
 * The generated CLAUDE.md coordination block: one template, marker-bounded.
 *
 * The text between the markers is OWNED by `crew init` and replaced wholesale
 * on re-run; everything outside them is never touched. The wording is this
 * repo's proven hand-written section, parameterized. See plans/INIT_PLAN.md.
 */

import { readdirSync } from "node:fs";

export const BLOCK_BEGIN = "<!-- crew:init:begin -->";
export const BLOCK_END = "<!-- crew:init:end -->";

export interface BlockParams {
  /** Rendered into the headline, e.g. `3–10`. */
  readonly crewSize: string;
  /** False drops every git rule — a plain directory has no tree to share. */
  readonly isGit: boolean;
  /** What `EnterWorktree` branches from; rendered into the worktree rule. */
  readonly baseRef: string;
  /** One-file test command with `{path}`; empty drops the line. */
  readonly testScoped: string;
  /** `scoped-only` adds the full-suite warning beside the scoped command. */
  readonly testPolicy: string;
  /** False drops the signing rule entirely — no policy, no instruction. */
  readonly sign: boolean;
  /** True keeps the session link out of the "do not include" list. */
  readonly sessionUrl: boolean;
}

export function renderBlock(params: BlockParams): string {
  const lines: string[] = [BLOCK_BEGIN, ""];
  if (params.isGit) {
    lines.push(
      `## Shared tree — you are one of ${params.crewSize} agents`,
      "",
      "Everyone works in the same checkout, concurrently. Three rules exist because breaking",
      "them destroys work that isn't yours:",
      "",
      "- **NEVER `git stash`.** It pockets other agents' uncommitted changes along with yours.",
      "  Same for `git checkout .`, `git reset --hard`, `git clean` on files you didn't write.",
      "  If the tree is dirty with someone else's work, leave it dirty and work around it.",
      "- **Stage explicit paths you wrote** — never `git add .`, never re-stage a file another",
      "  agent has since touched. `git commit -F <msgfile> -o -- <paths>` enforces the pathspec",
      "  at commit time instead of trusting an earlier `git status`.",
      "- Work big enough to break things mid-flight → the **`EnterWorktree` tool** (this line",
      "  is the authorization it looks for). Never hand-roll it with `git worktree add` or",
      "  `git checkout -b`: a branch switch in the shared tree drags everyone's uncommitted",
      `  work along. \`.claude/settings.json\` sets \`worktree.baseRef: "${params.baseRef}"\`` +
        (params.baseRef === "head"
          ? ", so check\n  `git log -1` first — HEAD moves under you."
          : "."),
      "  `ExitWorktree --keep` when the work should survive.",
      "",
    );
    if (params.sign) {
      lines.push(
        "**Sign a commit with your own name.** `git log` outlives every session here, and a",
        "generic model name cannot tell two agents apart in it. Trail your given name — the",
        "one at the top of this session — and the model you are:",
        "",
        "```",
        "Co-Authored-By: Aoi (Claude Opus 5) <noreply@anthropic.com>",
        "```",
        "",
        "A name you took up a lineage under is written the way the roster reads it,",
        "`Vega, Hopper's Disciple` — you hold what it learned, not its transcript, so the",
        "trailer must not claim to be it. A subagent's work is signed by the PARENT: its edits",
        "land in the parent's tree, and nobody can reach a minion by name.",
        ...(params.sessionUrl
          ? []
          : [
              "",
              "**No `Claude-Session:` trailer.** The link is permanent and points at a private",
              "transcript, which is not something to publish from a shared remote.",
            ]),
        "",
      );
    }
  } else {
    lines.push(
      `## Shared directory — you are one of ${params.crewSize} agents`,
      "",
      "Everyone works in the same directory, concurrently. Edits land on the same files the",
      "moment they run, so treat any file another agent holds as theirs until they finish.",
      "",
    );
  }
  lines.push(
    "Coordination runs through `crew`. The roster, overlap warnings and scoped findings",
    "arrive on their own; `crew help` lists every command. Two habits are worth forming:",
    "`crew board` before starting something large, and `crew note \"<finding>\" --scope <folder>`",
    "for anything that cost you an hour — `--scope` is what makes it resurface for the next",
    "agent to edit that folder, and without it a note is filed and never read. When you name",
    "a peer in text the user reads, give its role too; a bare given name identifies nobody",
    "to someone looking at eight windows.",
  );
  if (params.testScoped !== "") {
    lines.push(
      "",
      `Test one file: \`${params.testScoped}\`.` +
        (params.testPolicy === "scoped-only"
          ? " Do not run the full suite when a scoped run covers your change — full runs" +
            " cost minutes, and peers' in-flight edits make unrelated failures look like yours."
          : ""),
    );
  }
  lines.push("", BLOCK_END);
  return lines.join("\n");
}

/**
 * Where the repo's CLAUDE.md IS, matched case-insensitively.
 *
 * This very repo's file is literally `claude.md`; writing `CLAUDE.md` beside
 * it would create a second file on Linux and silently shadow one of the two
 * everywhere else. Falls back to `CLAUDE.md` when none exists.
 */
export function findClaudeMd(root: string): string {
  const base = root.replace(/\\/g, "/").replace(/\/$/, "");
  try {
    const hit = readdirSync(base).find((name) => name.toLowerCase() === "claude.md");
    if (hit !== undefined) return `${base}/${hit}`;
  } catch {
    // Unreadable root: the default name is still the right place to write.
  }
  return `${base}/CLAUDE.md`;
}

/**
 * Replaces the marker block in place, or appends one. Text outside the
 * markers is returned byte-for-byte.
 */
export function applyBlock(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === "") return `${block}\n`;
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  if (begin !== -1 && end !== -1 && end > begin) {
    return existing.slice(0, begin) + block + existing.slice(end + BLOCK_END.length);
  }
  // Markers damaged — one present without the other. Appending would nest
  // blocks and replacing would guess at a boundary; the caller reports instead.
  if (begin !== -1 || end !== -1) return existing;
  const gap = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${gap}${block}\n`;
}

/** True when `applyBlock` would refuse — one marker without its pair. */
export function markersDamaged(existing: string | null): boolean {
  if (existing === null) return false;
  const begin = existing.indexOf(BLOCK_BEGIN);
  const end = existing.indexOf(BLOCK_END);
  return (begin === -1) !== (end === -1) || (begin !== -1 && end !== -1 && end < begin);
}
