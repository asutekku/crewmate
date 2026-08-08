# Operating — configuration, cost, limits

[← README](../README.md)

## Configuration

Optional, at `~/.claude/agent-presence/config.json`. Every value has a default that applies when the file is missing, unreadable, or malformed — it is read on hook paths, so a typo must degrade rather than take a session's edit with it, and defaults apply **per field** so one bad line cannot revert the rest.

A repo can override these per key in `<root>/.claude/crew.json` under `tunables` (written by `crew init`, editable by hand). The merge order is DEFAULTS ← `config.json` ← repo `tunables`, per field, with the same degradation rules. The repo file wins because coordination knobs are team knowledge; a personal `config.json` still governs every repo without one. `crew.json`'s other keys (`generated`, `hot`, `checks`, `testPolicy`) describe the repo's shape for the hooks — see the README's "Init a repo".

| Key                 | Default | What it bounds                                        |
| ------------------- | ------- | ----------------------------------------------------- |
| `staleMs`           | 90 min  | a session with no heartbeat is treated as gone        |
| `claimTtlMs`        | 2 h     | how long a claim means "I am working on this"         |
| `claimReannounceMs` | 30 min  | how long an overlap announcement stays "already said" |
| `workKeepMs`        | 7 days  | how long a **closed** work record is kept             |
| `editKeepMs`        | 30 days | how long edit history is kept                         |

**Before anything destructive, `crew export [path]`.** It copies the store — including the write-ahead log, which the db file alone can be missing rows without — to a path you name, defaulting to `<project>-<timestamp>.db` in the working directory. `clear`, `quit`, `forget` and `done --abandoned` all remove state; this is the only thing that gets it back.

`clear` and `quit` now refuse to act silently. Bare `crew clear` lists the sessions and claim counts that *would* go and stops; `--force` performs it. `crew quit <name>` on a session whose process is still running refuses and names the pid, because "drop a dead session" was a guarantee the code never kept — there is no liveness check, only Claude Code's own process list.

**Obligations expire only if given a deadline.** `--until 4h` (also `30m`, `2d`) records an automatic boundary that the session-start sweep can fire; `--until "the release lands"` stays prose and waits for a human. The distinction is load-bearing: an obligation with no deadline outlives every session that cared about it, sitting above the roster in its target's injection. At most five obligations are injected at once — the rest collapse to a count pointing at `crew obligations`.

**The message log is not on this table, and that is the point.** It is pruned by **row count, not age**: `core/store/messages.ts` deletes on every insert, keeping the newest `MAX_MESSAGES` (2000, `core/store/types.ts`). There is no config key and no time horizon — a busy repo silently loses a day of messages, a quiet one keeps them forever. `crew clear`'s "(Message log is kept; it self-prunes.)" means this ring buffer, nothing else.

That interacts badly with the obligation ledger, which is **permanent**: obligation events are append-only and never pruned, so a `withdraw` whose reason reads *"answered over msg"* cites evidence that will eventually be evicted. The same holds for `correct` and `breaks`, whose whole purpose is answering "who changed the baselines?" days later. **Treat `log` as ephemeral**: if a justification needs to outlive the buffer, put it in the obligation's own `--resolution` or in the diary, not in a message the ledger merely points at.

`editKeepMs` is the longest because it is the only one answering a question about the past. There is no "off": an append-only table on a repo with 36 worktrees is how this gets slow, and the honest knob is _how long_, not _whether_.

## Cost

Hooks are synchronous — every one blocks its agent. Measured 2026-07-31:

| Path                                            | Cost       | Frequency                              |
| ----------------------------------------------- | ---------- | -------------------------------------- |
| bare Bun startup                                | **52 ms**  | the floor for every hook               |
| `PostToolBatch`, nothing to deliver             | **76 ms**  | after each tool batch                  |
| `SessionStart` (samples `claude agents --json`) | ~1 s       | once per session                       |
| reading the transcript title                    | **0.4 ms** | per prompt                             |
| everything else                                 | ~72 ms     | rare (per turn, per `cd`, per failure) |

`PostToolBatch` is the only one on a hot path: ~0.3 s per turn over 5 batches, ~2.2 s over 30. Acceptable beside this repo's 7 s-per-edit typecheck hook, but not free — if it bites, the fix is fewer firings, not a faster script.

Two things were tried and rejected on measurement: `bun build --compile` (85 ms, **slower** than the script, for a 98 MB binary per hook), and calling `claude agents --json` anywhere per-prompt (950 ms). Caching the git-derived project paths took `PostToolBatch` from 93 ms to 76 ms.

Reading the conversation title is 0.4 ms because it never parses the transcript: it scans a fixed 256 KB tail with a regex, so the cost is flat in file size — measured across 25 real transcripts, the largest 25 MB.

**The summariser's own `claude -p` is a real session**, so it fires SessionStart and UserPromptSubmit like any other and registered itself as a peer — five refreshes put five agents on the roster whose stated task was the summariser's prompt, _"You label background jobs."_ They held handles and could have raised overlap warnings against genuine work. Every hook now exits silently when `PRESENCE_INTERNAL=1`, checked in `readPayload` so the guard sits at one seam rather than in twelve entry points.

Those five persisted only because a timeout killed the call: `proc.kill()` terminates the child before its own `SessionEnd` can run, stranding the row permanently. Nothing this tool spawns should ever be killed while it holds a roster row.

**The `doing:` summary is the one thing here that spends tokens**, at ~8 s of Haiku per call, so it never runs on a hook path. `who` spawns a detached worker and prints immediately; the result lands for the next `who`. It is throttled to one refresh per session per 15 minutes, so a roster you check repeatedly costs nothing extra, and an idle session is summarised at most four times an hour. Delete `core/summary.ts`'s call site and the rest of the tool is unaffected — the title half is free and independent.

## Known limits

- **Nothing wakes an idle session.** A session sitting at a prompt runs no hooks. `PostToolBatch` closes the gap for a _busy_ agent — the one actually editing — but an idle peer reads its mail whenever you next prompt it.
- **Claims are per-path, not per-region.** Two agents in different functions of one large file still read as an overlap.
- **Only files inside the tree are claimed.** A scratchpad note or a file under `~/.claude` cannot collide with a peer, and claiming them buried the real in-repo claims under 100-character temp paths.
- **A stated task is the most recent prompt that names a topic.** It used to be the FIRST such prompt, so the column described what a session was asked once rather than what it is doing. Across four live sessions that rule produced one agent frozen on its opening question while working on something else, one frozen on an _answer it had given_, and two blank — nothing current. A stale label is worse than a moving one, because a peer reads the roster to decide whether to interrupt.

Prompts that are pure filler — "Lovely, start working on it." — set nothing, because a _resumed_ session's opening prompt is usually an acknowledgement of a conversation the roster never saw. With three live sessions on 2026-07-31 all three stated tasks were exactly that shape, so the roster's headline column described nothing.

Pasted terminal output is rejected for the same reason: leaving the slot open meant the next prompt could fill it, and a pasted `crew log` promptly became a session's "stated task". A session with no stated task shows **nothing** in that column — the `editing` line beneath already names its files, and a summary there would be a strict subset of the detail directly below it.

- **A session's worktree is corrected from the cwd of each edit**, not trusted from session start. `SessionStart`'s cwd is where the session was _launched_ and `CwdChanged` only fires on an actual `cd`, so an agent working in a worktree it did not cd into was recorded in the main tree indefinitely. Observed 2026-07-31: a session editing files that exist **only** in `.claude/worktrees/…` was listed on master, which inverts `pre-edit.ts`'s same-tree/cross-worktree classification and made it report a cross-worktree overlap as an on-disk collision. Wrong advice is worse than none.
- **A session runs the hooks it loaded at start.** `install.ts` stamps a build hash into `bin/VERSION`, recorded per session, and the roster marks any session on an older build `⟲ old hooks` — it needs a restart, not debugging.
- **Sessions that die uncleanly linger** until they miss the 90-minute staleness window (`STALE_MS` in `store.ts`); `crew who` prunes them as a side effect. A session reaped while still alive is no longer lost — any hook firing re-registers it, because a firing hook proves the session is running.
- **`bun` must be on PATH.** The registered command is `bun`, not an absolute path, so one settings file works on all three platforms.
- **Scripts are copied, not linked.** The hooks RUN from `~/.claude/agent-presence/bin/`; editing the copy in this repo changes nothing until `bun install.ts --force` copies it over. Testing a fix against `~/.claude/agent-presence/bin/cli.ts` before reinstalling exercises the OLD code, and it passes or fails for the wrong reason.

## Planned

Where the work is going, and what is deliberately not moving:

| Area                                                        | Status                       |
| ----------------------------------------------------------- | ---------------------------- |
| shared findings, topics, tags, scopes, FTS                  | shipped                      |
| the work board, landed commits, breaks/needs                | shipped                      |
| obligations, message semantics, the injection budget        | shipped                      |
| `crew init` — per-repo config, the CLAUDE.md block           | shipped                      |
| generated `--help`, questions, bug state + `--fixes`        | partly shipped               |
| memory that outlives a uuid, disciple naming, handoff       | partly shipped               |
| which agents work well together                             | deferred — measured, no data |

Status is re-measured **against the code**, never against what a spec last said about itself. An internal plan once carried four `[x] IMPLEMENTED` markers for phases nobody had written, which is why the claim above is worth distrusting until you have run the verb.
