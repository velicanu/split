# Split — development notes

While in the pure development stage, prefer simple where possible. If a decision
can be made later, defer it to later unless it's actually needed now. Rewriting
is cheaper than overengineering the wrong patterns too early.

## Running the tests

`npm test` in `pwa/`, and `pytest server` from the root. The node suite runs
with `--test-concurrency=1`: the default parallel run has repeatedly wedged
development machines, and the suite takes about five seconds either way.

## Testing practice

Changes to the fold, the split maths, or anything the server enforces get a
**mutation pass**: break the line on purpose, confirm a test fails, restore.
A surviving mutation is either a missing test or a line that does nothing —
both worth knowing, and worth saying which in the PR.

Two ways this has produced false results, both worth avoiding:

- `git checkout --` does nothing at all on an **untracked** file, silently.
- It restores from the index, so with a fix **unstaged** it reverts the fix
  rather than the mutation.

Stage the tree before mutating, and check the restore actually restored.
