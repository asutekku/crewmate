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
 * Words that carry no topic on their own — the resumed session's "Lovely, start
 * working on it", which passes a word-count gate and tells a peer nothing.
 *
 * SINGLE WORDS ONLY: `isContentless` tests one word at a time, so a multi-word
 * entry here silently never matches.
 */
const FILLER =
  /^(?:ok|okay|oh|ah|yeah|yes|yep|yup|sure|right|alright|great|lovely|nice|good|perfect|cool|awesome|thanks|thank|please|now|so|and|but|then|well|continue|continuing|go|going|ahead|proceed|carry|keep|next|lets|let's|we|i|you|can|could|should|would|shall|will|start|started|begin|implement|implementing|work|working|do|doing|done|make|making|on|it|that|this|the|a|an|to|of|for|with|step|steps|thing|things|stuff|task|tasks|one|two|first|second|last|more|some|any|all|is|are|was|were|be|been|being|have|has|had|get|got|up|out|in|at|if|as|too|also|just|still|again|ready|there|here|them|its|your|my|works|work|worked|fine|correct|agreed|exactly|indeed|true|looks|sounds|seems)$/i;

/** A chosen name has to fit a roster column beside a worktree and an age. */
const ALIAS_MAX = 24;

/**
 * Names this system assigns, which an agent may not claim as its own.
 *
 * `human` is the operator's handle — an agent answering to it could post in the
 * user's voice, which is the one forgery the sender-identity work exists to
 * prevent. `everyone` and `all` read as broadcast targets in `msg`.
 */
const RESERVED_ALIASES = /^(?:human|user|operator|everyone|all|none|system|claude)$/i;

/**
 * Validates a name an agent picked for itself, returning the cleaned name or a
 * reason it was refused.
 *
 * STRICTER THAN AN INTENT: an alias is addressable and frozen into every
 * message, so a wrong one misroutes. ONE WORD, ALWAYS — `msg water dynamic`
 * parses as a message to `water`. The ROLE is the field for several words.
 */
export function validateAlias(raw: string): { ok: true; alias: string } | { ok: false; why: string } {
  const alias = raw.trim().replace(/\s+/g, " ");
  if (alias === "") return { ok: false, why: "a name cannot be empty" };
  if ([...alias].length > ALIAS_MAX) {
    return { ok: false, why: `a name must be ${ALIAS_MAX} characters or fewer` };
  }
  // Checked BEFORE the character class so the reason names the real problem.
  // The generic "letters, digits, - and _ only" is true but unhelpful here: it
  // does not say what to do, and the repair is always the same.
  if (alias.includes(" ")) {
    return {
      ok: false,
      why:
        `a name must be one word — peers type it at \`msg\`, and "${alias}" would ` +
        `read as two arguments. Try "${alias.replace(/ /g, "-")}", or put the ` +
        `several-word version in your role with \`call-you\`.`,
    };
  }
  // Letters, digits, and the two separators a name actually wants. Excludes the
  // quotes and backticks that would break the shell line a peer copies to reply,
  // and the control characters that would let a name rewrite a roster line.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(alias)) {
    return { ok: false, why: "letters, digits, - and _ only, starting with a letter or digit" };
  }
  if (RESERVED_ALIASES.test(alias)) return { ok: false, why: `"${alias}" is reserved` };
  if (SENSITIVE.test(alias)) return { ok: false, why: "that looks like a credential" };
  return { ok: true, alias };
}

/** A role shares the roster line with a name and an age, so it stays short. */
const ROLE_MAX = 28;

/**
 * Validates what an agent IS — "Tooling Master", "Keeper of Wet Things".
 *
 * LOOSER THAN A NAME on purpose. A name is typed at `msg`, so it cannot carry a
 * space or a quote; a role is only ever read, so apostrophes and ampersands are
 * fine and the interesting ones need them. What is still refused is what would
 * corrupt the line it is printed on, or leak a secret into the roster.
 */
export function validateRole(raw: string): { ok: true; role: string } | { ok: false; why: string } {
  const role = raw.trim().replace(/\s+/g, " ");
  if (role === "") return { ok: false, why: "a role cannot be empty" };
  if ([...role].length > ROLE_MAX) {
    return { ok: false, why: `a role must be ${ROLE_MAX} characters or fewer` };
  }
  // Control characters could rewrite a roster row. Scanned by CODE POINT: a
  // literal ESC in source is invisible in a diff and makes grep call the file
  // binary.
  for (const ch of role) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, why: "a role cannot contain control characters" };
    }
  }
  if (SENSITIVE.test(role)) return { ok: false, why: "that looks like a credential" };
  return { ok: true, role };
}

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

/**
 * Marks of pasted terminal output rather than a stated task: a shell prompt, an
 * ANSI escape, a log timestamp, a diff or stack frame. Checked against the
 * WHOLE prompt, because the give-away sits below the sentence introducing it.
 */
const PASTED_OUTPUT = new RegExp(
  [
    String.raw`(?:^|\n)\s*\$ \S`, // a shell prompt followed by a command
    String.raw`(?:^|\n)\s*(?:PS )?[A-Za-z]:\\[^\n]*>`, // a Windows prompt
    "\u001b\\[", // an ANSI escape, written escaped: a raw ESC byte in source is
    //         invisible and breaks every later text edit of this file
    String.raw`(?:^|\n)\s*(?:at |\+\+\+ |--- |@@ )`, // stack frame or diff hunk
    String.raw`\d{1,2}:\d{2}:\d{2}`, // a log timestamp
    String.raw`\b\d+[mhd] ago\b`, // this log's own relative times
  ].join("|"),
);

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
  // Tested against the RAW text: the marks of a paste are its line structure,
  // which flattening destroys. STRUCTURAL MARKS ONLY — length is not evidence,
  // and a line-count rule rejected ordinary multi-paragraph instructions.
  if (PASTED_OUTPUT.test(text)) return "";

  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "" || SENSITIVE.test(flat)) return "";
  // First sentence or clause; a too-short head falls through to the next one,
  // so a leading "goal:" label does not yield a one-word topic.
  //
  // THE COLON MUST NOT BE INSIDE A PATH OR URL: `i:\Projects\…` split into the
  // head "We have i", which then read as filler and rejected the whole prompt.
  // A colon separates a clause only when whitespace follows it.
  const parts = flat.split(/(?<=[.!?])\s|:\s|[;\n]/).filter((s) => s.trim() !== "");
  const head = (parts[0] ?? flat).trim();
  // A long path carries no meaning at roster width and would eat the whole
  // budget, hiding the sentence that says what the session is for.
  const dropPaths = (s: string): string =>
    s
      .split(/\s+/)
      .filter((w) => !(w.length >= 20 && /[\\/]/.test(w)))
      .join(" ")
      .trim();
  const headClean = dropPaths(head);
  const usable =
    headClean.split(/\s+/).length >= 3
      ? headClean
      : (parts.map(dropPaths).find((p) => p.split(/\s+/).length >= 3) ?? (headClean || head));
  const short = summarize(usable, INTENT_MAX);
  // Pure filler is worse than nothing: it looks like a stated task and outranks
  // every honest fallback. CONTENT, NOT LENGTH — a word-count gate also threw
  // away real two-word tasks like "fix lanes".
  if (isContentless(short)) return "";
  return short;
}
