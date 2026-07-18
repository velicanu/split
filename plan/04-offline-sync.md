# 04 — Offline-first client sync

Local-first writes: a user adds an expense with no signal, it persists locally and syncs later.
The UI always reads local state, so the network never blocks interaction.

## Storage

- **IndexedDB owns the ledger data** (expenses, settlements, groups) — the app reads/writes it
  directly, so the UI updates instantly regardless of connectivity.
- **The service-worker HTTP cache is for the app shell only** (see [08](08-pwa-shell.md)), not for
  ledger data. Different jobs: IndexedDB = your data; SW cache = the code that renders it.
- IndexedDB/localStorage are **evictable** (iOS especially) — never the backup of record. Request
  persistence via `navigator.storage.persist()`, but treat durability as best-effort and rely on
  server sync + [key recovery](07-key-recovery.md) for real durability.

## Write path (outbox)

1. User action → write the event to IndexedDB **and** to an `outbox` table (pending, un-synced).
2. UI re-renders from IndexedDB immediately.
3. On sync, flush the outbox to the server, mark events synced.

## Sync trigger — deliberately simple

- Flush **on app open** and on the `online` event (and optionally on tab focus).
- **No Background Sync API** — it's Chromium-only and buys nothing meaningful here. "Synced next
  time you open the app" is fine for an expense splitter. This keeps sync as plain,
  universally-supported app code.

```js
window.addEventListener('online', flushOutbox);
if (navigator.onLine) flushOutbox();   // also at startup
```

## Reconcile

- Client pushes outbox events, then pulls "everything since cursor X" from the server.
- Dedup by `event_id`; resolve same-id conflicts by LWW (`updated_at`) per
  [03](03-splitting-and-balances.md).
- Advance the sync cursor.

## Open questions

- Cursor design (monotonic sequence per group vs server timestamp).
- Batch size / pagination for large catch-ups.
- The exact outbox retry/back-off policy on partial sync failure.
