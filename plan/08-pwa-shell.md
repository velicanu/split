# 08 — PWA shell

The installable web client. The service worker's **only essential job here is app-shell
precaching** so the app can *open* offline — without it, launching with no network yields a blank
page and there's nothing to render the local [IndexedDB](04-offline-sync.md) data with.

## Stack (candidate)

- **React (or Svelte) + Vite.**
- **`vite-plugin-pwa` (Workbox)** for the service worker + manifest. Don't hand-write raw SW code —
  Workbox generates the precache manifest, gives caching strategies as one-liners, and manages
  cache versioning/cleanup and the update flow.

## Service worker scope

- **Precache the app shell** (HTML/JS/CSS/icons) so the app boots with zero network — supported in
  **every** modern browser.
- **Do NOT** use it for ledger data (that's IndexedDB) and **do NOT** rely on Background Sync
  (Chromium-only; sync is plain app code per [04](04-offline-sync.md)).
- Caching strategies: cache-first for the shell/static assets; network-first or
  stale-while-revalidate for any non-E2E network reads.

## Installability & storage

- Web app manifest (name, icons, `display: standalone`, theme) so it installs to the home screen.
- Request durable storage via `navigator.storage.persist()` — best-effort; not a durability
  guarantee (see [04](04-offline-sync.md)).
- HTTPS required (localhost exempt for dev).

## The update gotcha

Service-worker updates are **sticky**: a new SW sits in "waiting" until all tabs close, so users
can run stale code for a long time. Pair `skipWaiting()` + `clients.claim()` with a
"New version available — reload?" prompt so we don't yank the rug mid-session. This is the #1
source of "why are users on old code" with PWAs; Workbox helps manage it.

## Open questions

- React vs Svelte.
- Whether to adopt a batteries-included local-store/sync layer (PowerSync / ElectricSQL / RxDB)
  vs Dexie + hand-rolled outbox — decide alongside [04](04-offline-sync.md).
