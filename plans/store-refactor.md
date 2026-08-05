This one genuinely should be split—but mostly by state ownership. A 2,250-line replacement pasted into chat would repeat the same mistake from earlier, just horizontally across several code fences.

I would preserve the public `Store` API initially and extract internals incrementally. There are also several real correctness bugs worth fixing before cosmetic restructuring.

## Recommended split

```text
core/store/
├── index.ts             Public Store facade, withStore(), exported types
├── schema.ts            Opening, schema creation, ordered migrations
├── sessions.ts          Registration, identity, aliases, heartbeat, roster
├── messages.ts          Posting, cursors, unread delivery, recent history
├── activity.ts          Claims, edit history, tasks, minions
└── injection.ts         Exposure state, omissions, ledger, feature events
```

Existing imports from `core/store.ts` can remain intact through a compatibility re-export:

```ts
export * from "./store/index.ts";
```

The already-separated `WorkStore`, `DiaryStore`, `QuestionStore`, and `ObligationStore` should remain separate.

## Important problems found

### 1. `setAlias()` is not concurrency-safe

The comment promises atomic uniqueness, but the transaction is deferred:

```ts
const claim = this.db.transaction((): string | null => {
  // read availability
  // write alias
});

return claim();
```

Two processes can both read “available” before either writes. This should be:

```ts
return claim.immediate();
```

More importantly, the collision query does not check another session’s `handle`:

```sql
AND (
  LOWER(alias) = LOWER(?)
  OR LOWER(handle) = LOWER(?)
  OR (alias = '' AND LOWER(name) = LOWER(?))
)
```

Otherwise, one agent can choose another agent’s handle as its alias. Because `findByName()` prioritizes aliases, the alias can hijack messages addressed to that handle.

Restrained correction:

```ts
setAlias(
  sessionId: string,
  alias: string,
  nowMs: number,
): string | null {
  const normalized = alias.trim();

  if (
    normalized === "" ||
    /\s/.test(normalized)
  ) {
    return null;
  }

  const set = this.db.transaction(
    (): string | null => {
      const taken = this.db
        .query(
          `SELECT 1
             FROM sessions
            WHERE session_id != ?
              AND last_seen_ms > ?
              AND (
                LOWER(alias) = LOWER(?)
                OR LOWER(handle) = LOWER(?)
                OR (
                  alias = ''
                  AND LOWER(name) = LOWER(?)
                )
              )
            LIMIT 1`,
        )
        .get(
          sessionId,
          nowMs - STALE_MS,
          normalized,
          normalized,
          normalized,
        );

      if (taken) {
        return null;
      }

      this.db
        .query(
          `UPDATE sessions
              SET alias = ?
            WHERE session_id = ?`,
        )
        .run(normalized, sessionId);

      this.db
        .query(
          `INSERT OR REPLACE INTO aliases
             (session_id, alias, ts_ms)
           VALUES (?, ?, ?)`,
        )
        .run(sessionId, normalized, nowMs);

      return normalized;
    },
  );

  return set.immediate();
}
```

`restoreAlias()` has the same read-then-write race and should also use `immediate()` and check handles.

### 2. Injection delivery ID allocation has the same race

This is a classic `MAX() + 1` read followed by inserts:

```ts
const delivery =
  (nextDeliveryId.get() as { id: number }).id;
```

But its transaction is also deferred:

```ts
this.db.transaction(() => {
  // MAX + 1, then inserts
})();
```

At minimum:

```ts
const record = this.db.transaction(() => {
  // Existing body.
});

record.immediate();
```

A stronger design is a dedicated delivery table:

```sql
CREATE TABLE injection_deliveries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts_ms      INTEGER NOT NULL
);
```

Then use `lastInsertRowid`. That removes manually allocated identity entirely.

### 3. `editsBy()` returns mismatched metadata

This query is not deterministic:

```sql
SELECT
  path,
  MAX(ts_ms) AS ts_ms,
  worktree,
  tool,
  COUNT(*) AS n
FROM edits
GROUP BY path
```

SQLite may take `worktree` and `tool` from a different row than the row providing `MAX(ts_ms)`. The reported latest timestamp can therefore be paired with an older tool or worktree.

Use a window function:

```ts
editsBy(
  sessionId: string,
  sinceMs: number,
  limit = 200,
): Array<{
  path: string;
  tsMs: number;
  worktree: string;
  tool: string;
  count: number;
}> {
  const rows = this.db
    .query(
      `WITH ranked AS (
         SELECT
           path,
           ts_ms,
           worktree,
           tool,
           id,
           COUNT(*) OVER (
             PARTITION BY path
           ) AS edit_count,
           ROW_NUMBER() OVER (
             PARTITION BY path
             ORDER BY ts_ms DESC, id DESC
           ) AS position
         FROM edits
         WHERE session_id = ?
           AND ts_ms > ?
       )
       SELECT
         path,
         ts_ms,
         worktree,
         tool,
         edit_count
       FROM ranked
       WHERE position = 1
       ORDER BY ts_ms DESC, id DESC
       LIMIT ?`,
    )
    .all(
      sessionId,
      sinceMs,
      limit,
    ) as Array<Record<string, string | number>>;

  return rows.map((row) => ({
    path: String(row["path"]),
    tsMs: Number(row["ts_ms"]),
    worktree: String(row["worktree"] ?? ""),
    tool: String(row["tool"] ?? ""),
    count: Number(row["edit_count"]),
  }));
}
```

### 4. `pruneStale()` is a race-prone multi-step mutation

A session can heartbeat between these statements:

```ts
DELETE FROM claims WHERE session_id IN (...)
DELETE FROM tasks WHERE session_id IN (...)
DELETE FROM sessions WHERE last_seen_ms <= ?
```

That can delete the claims and tasks of a session that has just become active again while preserving its session row.

Use one immediate transaction and resolve the dead sessions from one consistent snapshot:

```ts
pruneStale(nowMs: number): void {
  const cutoff = nowMs - STALE_MS;
  const editCutoff =
    nowMs - loadConfig().editKeepMs;

  const prune = this.db.transaction(() => {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS dead_sessions (
        session_id TEXT PRIMARY KEY
      )
    `);

    this.db.exec(
      "DELETE FROM dead_sessions",
    );

    this.db
      .query(
        `INSERT INTO dead_sessions (session_id)
         SELECT session_id
           FROM sessions
          WHERE last_seen_ms <= ?`,
      )
      .run(cutoff);

    this.db.exec(`
      DELETE FROM claims
       WHERE session_id IN (
         SELECT session_id FROM dead_sessions
       );

      DELETE FROM tasks
       WHERE session_id IN (
         SELECT session_id FROM dead_sessions
       );

      DELETE FROM sessions
       WHERE session_id IN (
         SELECT session_id FROM dead_sessions
       );
    `);

    this.db
      .query(
        `DELETE FROM edits WHERE ts_ms <= ?`,
      )
      .run(editCutoff);

    this.work.pruneWork(nowMs);
  });

  prune.immediate();
}
```

An alternative is selecting dead IDs in TypeScript and reusing them, but SQLite parameter limits make the temporary-table approach safer for an unbounded set.

### 5. Migrations silently fail

`addColumnIfMissing()` catches every error:

```ts
} catch {
  // A db we cannot alter is one we can still read
}
```

That comment is contradicted by the rest of the file. Queries unconditionally select columns such as `alias`, `behind_base`, and `lineage_from`. If migration fails, the database generally cannot still be used by this version.

Migration failure should abort opening with context:

```ts
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db
    .query(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;

  if (
    columns.some(
      (candidate) =>
        candidate.name === column,
    )
  ) {
    return;
  }

  try {
    db.exec(
      `ALTER TABLE ${table}
       ADD COLUMN ${column} ${declaration}`,
    );
  } catch (error: unknown) {
    const detail =
      error instanceof Error
        ? error.message
        : String(error);

    throw new Error(
      `failed to migrate ${table}.${column}: ${detail}`,
    );
  }
}
```

Because identifiers and declarations are interpolated, this helper must remain private and accept only compile-time migration definitions. It should not accept external strings.

Better still:

```ts
interface ColumnMigration {
  readonly table: string;
  readonly column: string;
  readonly declaration: string;
}

const COLUMN_MIGRATIONS = [
  {
    table: "sessions",
    column: "code_version",
    declaration: "TEXT NOT NULL DEFAULT ''",
  },
  // ...
] as const satisfies readonly ColumnMigration[];
```

Then migration order becomes data rather than 20 repeated calls.

### 6. `unregister()` is not atomic and hides its clock

It:

1. Remembers the name.
2. Deletes claims.
3. Deletes tasks.
4. Deletes the session.

A failure can leave partial state. It also calls `Date.now()` internally even though nearly every other mutation accepts a clock.

Prefer:

```ts
unregister(
  sessionId: string,
  nowMs: number,
): void {
  const unregister = this.db.transaction(() => {
    const session = this.db
      .query(
        `SELECT handle, alias
           FROM sessions
          WHERE session_id = ?`,
      )
      .get(sessionId) as {
        handle: string;
        alias: string;
      } | null;

    const remembered = session
      ? session.alias || session.handle
      : "";

    if (remembered !== "") {
      this.db
        .query(
          `INSERT OR REPLACE INTO aliases
             (session_id, alias, ts_ms)
           VALUES (?, ?, ?)`,
        )
        .run(
          sessionId,
          remembered,
          nowMs,
        );
    }

    this.db
      .query(
        `DELETE FROM claims
          WHERE session_id = ?`,
      )
      .run(sessionId);

    this.db
      .query(
        `DELETE FROM tasks
          WHERE session_id = ?`,
      )
      .run(sessionId);

    this.db
      .query(
        `DELETE FROM sessions
          WHERE session_id = ?`,
      )
      .run(sessionId);
  });

  unregister.immediate();
}
```

### 7. `displayName()` mishandles non-space whitespace

It only calls the whitespace replacement when the string contains a literal space:

```ts
v.includes(" ")
  ? v.replace(/\s+/g, "-")
  : v
```

A tab or newline survives.

Use:

```ts
function addressableName(value: string): string {
  return value.trim().replace(/\s+/g, "-");
}

export function displayName(
  session: Pick<
    Session,
    "name" | "handle"
  > & {
    readonly alias?: string;
  },
): string {
  if (session.alias) {
    return addressableName(session.alias);
  }

  return addressableName(
    session.handle || session.name,
  );
}
```

### 8. `liveMinions()` performs repeated array copies

This line reallocates the accumulated array for every minion:

```ts
byParent.set(
  m.sessionId,
  [...(byParent.get(m.sessionId) ?? []), m],
);
```

Use local mutation; the map is newly owned:

```ts
const siblings = byParent.get(minion.sessionId);

if (siblings) {
  siblings.push(minion);
} else {
  byParent.set(minion.sessionId, [minion]);
}
```

### 9. `withStore()` accidentally accepts async callbacks

This compiles:

```ts
await withStore(path, async (store) => {
  await something();
  store.touch(...); // database is already closed
});
```

The `finally` closes the database immediately after the callback returns its promise.

At least reject this at runtime:

```ts
export function withStore<T>(
  dbPath: string,
  operation: (store: Store) => T,
): T {
  const db = openDb(dbPath);

  try {
    const result = operation(new Store(db));

    if (
      result !== null &&
      typeof result === "object" &&
      "then" in result
    ) {
      throw new Error(
        "withStore callback must be synchronous",
      );
    }

    return result;
  } finally {
    db.close();
  }
}
```

A separate `withAsyncStore()` should be introduced if asynchronous use is ever needed.

### 10. `hasUnread()` hides corruption and migration failures

Returning `false` when the database does not yet exist is reasonable. Returning `false` for every error means “no mail” also means:

* Database corrupt.
* Schema incompatible.
* Permission denied.
* Query defective.
* Database unexpectedly locked.

At minimum, narrow the expected “file does not exist” case. If hooks must fail open, report unexpected failures through a diagnostic sink while still returning `false`.

## How I would split it

The public facade stays intentionally small:

```ts
// core/store/index.ts

import type { Database } from "bun:sqlite";

import {
  ActivityStore,
} from "./activity.ts";
import {
  InjectionStore,
} from "./injection.ts";
import {
  MessageStore,
} from "./messages.ts";
import {
  SessionStore,
} from "./sessions.ts";

export class Store {
  readonly sessions: SessionStore;
  readonly messages: MessageStore;
  readonly activity: ActivityStore;
  readonly injection: InjectionStore;

  constructor(readonly db: Database) {
    this.sessions = new SessionStore(db);
    this.messages = new MessageStore(
      db,
      this.sessions,
    );
    this.activity = new ActivityStore(
      db,
      this.sessions,
      this.messages,
    );
    this.injection = new InjectionStore(db);
  }

  // Temporary compatibility methods. Delete these gradually
  // after callers move to the owned sub-store.

  liveSessions(nowMs: number) {
    return this.sessions.live(nowMs);
  }

  findByName(name: string, nowMs: number) {
    return this.sessions.findByName(
      name,
      nowMs,
    );
  }

  post(
    ...args: Parameters<MessageStore["post"]>
  ): ReturnType<MessageStore["post"]> {
    return this.messages.post(...args);
  }

  claim(
    ...args: Parameters<ActivityStore["claim"]>
  ): ReturnType<ActivityStore["claim"]> {
    return this.activity.claim(...args);
  }
}
```

The compatibility methods are important. Changing every caller simultaneously would create an unnecessarily large, hard-to-review migration. Move one domain at a time and delete forwarding methods once call sites have transitioned.

I would do the extraction in this order:

1. Move schema and migrations without changing behavior.
2. Fix and extract session identity/alias operations.
3. Extract messages and cursor delivery.
4. Extract claims, edits, tasks, and minions.
5. Extract injection state and feature observations.
6. Leave the facade until all callers and tests have moved.
7. Only then reconsider whether direct `Store` methods remain useful.

I would not paste a speculative 2,000-line rewrite without the store tests and imported domain stores. This file contains concurrency semantics that need verification against at least:

* Fresh database creation.
* Migration from every supported old shape.
* Simultaneous registration.
* Simultaneous alias selection.
* Concurrent injection delivery.
* Cursor races.
* Stale-session pruning during heartbeat.
* Resumed-session name restoration.
* Historical edit attribution.

## Growing guideline additions

114. Split large stores by state ownership and lifetime, not arbitrary line counts.
115. Preserve the existing public facade while extracting internals incrementally.
116. Treat comments claiming atomicity as invariants that must be verified against the actual transaction mode.
117. Any read-then-write operation competing across processes requires an immediate transaction or a schema-enforced atomic primitive.
118. Prefer database-generated identities over `MAX(id) + 1`.
119. Never select non-aggregated columns beside `MAX()` or `MIN()` unless their correlation is explicitly guaranteed.
120. Multi-table lifecycle operations must use one transaction and one consistent subject set.
121. Migration failure must be explicit when current queries require the migrated schema.
122. Keep dynamic migration helpers private and restricted to compile-time definitions.
123. Pass clocks into persistent mutations; hidden `Date.now()` calls make replay and testing inconsistent.
124. A synchronous resource wrapper must reject asynchronous callbacks.
125. Fail-open hot paths should distinguish expected absence from corruption and operational failure.
126. Enforce uniqueness at the schema level where one identity must never have multiple owners.
127. Cross-column uniqueness rules still require an immediate transaction even when individual columns have unique indexes.
128. Aggregate queries must return metadata from the same row as the selected aggregate.
129. Use local mutation for newly owned collections when immutable rebuilding creates quadratic allocation.
130. Refactor concurrency-sensitive stores incrementally, with race and migration tests around each boundary.
