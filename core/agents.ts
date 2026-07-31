/**
 * Claude Code's own view of the running sessions, via `claude agents --json`.
 *
 * WHY BOTHER, GIVEN WE ALREADY TRACK SESSIONS: it knows two things this system
 * cannot invent. The NAME (`traffic-12`, `water-sim-timberborn-f7`) is the label
 * already on your terminal, so a roster using it matches the windows in front of
 * you — far better than a handle we made up. And `idle`/`busy` is ground truth
 * about whether a peer is mid-turn, which is exactly what "have they finished?"
 * means and what our last-seen heartbeat can only guess at.
 *
 * MEASURED AT ~950 ms PER CALL, so it must never sit on a per-prompt path (the
 * other hooks run in ~72 ms). It is called at SessionStart, which is rare and
 * already slow, and on demand from the CLI. Everything else reads the cached
 * name/status columns.
 */

export interface AgentInfo {
  readonly sessionId: string;
  readonly name: string;
  /** `idle` or `busy`. */
  readonly status: string;
  readonly cwd: string;
}

/** Shape we rely on; anything else in the payload is ignored by design. */
function parseAgents(text: string): AgentInfo[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) return [];
  const out: AgentInfo[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const sessionId = typeof r["sessionId"] === "string" ? r["sessionId"] : "";
    if (sessionId === "") continue;
    out.push({
      sessionId,
      name: typeof r["name"] === "string" ? r["name"] : "",
      status: typeof r["status"] === "string" ? r["status"] : "",
      cwd: typeof r["cwd"] === "string" ? r["cwd"].replace(/\\/g, "/") : "",
    });
  }
  return out;
}

/**
 * Returns [] on any failure — an old CLI without the subcommand, a slow or
 * missing binary, malformed output. The roster then falls back to handles and
 * heartbeat, which is a worse view but a working one.
 */
export function listAgents(timeoutMs = 4000): AgentInfo[] {
  try {
    const proc = Bun.spawnSync(["claude", "agents", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
    });
    if (proc.exitCode !== 0) return [];
    return parseAgents(proc.stdout.toString());
  } catch {
    return [];
  }
}
