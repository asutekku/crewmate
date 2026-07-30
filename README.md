# Agent presence

Lets the 3–4 Claude Code sessions working in this repo see each other: who is
active, what each said it is doing, which files they have touched, and when one
finishes a turn. Sessions are otherwise completely blind to each other.

This is **notification, not enforcement**. Nothing here can stop an agent from
editing a file another agent is in — it makes the overlap visible so the agent
can apply the commit rules in `CLAUDE.md` (stage explicit paths, never
`git add .`, never stash) deliberately rather than by luck.

## What each agent sees

**At session start** — the roster, and recent log lines:

```
You are agent "turing" in this repo's shared presence log.
1 other agent(s) active:
  ada — Fix the water shore fade regression in render/ground (last active just now)
      editing: src/city/derive.ts
```

**On every prompt** — anything peers did since its last turn:

```
1 update(s) from other agents in this repo:
  [3m ago] ada done: finished a turn: Fixed the shore fade by depth-scaling the alpha ramp.
```

**Before an Edit/Write** — only when a live peer already claimed that path:

```
OVERLAP: src/city/derive.ts is also being edited by ada (claimed 2m ago).
```

**At the end of each turn** — publishes "finished a turn: <summary>" so peers can
answer "are they done?", and delivers any news that arrived mid-turn.

## Your view

```sh
bun .claude/hooks/presence/cli.ts who        # roster + claims
bun .claude/hooks/presence/cli.ts log 20     # recent messages
bun .claude/hooks/presence/cli.ts say "..."  # broadcast to every agent
bun .claude/hooks/presence/cli.ts clear      # wipe roster (log self-prunes)
```

`say` is the useful one: you are the only participant who sees all four sessions
at once, so it beats retyping a correction four times. It posts under the handle
`human` so agents can tell it from a peer.

## Files

| File | Role |
|---|---|
| `store.ts` | SQLite schema + all state access. The only file that knows SQL. |
| `shared.ts` | Payload reading, report formatting, `emit`. |
| `session-start.ts` | Register; inject roster. |
| `prompt-submit.ts` | Heartbeat; deliver unread; record stated task. |
| `pre-edit.ts` | Claim path; warn on peer overlap. |
| `turn-end.ts` | Publish turn completion; deliver mid-turn news. |
| `session-end.ts` | Deregister on clean exit. |
| `cli.ts` | Human inspection + broadcast. |

Registered in `.claude/settings.json`. State is one gitignored SQLite file at
`.claude/hooks/.state/presence.db`.

## Design notes

**SQLite, not markdown.** Four agents doing read-modify-write on one `.md` is a
lost-update race: two read the same text, the second write erases the first's
line — exactly the failure this exists to prevent. WAL mode lets every reader
proceed while one writer commits, so a hook never waits on a peer. Verified with
40 concurrent writes: no `SQLITE_BUSY`, no lost rows.

**One integer is the delivery model.** `messages.id` is monotonic and each
session stores the last id it was shown; "unread" is `id > last_read_id`. Read
and cursor-advance happen in one transaction, so two hooks racing on the same
session cannot both deliver the same message. A new session's cursor starts at
the current max, so it gets a deliberate `recent()` summary rather than a replay
of everything.

**Handles are reused.** Only *live* sessions reserve a name, so a 4-agent setup
stays on `ada/turing/hopper/lovelace` instead of drifting down the list on every
restart.

**Every hook fails open.** A locked db or malformed payload ends the hook
silently. Coordination is a convenience and must never break a session — the
same stance `typecheck.ts` takes.

**Nothing blocks.** `pre-edit` warns rather than denying: a path match cannot
answer "is this someone else's work?", and a wedged agent is worse than a visible
conflict. `turn-end` never uses `Stop`'s blocking form, which would trap a
session in a loop nobody asked for.

## Known limits

- **Messages land on turn boundaries** (prompt submit, turn end). A session deep
  in a long autonomous run does not see a peer's message until its current turn
  ends. There is no supported way to inject into a running turn; `turn-end.ts`
  narrows the gap but cannot close it.
- **Claims are per-path, not per-region.** Two agents in different functions of
  one large file still read as an overlap.
- **A stated task is the session's first prompt.** Later prompts do not update it
  (a follow-up like "now fix the test" is meaningless to a peer), so a
  long-running session's roster line can go stale. `cli.ts say` is the
  workaround.
- **Sessions that die uncleanly linger** until they miss the 90-minute staleness
  window (`STALE_MS` in `store.ts`). `cli.ts clear` forces it.
- **Claim history outlives a claim.** A departing session's rows are deleted, but
  log lines mentioning its edits remain until the log prunes.

## If you want it off

Delete the five presence blocks from `.claude/settings.json` (keep the
`PostToolUse` typecheck one). No other part of the repo imports any of this.
