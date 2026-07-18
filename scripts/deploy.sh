#!/bin/bash
# Pull main and redeploy if it moved. Run by split-deploy.timer every minute.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch origin main
if [ "$(git rev-parse @)" = "$(git rev-parse origin/main)" ]; then
    exit 0
fi

echo "deploying $(git rev-parse --short origin/main)"
git merge --ff-only origin/main
docker compose up -d --build
docker image prune -f
