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

/**
 * Words that carry no topic on their own. Measured, not guessed: with three
 * sessions live, all three roster intents were pure filler of this shape —
 * "Ok great, start implementing the next steps.", "lovely, we can start working
 * on next steps.", "Lovely, start working on it." Each passed the word-count
 * gate and each told a peer precisely nothing.
 *
 * This is the CONTINUE case, and it is the common one: the first prompt of a
 * resumed session is an acknowledgement, because the actual subject was
 * established in the conversation that came before it.
 */
const FILLER =
  /^(?:ok|okay|oh|ah|yeah|yes|yep|sure|right|great|lovely|nice|good|perfect|cool|thanks|thank you|please|now|so|and|but|then|well|alright|continue|continuing|go|go ahead|proceed|carry on|keep going|next|lets|let's|we|i|you|can|could|should|would|shall|will|start|started|begin|implement|implementing|work|working|do|doing|make|making|on|it|that|this|the|a|an|to|of|for|with|next|step|steps|thing|things|stuff|task|tasks|one|first|second|last|more|some|all|is|are|was|were|be|been|have|has|had|get|got|please)$/i;

/**
 * True when a phrase is made entirely of filler — an acknowledgement plus a
 * verb of intention, with no noun naming what is being worked ON.
 *
 * Erring toward REJECTING is right here: an empty intent falls back to a
 * derived signal (claims, tasks), while a filler intent displaces it with a
 * confident-looking lie that survives for the life of the session.
 */
function isContentless(phrase: string): boolean {
  const words = phrase.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w) => FILLER.test(w));
}

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
  if (short.split(/\s+/).length < 3) return "";
  // A phrase of pure filler is worse than no phrase: it looks like a stated task
  // and outranks every honest fallback the roster could show instead.
  if (isContentless(short)) return "";
  return short;
}
