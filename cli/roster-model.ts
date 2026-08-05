import type { AgentInfo } from "../core/agents.ts";
import { dirtyFiles } from "../core/dirty.ts";
import { backgroundProcesses } from "../core/layout.ts";
import type { Claim, Minion, Session, Store } from "../core/store.ts";
import { sanitizeTerminalText } from "./terminal.ts";

export const MAX_ROSTER_NAME_WIDTH = 34;
export const ROSTER_AGE_WIDTH = 4;
export const MIN_ROSTER_DESCRIPTION_WIDTH = 20;
export const ROSTER_INDENT_WIDTH = 2;
export const BACKGROUND_PROCESS_LIMIT = 8;

export interface RosterSnapshot {
  readonly sessions: readonly Session[];
  readonly claims: readonly Claim[];
  readonly minionsBySession: ReadonlyMap<string, readonly Minion[]>;
  readonly taskCounts: ReadonlyMap<
    string,
    { readonly open: number; readonly done: number }
  >;
  readonly codeVersions: ReadonlyMap<string, string>;
  readonly staleSummaries: readonly {
    readonly sessionId: string;
    readonly path: string;
  }[];
}

export interface ClaimIndex {
  readonly byHandle: ReadonlyMap<string, readonly Claim[]>;
  readonly byPath: ReadonlyMap<string, readonly Claim[]>;
  readonly contestedPaths: ReadonlySet<string>;
}

export interface RosterLayout {
  readonly width: number;
  readonly nameWidth: number;
  readonly ageWidth: number;
  readonly gutter: number;
  readonly descriptionWidth: number;
}

export interface Contention {
  readonly path: string;
  readonly holders: readonly Claim[];
  readonly sameTree: boolean;
}

export interface RosterView {
  readonly orderedSessions: readonly Session[];
  readonly groups: readonly (readonly [string, readonly Session[]])[];
  readonly treeCount: number;
  readonly claims: ClaimIndex;
  readonly contentions: readonly Contention[];
  readonly background: readonly AgentInfo[];
  readonly behind: readonly Session[];
  readonly layout: RosterLayout;
}

/** Store mutations required before a roster read, kept out of snapshot collection. */
export function synchronizeRosterStore(
  store: Store,
  agents: readonly AgentInfo[],
  now: number,
): void {
  store.pruneStale(now);
  if (agents.length > 0) store.syncAgents(agents);
  store.pruneMinions(now);
}

/** Collects one consistent set of store reads after synchronization has completed. */
export function collectRosterSnapshot(
  store: Store,
  now: number,
  summaryTtlMs: number,
): RosterSnapshot {
  return {
    sessions: store.liveSessions(now),
    claims: store.allClaims(now),
    minionsBySession: store.liveMinions(now),
    taskCounts: store.taskCounts(),
    codeVersions: store.codeVersions(),
    staleSummaries: store.staleSummarySessions(now, summaryTtlMs),
  };
}

export function indexClaims(
  claims: readonly Claim[],
  projectRoot: string,
  readDirtyFiles: typeof dirtyFiles = dirtyFiles,
): ClaimIndex {
  const byHandle = new Map<string, Claim[]>();
  const byPath = new Map<string, Claim[]>();
  for (const claim of claims) {
    const handleClaims = byHandle.get(claim.handle);
    if (handleClaims) handleClaims.push(claim);
    else byHandle.set(claim.handle, [claim]);
    const pathClaims = byPath.get(claim.path);
    if (pathClaims) pathClaims.push(claim);
    else byPath.set(claim.path, [claim]);
  }

  const dirtyByTree = new Map<string, ReadonlySet<string> | null>();
  const dirtyFor = (worktree: string): ReadonlySet<string> | null => {
    const tree = worktree || projectRoot;
    if (!dirtyByTree.has(tree)) dirtyByTree.set(tree, readDirtyFiles(tree));
    return dirtyByTree.get(tree) ?? null;
  };
  const contestedPaths = new Set<string>();
  for (const [path, holders] of byPath) {
    if (
      holders.length > 1 &&
      holders.some((holder) => {
        const dirty = dirtyFor(holder.worktree);
        return dirty === null || dirty.has(holder.path);
      })
    ) {
      contestedPaths.add(path);
    }
  }
  return { byHandle, byPath, contestedPaths };
}

export function calculateRosterLayout(
  sessions: readonly Session[],
  width: number,
  shownName: (session: Session) => string,
): RosterLayout {
  const longestName = Math.max(
    0,
    ...sessions.map((session) => [...sanitizeTerminalText(shownName(session))].length),
  );
  const nameWidth = Math.min(MAX_ROSTER_NAME_WIDTH, longestName);
  const gutter =
    ROSTER_INDENT_WIDTH + 1 + 1 + nameWidth + 1 + ROSTER_AGE_WIDTH + 2;
  return {
    width,
    nameWidth,
    ageWidth: ROSTER_AGE_WIDTH,
    gutter,
    descriptionWidth: Math.max(
      MIN_ROSTER_DESCRIPTION_WIDTH,
      width - gutter - 1,
    ),
  };
}

/**
 * Sessions by the tree they work in, EVERY tree named.
 *
 * The old rule keyed the most populated tree as `""` and the renderer printed
 * no header for it, so the majority sat under nothing while a minority tree got
 * an inline label — a reader could not tell whether that label headed the rows
 * below it or footed the rows above. The count said "2 trees" and the layout
 * then refused to say which agent was in which, though `sessions.worktree`
 * holds it exactly, per session.
 *
 * A session with no recorded worktree keys as `""` and renders as `unknown`;
 * silence is worse than admitting the gap.
 */
export function groupSessions(sessions: readonly Session[]): {
  readonly groups: readonly (readonly [string, readonly Session[]])[];
  readonly treeCount: number;
} {
  const trees = new Set<string>();
  const grouped = new Map<string, Session[]>();
  for (const session of sessions) {
    trees.add(session.worktree);
    const group = grouped.get(session.worktree);
    if (group) group.push(session);
    else grouped.set(session.worktree, [session]);
  }
  // Busiest tree first, then by path, so the ordering does not shuffle between
  // reads when two trees hold the same number of agents.
  const groups = [...grouped].sort(
    ([a, ga], [b, gb]) => gb.length - ga.length || a.localeCompare(b),
  );
  return { groups, treeCount: trees.size };
}

export function buildRosterView(input: {
  readonly snapshot: RosterSnapshot;
  readonly agents: readonly AgentInfo[];
  readonly projectRoot: string;
  readonly currentVersion: string;
  readonly raw: boolean;
  readonly width: number;
  readonly shownName: (session: Session) => string;
  readonly readDirtyFiles?: typeof dirtyFiles;
}): RosterView {
  const orderedSessions = [...input.snapshot.sessions].sort(
    (a, b) => b.lastSeenMs - a.lastSeenMs,
  );
  const claims = indexClaims(
    input.snapshot.claims,
    input.projectRoot,
    input.readDirtyFiles,
  );
  const grouped = groupSessions(orderedSessions);
  const contentions = [...claims.contestedPaths].sort((a, b) => a.localeCompare(b)).map((path) => {
    const holders = claims.byPath.get(path) ?? [];
    return {
      path,
      holders,
      sameTree: new Set(holders.map((claim) => claim.worktree)).size === 1,
    };
  });
  const registered = new Set(
    orderedSessions.map((session) => session.sessionId),
  );
  const background =
    input.agents.length > 0
      ? backgroundProcesses(input.agents, registered, input.projectRoot)
      : [];
  const behind = orderedSessions.filter((session) => {
    const version = input.snapshot.codeVersions.get(session.sessionId) ?? "";
    return Boolean(
      input.currentVersion && version && version !== input.currentVersion,
    );
  });
  return {
    orderedSessions,
    groups: grouped.groups,
    treeCount: grouped.treeCount,
    claims,
    contentions,
    background,
    behind,
    layout: calculateRosterLayout(
      orderedSessions,
      input.width,
      input.shownName,
    ),
  };
}
