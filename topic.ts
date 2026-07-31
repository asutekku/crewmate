/**
 * Turning a block of text into a one-line roster label, safely.
 *
 * Used for a session's first prompt and for a compaction summary — two places
 * where text written for one audience (this session's user, or the model itself)
 * would otherwise be republished to every peer in the project.
 *
 * DELIBERATELY LOSSY. A peer needs "roughly what is this session for", not the
 * transcript. Publishing prompts verbatim previously sent whatever was typed —
 * credentials, client names, a pasted stack trace — to every agent in the repo.
 */

/** A roster label, not a description — short enough to scan a column of them. */
const INTENT_MAX = 60;

/**
 * Anything that looks like a secret. Not a scrubber — a REJECTER: if the text
 * trips one of these the topic is dropped entirely rather than published with
 * the interesting part removed, because a redacted secret still reveals that a
 * secret was present and often what kind.
 */
const SENSITIVE =
  /(?:api[_-]?key|secret|token|password|passwd|credential|bearer|authorization|ssh-rsa|BEGIN [A-Z ]*PRIVATE KEY|\.env|[A-Za-z0-9_-]{32,})/i;

export function summarize(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen - 1)}…`;
}

/**
 * A coarse topic for the roster, or "" when there is nothing safe or useful to
 * say. Takes the opening clause only, caps hard, drops anything credential-
 * shaped, and rejects bare continuations ("go", "yes") that describe nothing.
 */
export function topicOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "" || SENSITIVE.test(flat)) return "";
  // First sentence or clause: later ones are usually detail and caveats.
  const head = flat.split(/(?<=[.!?])\s|[:;\n]/)[0] ?? flat;
  const short = summarize(head, INTENT_MAX);
  return short.split(/\s+/).length < 3 ? "" : short;
}
