/**
 * Given names for agents, and the role that goes in front of one.
 *
 * A NAME IS TYPED (`msg luna`) and must not move; a ROLE is read and is free to
 * change as the work does. Collapsing them forces `msg "Luna — Tooling Master"`
 * and makes a changed role look like a stranger on the roster.
 */

/**
 * How far back a name is considered taken.
 *
 * DELIBERATELY MUCH LONGER than `STALE_MS` or `CLAIM_TTL_MS`: those ask "is
 * this agent working?", this asks "would reusing the name mislead a reader?".
 * Measured against agents found alive 37 and 55 hours after starting.
 */
export const NAME_REUSE_MS = 60 * 60 * 60 * 1000; // 60 h

/**
 * The pool, alphabetical so a duplicate is visible when editing. Large because
 * a name is held 60 hours after its last use, so it must cover days of churn.
 * Mixed origins on purpose: one theme makes names blur together.
 */
export const GIVEN_NAMES = [
  "adela", "akari", "akira", "alder", "ambrose", "anouk", "anton", "aoi", "arden", "arlo",
  "ash", "atlas", "aubrey", "august", "avery", "ayame", "barnaby", "beatrix", "beckett", "bexley",
  "bianca", "birch", "blake", "bramble", "briar", "bruno", "calla", "callum", "casper", "caspian",
  "cassidy", "cedar", "cedric", "celeste", "chihiro", "chiyo", "clara", "clay", "cleo", "colette",
  "conrad", "cora", "cove", "cyrus", "dahlia", "daiki", "delia", "delphi", "desmond", "dorian",
  "dove", "eden", "edith", "edmund", "elara", "elio", "ellis", "eloise", "elowen", "ember",
  "emery", "emi", "emrys", "esme", "ewan", "fable", "felix", "fennec", "ferris", "finch",
  "flint", "freya", "frida", "frost", "galen", "garnet", "gideon", "gilda", "giselle", "greta",
  "gustav", "hamish", "hana", "harbor", "harlan", "haru", "haruki", "hayato", "hazel", "helena",
  "heron", "hesper", "hikaru", "hinata", "hiro", "hollis", "hugo", "imogen", "indigo", "ines",
  "ione", "ira", "iris", "isamu", "isolde", "ivar", "ivo", "izumi", "jarrah", "jasper",
  "jessa", "jonas", "jules", "jun", "june", "juniper", "juno", "kaede", "kai", "kaia",
  "kaito", "kaori", "kaoru", "kei", "keiko", "kenji", "kepler", "kestrel", "keziah", "kiku",
  "kira", "lachlan", "lark", "leif", "lennox", "leon", "leonie", "linden", "loam", "lucia",
  "lucian", "luna", "lyra", "mabel", "magda", "magnus", "makoto", "maren", "marisol", "marlow",
  "mathias", "mei", "merritt", "midori", "mika", "milo", "minoru", "mira", "mistral", "miyu",
  "morgan", "nadia", "nana", "nao", "naoki", "natsu", "nell", "niamh", "nikolai", "noor",
  "north", "nova", "nozomi", "oakley", "oberon", "odette", "odile", "onyx", "orion", "osamu",
  "oscar", "osric", "otis", "ottilie", "otto", "palmer", "pascal", "perrin", "petra", "philippa",
  "phoenix", "piper", "quentin", "quill", "quinn", "rafferty", "rei", "ren", "rhea", "riku",
  "rin", "ripley", "river", "roland", "romilly", "ronan", "rosalind", "rowan", "rufus", "ryo",
  "sable", "sage", "sakura", "saskia", "satoshi", "sawyer", "sayuri", "sebastian", "seren", "shea",
  "shion", "shiro", "sibyl", "silas", "sloane", "sora", "soren", "sosuke", "stellan", "sumire",
  "sutton", "suzu", "sylvie", "taiga", "takumi", "talia", "tamsin", "tatsuya", "teal", "tessa",
  "thalia", "thea", "theo", "thorne", "tobias", "ulla", "ulric", "ursa", "vale", "vega",
  "verity", "vesper", "vidal", "viggo", "viola", "wendell", "wilder", "willa", "winter", "wolfe",
  "wren", "wystan", "xander", "xavier", "xenia", "xiomara", "yannick", "yara", "yolanda", "yuki",
  "yuma", "yumi", "yuna", "yusuf", "yuto", "zelda", "zeno", "zenon", "zephyr", "zora",
] as const;

/**
 * A stable offset into the pool, from arbitrary text.
 *
 * The multiplier and the `>>> 0` match `handleColour`, which needed the same
 * thing for names outside the pool. Not cryptographic and does not need to be:
 * a collision costs one probe forward.
 */
export function seedOffset(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 131 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Picks a name nobody has used recently, starting from `seed`.
 *
 * SCANNING FROM ZERO WASTES THE POOL: it issues names alphabetically and hands
 * back the one released most recently, which `NAME_REUSE_MS` exists to prevent.
 * A conversation uuid seeds it, so the same session asking twice gets the same
 * answer. Exhaustion yields a numbered name rather than a silent double-up.
 */
export function pickName(taken: ReadonlySet<string>, seed = ""): string {
  const start = seed === "" ? 0 : seedOffset(seed) % GIVEN_NAMES.length;
  for (let i = 0; i < GIVEN_NAMES.length; i++) {
    const name = GIVEN_NAMES[(start + i) % GIVEN_NAMES.length];
    if (name !== undefined && !taken.has(name)) return name;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${GIVEN_NAMES[(start + i) % GIVEN_NAMES.length]}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `agent${taken.size}`;
}

/**
 * What a subagent is called: `Hopper's Minion #1`.
 *
 * DERIVED, never stored, so renaming a parent renames its minions with it. The
 * number never resets: a log line naming `#2` must not later point elsewhere.
 * READ-ONLY — a minion cannot be addressed, so ask the PARENT.
 */
export function minionName(parent: string, seq: number): string {
  // `nameCase`, not `titleCase`: the roster indents this under the owner's own
  // name, which has to stay recognisable.
  const owner = nameCase(parent);
  // `Chris'`, not `Chris's`. No pool name ends in s, but a chosen one may.
  const possessive = owner.endsWith("s") ? `${owner}'` : `${owner}'s`;
  return `${possessive} Minion #${seq}`;
}

/**
 * A successor's name: `Vega, Hopper's Disciple`. The user asked for the whimsy,
 * and it is also the truthful form: a successor holds the knowledge and NOT the
 * transcript, so naming it `hopper` would point `blame` at the wrong
 * conversation. A resume needs no marking and returns the bare name.
 */
export function discipleName(name: string, master: string): string {
  const own = nameCase(name);
  const from = master.trim();
  if (from === "" || from.toLowerCase() === name.trim().toLowerCase()) return own;
  const teacher = nameCase(from);
  // The possessive rule `minionName` needs.
  const possessive = teacher.endsWith("s") ? `${teacher}'` : `${teacher}'s`;
  return `${own}, ${possessive} Disciple`;
}

/**
 * What the OPERATOR sees: "Luna — Tooling Master". NAME FIRST, because it is
 * the unique part that peers type and that stays put.
 *
 * READ-ONLY: `msg` takes the bare name, so this composed string resolves to
 * nobody. `slug` stands in when no role is set, and is the HANDLE rather than
 * Claude Code's `traffic-a9`, which yields roles nobody chose.
 */
export function fullName(name: string, role: string, slug: string): string {
  // The two halves take DIFFERENT casers: the suffix is prose and wants spaces
  // (`Water Dynamic`), the name must stay typeable (`Water-Dynamic`).
  const suffix = role.trim() !== "" ? role.trim() : titleCase(slug);
  const given = nameCase(name);
  // Compared WITHOUT separators for that reason, or one slug renders as
  // `Water-Dynamic — Water Dynamic`, telling the reader nothing twice.
  if (suffix === "" || bareName(suffix) === bareName(given)) return given;
  return `${given} — ${suffix}`;
}

/** For comparing a name to a role: case and separators carry no meaning here. */
function bareName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * `terrain-perf` -> `Terrain Perf`. FOR PROSE ONLY, never a name: it turns
 * separators into spaces, which yields the unaddressable two-word name that
 * validation refuses. Use `nameCase`. Capitalises INITIALS ONLY, or acronyms
 * like `a11y` and `GPU splat` get flattened.
 */
export function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((w) => w !== "")
    .map((w) => (w[0] ?? "").toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * `water-dynamic` -> `Water-Dynamic`. Capitalisation only; the separator stays.
 *
 * FOR NAMES, which are one word and must survive being read off the roster and
 * typed back at `msg`. `titleCase` would turn the hyphen into a space and hand
 * a peer something that no longer resolves.
 */
export function nameCase(name: string): string {
  return name.replace(/(^|[-_])([a-z])/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}
