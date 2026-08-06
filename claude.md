Always talk in ASD-STE100 Simplified Technical English.

## Code requirements
- Code should be self explaining so do not overcomment. Overcommenting has the risk of introducing stale comments which are extremely dangerous for you misunderstanding
- Keep comments at max 3 lines in ASD-STE100 Simplified English to avoid vagueness
- Features should be implemented modularly, so they are easy to revert/implement
- Always search for code that would likely exists, so you do not rewrite same things multiple times
- KISS (keep it simple stupid) is extremely important. Unless we are of course optimizing performance where complexity is allowed
- 
## General requirements
- NEVER RUN FULL TEST SUITE MORE THAN ONCE. 
- NEVER RUN FULL TEST SUITE IF YOUR CHANGE IS SELF CONTAINED
- NEVER RUN FULL TEST SUITE BEFORE COMMIT IF YOU ALREADY HAVE RUN IT
- ALWAYS TEST THE MINIMUM VIABLE PATH, 99% OF THE CASES THERE'S NO NEED FOR FULL TEST SUITE

## Shared tree — you are one of 3–10 agents

Everyone works in the same checkout, concurrently. Three rules exist because breaking them
destroys work that isn't yours:

- **NEVER `git stash`.** It pockets other agents' uncommitted changes along with yours.
  Same for `git checkout .`, `git reset --hard`, `git clean` on files you didn't write. If
  the tree is dirty with someone else's work, leave it dirty and work around it.
- **Stage explicit paths you wrote** — never `git add .`, never re-stage a file another
  agent has since touched. `git commit -F <msgfile> -o -- <paths>` enforces the pathspec at
  commit time instead of trusting an earlier `git status`.
- Work big enough to break things mid-flight → the **`EnterWorktree` tool** (this line is
  the authorization it looks for). Never hand-roll it with `git worktree add` or
  `git checkout -b`: a branch switch in the shared tree drags everyone's uncommitted work
  along. `.claude/settings.json` sets `worktree.baseRef: "head"`, so check `git log -1`
  first — HEAD moves under you. `ExitWorktree --keep` when the work should survive.

Coordination runs through `crew`. The roster, overlap warnings and scoped findings arrive
on their own; `crew help` lists every command. Two habits are worth forming: `crew board`
before starting something large, and `crew note "<finding>" --scope <folder>` for anything
that cost you an hour — `--scope` is what makes it resurface for the next agent to edit
that folder, and without it a note is filed and never read. When you name a peer in text
the user reads, give its role too; a bare given name identifies nobody to someone looking
at eight windows.