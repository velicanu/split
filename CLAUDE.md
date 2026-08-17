# Split — development notes

Prefer simple where possible. If a decision can be made later, defer it to
later unless it's actually needed now. Rewriting is cheaper than overengineering
the wrong patterns too early.

**There are live users.** That does not change the taste above — it changes what
is disposable. Code and interfaces still are. **Data is not.** A schema change
needs a migration that carries the data across; `check_schema_version` refuses to
start on an unmigrated database rather than dropping it, and there is no path
that deletes user data to make a deploy go through. Anything written before this
that says data resets on deploy is out of date, not a policy you can follow.

The consequence is worth knowing before you bump `SCHEMA_VERSION`: `deploy.sh`
runs from a timer, so an unmigrated deploy leaves the container failing to start
and the service down until a migration lands. That is the intended trade — an
outage is recoverable and a dropped ledger is not — but it means the migration
ships *with* the schema change, not after it.

## Running things

```
pwa/ $ npm test          # 244 unit tests, single-threaded
      $ npm run build
      $ npm run dev      # vite, for a browser
   .  $ .venv/bin/pytest server -q
      $ .venv/bin/ruff format --check . && .venv/bin/ruff check .
      $ scripts/live.sh  # client against a real server, see below
```

`--test-concurrency=1` is not optional. The parallel default has repeatedly
wedged development machines badly enough to need a restart, and the suite takes
about five seconds either way.

If anything python dies with **`bad interpreter: No such file or directory`**,
the venv is fine but its interpreter is gone: `.venv/bin/python` symlinks into
uv's python install dir, which on some machines lives under `/tmp` and is wiped
between sessions. `rm -rf .venv && uv sync`. Not a broken checkout.

## Testing practice

### A fake server only agrees with whoever wrote it

The unit suites drive a hand-written fake of our own API. That is fast and
worth keeping, but it cannot tell you the client and server disagree — and two
bugs have shipped in exactly that gap, both green in CI:

- `post_event` refused every `member.*` type while the client wrote
  `member.ghost_added` and `member.left`. Adding a ghost, inviting anyone, and
  leaving a group all 400'd in production.
- `logout` kept the device key, so a refresh signed you straight back in. The
  test environment had no `localStorage` at all, so nothing could have failed.

**`scripts/live.sh`** closes that gap: it starts a real uvicorn on a scratch
database and runs `pwa/test/live.test.jsx`, which drives the real client
modules — real crypto, real IndexedDB, real fetch — against it. Run it before
opening a PR that changes anything crossing the client/server boundary.

It only asserts things a fake cannot: that the server accepts what the client
writes, that a claim survives a join, that ciphertext is opaque on the wire.
Do not mirror unit tests into it.

`server/test_main.py::CLIENT_WRITTEN_EVENTS` is the companion guard — every
event type the client writes, asserted accepted. **Add to it when the client
learns a new one.**

### Mutation passes

Changes to the fold, the split maths, or anything the server enforces get a
mutation pass: break the line on purpose, confirm a test fails, restore. A
surviving mutation is either a missing test or a line that does nothing — both
worth knowing, and worth saying which in the PR.

Two ways this has silently produced meaningless numbers, both `git checkout --`
appearing to restore a file it did not:

- on an **untracked** file it does nothing at all, and says nothing;
- it restores **from the index**, so with a fix unstaged it reverts the fix
  rather than the mutation.

`git add -A` before mutating, and confirm the tree is clean afterwards.

A third way, found by a mutation that survived: in `server/test_main.py` the
whole file shares one database, and **`event_id` is unique server-wide, not per
group**. Two tests using `"e0"` means the second one gets a `200` with
`duplicate: true` and stores nothing — so a test that thought it was seeding
events was asserting against an empty group. Prefix event ids per test, and
assert `not res.json().get("duplicate")` when the point of the test is that the
event exists.

## Environment notes

These are about the machines this gets developed on, not about the project.

- **The working directory is the durable one.** On the sandboxed boxes, `$HOME`
  is tmpfs and is wiped without warning — a checkout and toolchain built under
  `~/git` disappeared mid-session. Only the session directory, `~/.claude`, and
  a few read-only mounts (`~/.local`, `~/.ssh`) are real disk. Keep the
  checkout, and anything built for it, inside the working directory.
- **Agent memory does not carry between sessions.** It is keyed by working
  directory, and that directory is per-session, so notes written there are
  unreachable next time. This file is the durable channel — put anything worth
  remembering here.
- Node 26 is required (vite and `node --test`); some boxes default to v12.
