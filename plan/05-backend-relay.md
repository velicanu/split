# 05 — Backend / sync relay

A deliberately "dumb" server. Clients hold the truth and compute everything; the server never needs
to read expense contents. This smallness is exactly what makes [E2E](06-e2e-encryption.md)
feasible.

## Responsibilities

1. **Auth / identity** — issue and verify tokens, own the user record. Restores *identity* during
   recovery even though it can't read data (see [07](07-key-recovery.md)).
2. **Groups & membership** — create groups, manage the member list, handle invites (links/codes).
   The one place the server holds structural truth, because it routes events.
3. **Event store + sync endpoint** — persist appended events; serve "everything since cursor X" so
   a reconnecting client catches up.
4. **Relay / fan-out** — deliver each member's events to the other members.
5. **(Optional)** push notifications (generic "new activity" only — server can't read content),
   rate-limiting, abuse controls.

## What the server does NOT do

- Compute balances, resolve splits, or understand expenses — all client-side.
- Read payloads — it stores/relays **encrypted blobs** blind.

## What the server sees (E2E metadata boundary)

- **Cleartext, must see:** `group_id`, `event_id`, `updated_at`, `author` (member id).
- **Encrypted, never sees:** amount, currency, who paid, description, split shares.
- **Residual leak:** the social graph (who's in which group), event timing/frequency, blob sizes.
  Membership can't easily be hidden because the server needs it to route.

## Stack (candidate)

- Postgres + a thin API (Node/Hono, or Supabase for auth + RLS + realtime out of the box).
- Auth via magic-link or OAuth; passkeys for the [recovery](07-key-recovery.md) path.

## Open questions

- Supabase vs roll-your-own (auth + RLS is a big freebie, weigh against lock-in).
- Realtime push (websocket/SSE) vs pull-on-open only for v1.
