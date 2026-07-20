#!/usr/bin/env bash
# Run the client against a real server: start uvicorn on a scratch database,
# run pwa/test/live.test.jsx against it, tear it down.
#
#   scripts/live.sh
#
# Why this exists: every other test in the repo talks to a fake server, and a
# fake only ever agrees with whoever wrote it. Two bugs shipped in that gap.
# See CLAUDE.md, "Testing practice".
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8011}"
DB="$(mktemp -d)/live.db"

# The venv's interpreter is a symlink into uv's python install dir, which on
# some machines lives under /tmp and is wiped between sessions. When that
# happens every command dies with "bad interpreter", which reads like a broken
# checkout rather than a missing symlink.
if [ ! -x .venv/bin/uvicorn ] || ! .venv/bin/python -c '' 2>/dev/null; then
  echo "· rebuilding .venv"
  rm -rf .venv && uv sync -q
fi

stop() {
  lsof -ti:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill || true
}
# npm does not forward signals to what it spawned, so kill the port's listener
# rather than a job id. A broad pkill would risk matching this script itself.
trap stop EXIT
stop

(cd server && DB_PATH="$DB" ../.venv/bin/uvicorn main:app --port "$PORT" \
  >/tmp/split-live-server.log 2>&1 &)

# Poll rather than sleep: a fixed sleep is either flaky or slow.
if ! timeout 30 bash -c \
  "until curl -s http://127.0.0.1:$PORT/api/me >/dev/null 2>&1; do sleep 0.5; done"; then
  echo "✗ server did not come up; see /tmp/split-live-server.log" >&2
  tail -20 /tmp/split-live-server.log >&2
  exit 1
fi

cd pwa
SPLIT_LIVE="http://127.0.0.1:$PORT" npm run test:live
