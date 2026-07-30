# 19 — Federation & horizontal scale

Two questions that turn out to be the same shape:

- **Federation:** `split.velicanu.com` and `split.otherdomain.com` are both easy
  to self-host. What would it take for groups and people created on different
  domains to talk to each other?
- **Scale:** within one domain, could we run *multiple* backend servers? What
  are the tradeoffs and the level of effort?

This is a design note, not a commitment. Nothing here is built.

## The fact that governs all of it

The server is a **blind relay** ([05](05-backend-relay.md)). The trust anchor
for a group is not the server — it is the **group key** (rides in the invite URL
fragment, sealed to member device keys, never seen by the server;
[06](06-e2e-encryption.md)) plus the **E2E event ledger**
([02](02-data-model-and-ledger.md)). The server holds ciphertext and exactly
three cleartext things it actually owns:

1. **Identity** — `login_handle` uniqueness, device pubkeys, the `key_wraps` for
   the account key `A`, and the server-issued integer `user_id` / `group_id`
   ([11](11-identity-and-devices.md), [16](16-auth-methods.md)).
2. **Append order** — every event gets a server-issued monotonic `id`; the
   fold's "latest revision wins" and ghosting's `at_event_id` cut-point both
   depend on that single sequence ([02](02-data-model-and-ledger.md),
   [12](12-membership.md)).
3. **Membership routing** — `member.added` is the one event the server writes
   *in the clear* and enforces (claim-once, who is served the feed).

Everything else — expenses, splits, settlements, display names — is opaque to
the server. So both questions reduce to: **who owns identity, ordering, and the
member list?**

Two shipped features already prove the design leans "the key is the capability,
the server is incidental": read-only sharing ([14](14-read-only-sharing.md)) and
the shared bill ([15](15-shared-bill.md)) both grant account-less, cross-boundary
access via key-in-fragment; and ledger export plus revive/clone
([12](12-membership.md)) already move a whole group's log between groups.

## Federation across domains

### A1 — Client-side multi-homing (cheap; mostly already latent)

A group has a *home server*. The invite link is already a URL on that domain
carrying the key in the fragment. If the client treats a group's identity as
**`(origin, group_id)`** instead of a bare `group_id`, then opening an
otherdomain invite just means "this group's home is otherdomain — sync it there."
A velicanu person joining an otherdomain group simply *also* enrols an account on
otherdomain — which the join flow already does. They end up with one account per
server they have a group on; their device holds keys for each; and **the client
is the federation point**, aggregating across homes — which it already does,
since the home hero and Activity feed fold across groups *client-side*, never
server-side ([18](18-liquid-glass.md), `overview.js`).

What this would actually touch (no server change, no protocol):

- The client assumes a single same-origin `/api` (`api.js`). Make it per-group:
  each group syncs against its own home origin.
- Session/auth is per-origin. Hold one session per home server.
- Local storage keys groups by bare `group_id` (`store.js`, IndexedDB). Key by
  `(origin, group_id)` so ids from two servers can't collide.
- Invites carry the home origin (they already are URLs on it).

Effort: **medium, client-only.** This is the high-leverage path.

### A2 — True server-to-server federation (a real project)

Servers replicate a group's log to each other (ActivityPub-shaped): velicanu
holds velicanu-users' membership, otherdomain holds its own. This breaks all
three things the server owns:

- **Global IDs.** Per-server integers no longer work; you need namespaced
  `user@domain` / UUID group ids.
- **A federation protocol.** Server-to-server auth, event push/pull, backfill.
- **Ordering.** The single authoritative monotonic sequence is gone, so "latest
  revision wins" and `at_event_id` need a designated home or a CRDT / vector
  clock instead of an integer id.

E2E *shrinks the trust surface*: a peer server can't read or forge encrypted
content — worst case it withholds or reorders, and only the cleartext
`member.added` routing is forgeable. But availability, ordering, and identity
portability are all real work. This is **months, not weeks**, and only worth it
if the goal is genuinely decentralized instances.

### Identity portability (latent, unbuilt)

`A` is client-held and the server only stores *wraps* of it, so the same account
public key could enrol on multiple servers — "the same you" everywhere — with no
central authority. The primitive exists; nothing uses it. Servers still mint
separate `user_id`s, so the client would map "me on velicanu" to "me on
otherdomain." Per-group ghost-claim ([12](12-membership.md)) already handles
"same person, different id" within a group.

## Multiple backends within one domain

The architecture gives a real gift here: **groups are embarrassingly
shardable.** Each group is an independent event log with its own key, and the
server does essentially *no cross-group queries* — aggregation is client-side.

- **Shard by group.** Route `group_id → shard`. Almost nothing crosses shards.
  This is the natural scaling axis.
- **Identity is the one global-ish component** (`login_handle` uniqueness, device
  auth, `key_wraps`) — small; keep it a central-ish service.
- **The sticky point is the per-group monotonic `id`.** Within a group you want a
  single writer to keep the sequence clean — but a friend group writes a handful
  of events a day, so per-group single-writer is fine; you scale by sharding
  *across* groups, not by parallelising writes *within* one.

Storage substrate: today it is **SQLite (WAL)** (`db.py`), single-file /
single-host. Multiple processes on one box already works (run more uvicorn
workers); multi-host means either **SQLite-per-shard** or swapping to
**Postgres**. The migration is standard; the only care item is generating that
monotonic id under concurrency (a sequence, or a per-group transaction).

Two easy, high-leverage wins that fall straight out of E2E:

- **Receipt images are content-addressed by hash** (`contentId`) → put them on
  object storage / a CDN with zero invalidation logic ([13](13-receipt-scanning-backends.md)).
- **Sync is read-heavy pull-since-cursor over opaque blobs** → read replicas
  scale reads trivially, because the server never computes on content.

### Effort ladder

| Step | Effort | Notes |
|---|---|---|
| More uvicorn workers, one host, SQLite | trivial | limited headroom |
| Receipts → object storage / CDN | easy | big win, content-addressed already |
| Stateless app tier + Postgres (or per-shard SQLite), shard by group | medium | architecturally natural; watch the monotonic-id generation |
| Read replicas for sync | easy–medium | writes to primary, reads anywhere |
| Central identity service split out | medium | the one thing that stays global |

## The unifying picture

Federation and sharding are the same idea: **a group has a home (a domain, or a
shard), the invite names it, and the client aggregates across homes.** Because
the client already does all cross-group math itself and the server is a blind
relay, the leverage point for *both* is **teaching the client to be multi-homed**
— per-group home routing, per-origin sessions, and (optionally) a portable
account identity.

## Recommendation / sequencing

1. **Scale first, the natural way:** shard by group + content-addressed receipts
   to object storage. Standard, no protocol, big payoff.
2. **Then A1 (client multi-homing):** reuses the exact "group has a home"
   plumbing and unlocks cross-domain in the weak sense.
3. **A2 (true federation) only if** the goal is decentralized instances with
   portable `user@domain` identity — that is the one that forces global IDs and
   giving up the single authoritative log.

## Open questions

- Where does the per-group monotonic sequence live under sharding, and does
  anything other than the fold and `at_event_id` depend on it being global?
- Do we want portable account identity (one `A` public key across servers), and
  if so, how does a server attest "this is the same person" without a central
  registry?
- For A1, does the PWA's service-worker shell ([08](08-pwa-shell.md)) need to be
  origin-aware, or can one app shell drive many home servers?
- Read replicas + LWW: is `updated_at`-based conflict resolution still correct
  when a client reads a slightly stale replica and writes against it?
