# Split

Offline-first, end-to-end-encrypted group expense splitter. Live at
[split.velicanu.com](https://split.velicanu.com). Design docs in [plan/](plan/).

## Layout

- `server/` — FastAPI backend (auth, sessions; serves the built PWA in prod)
- `pwa/` — React + Vite PWA
- `scripts/deploy.sh` — pull-based auto-deploy, run by a systemd timer on the host

## Development

```sh
cd server && uvicorn main:app --reload   # api on :8000
cd pwa && npm install && npm run dev     # vite on :5173, proxies /api
```

Tests: `pytest server/`. CI runs tests + a docker build on PRs and main.

## Deployment

Push to main. A systemd timer (`split-deploy.timer`) on the host polls every
minute from a dedicated checkout (`~/deploy/split`) and runs
`docker compose up -d --build` when main moves.
