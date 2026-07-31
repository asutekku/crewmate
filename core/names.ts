/**
 * Given names for agents, and the role that goes in front of one.
 *
 * WHY A NAME AND A ROLE RATHER THAN ONE LABEL. They do different jobs and want
 * opposite things. A name is what you TYPE (`msg luna`) — short, unique,
 * unquoted, and it must not move, because peers have learned it. A role is what
 * you READ ("Tooling Master") — evocative, several words, and free to change as
 * the work changes. Collapsing them forces `msg "Luna — Tooling Master"`, which is
 * miserable to type and breaks the quoting rules names are validated against.
 *
 * Keeping the name fixed while the role moves is the point: `Tooling Master
 * Luna` becoming `Luna — Tooling Intern` reads as a demotion rather than as a
 * stranger appearing on the roster. Measured motivation — this tool's own
 * conversation was relabelled `traffic-a0` -> `traffic-7c` -> `traffic-56`
 * across one afternoon, and nothing tied those three together for a reader.
 */

/**
 * How far back a name is considered taken.
 *
 * DELIBERATELY MUCH LONGER than any other lifetime here (`STALE_MS` is 90 min,
 * `CLAIM_TTL_MS` is 2 h): those answer "is this agent working?", and this
 * answers "would reusing this name confuse the person reading the log?". Sixty
 * hours is measured against real usage rather than guessed — background agents
 * were found alive 37 and 55 hours after starting, so a working day and a half
 * is the span over which one name coming back as a different agent would
 * actually mislead.
 */
export const NAME_REUSE_MS = 60 * 60 * 60 * 1000; // 60 h

/**
 * The pool: 280 names, alphabetical so a duplicate is visible when editing.
 *
 * Large because the eight-name list it replaces ran out at nine agents and
 * started emitting `agent-3f9c21`, and because a name is held for 60 hours after
 * its last use — so the pool has to cover a couple of days of churn, not just
 * the agents alive at one moment.
 *
 * Mixed origins on purpose: a single theme makes names blur together, which
 * defeats the one thing a name is for. A few are strict prefixes of another
 * (`kai`/`kaia`, `leon`/`leonie`, `zeno`/`zenon`) and that is harmless —
 * `findByName` matches exactly before it falls back to a prefix.
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
 * Picks a name nobody has used recently.
 *
 * Falls back to a numbered name rather than reusing one: with this many to
 * choose from, exhausting the pool means something is wrong (a hook looping, a
 * db never pruned), and a name that silently doubles up would hide it.
 */
export function pickName(taken: ReadonlySet<string>): string {
  const free = GIVEN_NAMES.find((n) => !taken.has(n));
  if (free !== undefined) return free;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${GIVEN_NAMES[i % GIVEN_NAMES.length]}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `agent${taken.size}`;
}

/**
 * What the OPERATOR sees: "Luna — Tooling Master".
 *
 * NAME FIRST. It is the identifier — the thing that is unique, that peers type,
 * and that stays put — so it belongs where the eye lands when scanning a column
 * of eight. Leading with the role put the varying, non-unique part first and
 * made the roster read as a list of job titles that happened to have names
 * attached; a dash separates them so neither reads as part of the other.
 *
 * READ-ONLY, and that is load-bearing. `msg` takes the bare name; a peer that
 * copied this string would be quoting three words at a command that expects one.
 * (A name MAY contain a space — `validateAlias` permits it — but the em-dash and
 * the role are not part of it, so the composed string does not resolve.)
 * Nothing accepts this as input.
 *
 * `slug` is a self-chosen name standing in when no role is set — `Turing —
 * Water Dynamic` — which keeps what those slugs were already good at: saying
 * what someone works on. It is never Claude Code's `traffic-a9`; using that
 * produced "Traffic A9 Terrain Perf", a role nobody chose, built from the one
 * label here that is not stable.
 *
 * The suffix is dropped when it would repeat the name, so an agent whose chosen
 * name IS its role does not read as the same word twice.
 */
export function fullName(name: string, role: string, slug: string): string {
  const suffix = role.trim() !== "" ? role.trim() : titleCase(slug);
  const given = titleCase(name);
  if (suffix === "" || suffix.toLowerCase() === given.toLowerCase()) return given;
  return `${given} — ${suffix}`;
}

/**
 * `terrain-perf` -> `Terrain Perf`, without destroying what is already there.
 *
 * Capitalises INITIALS ONLY and leaves the rest of each word alone, because
 * lowercasing first would flatten the acronyms that actually appear here:
 * `a11y`, `R4 core`, `GPU splat`. A name is not worth being clever about, but
 * it is worth not mangling.
 */
export function titleCase(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((w) => w !== "")
    .map((w) => (w[0] ?? "").toUpperCase() + w.slice(1))
    .join(" ");
}
