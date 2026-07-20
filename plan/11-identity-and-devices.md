# 11 — Identity, devices & revocation

The concrete slice underneath [06](06-e2e-encryption.md) and [07](07-key-recovery.md): how a user
proves who they are once there are no passwords on the server, how a second device joins, and how
a stolen one is cut off.

Decided in design discussion; build order at the bottom.

## What the server actually needs

Working this out is what collapsed the design. The server needs to know:

1. **Who** — authenticate a request.
2. **Who is in which group** — it enforces access control on events and receipts.
3. **Order** — `events.id` is a global monotonic sequence that is simultaneously the total order,
   the sync cursor, and the group version. Its most valuable job, and it needs zero knowledge of
   content.
4. **Idempotency** — `event_id` uniqueness, so a retried push is a no-op.
5. **Invite code → group**, to route a join.
6. **Bytes** — store and relay opaque payloads and blobs.

It never needs descriptions, amounts, dates, categories, payers, splits, comments, receipt images,
the storage-backend credential, or the AI keys. Balances and settlements are already computed
client-side.

Since the server only verifies **who**, and "who" can be proven by signing a challenge, passwords
leave the server entirely. A password becomes a client-side KDF input that is never transmitted.

## Key hierarchy

Three levels. The separation between them is the whole point — it is what makes revocation mean
something rather than being a polite request.

| Key | Where it lives | Purpose |
|---|---|---|
| **Account key `A`** (X25519) | **nowhere persistently.** The server holds it wrapped; it exists in memory only during enrolment, then is discarded. | Root of recovery: lets a fresh device bootstrap with no other device available. |
| **Device key `Dᵢ`** (Ed25519 sign + X25519 box) | IndexedDB on that device, never leaves it | Daily use: authenticates to the server, unwraps group keys. |
| **Group key `G`** (symmetric) | wrapped to `A` *and* to every live `Dᵢ` of every member | Encrypts that group's payloads and receipts. |

**A device must never be able to reach `A`.** If it could, extracting a device key would yield the
account key and revocation would be theatre. That constraint is why `G` is double-wrapped: to each
`Dᵢ` for everyday use, and to `A` only so that a fresh device can bootstrap.

## Why revocation needs per-device keys

With a single shared identity key, server-side device tracking is only advisory. Cutting a stolen
device's session stops it syncing, but the thief still holds the identity key and can simply sign
a fresh challenge and re-enrol. You revoke, they re-enrol, forever.

That breaks the "be faster than the thief" model in a specific way: a competent thief does not need
to be fast, only quiet. Extract the key in five minutes, use it in three weeks, and the race was
never observable.

With per-device keys the thief holds exactly one key, revoking it locks them out, and they cannot
mint a replacement because minting requires authorisation from a device that is still trusted.

**What no design recovers:** whatever was already decrypted on that device. It cannot be un-sent.
An app-level PIN/biometric lock is the eventual mitigation, so that a stolen *unlocked* phone is
not an instant read of the whole ledger.

## Schema

Dropped: `users.salt`, `users.pw_hash`, `hash_pw()`, password login.

```
users        id, login_handle UNIQUE, display_name (NOT unique), account_pubkey
key_wraps    user_id, method('password'|'passkey'), params, ciphertext   -- Enc(A_priv)
devices      id, user_id, pubkey UNIQUE, box_pubkey, label, created_at, revoked_at
sessions     token, user_id, device_id
group_keys   group_id, recipient_kind('account'|'device'), recipient_id, ciphertext
```

`groups`, `memberships`, `events` and `receipts` keep their shape. `events.payload` and
`receipts.bytes` merely become ciphertext, which costs the server nothing: it already stores
payloads opaquely and never computes on them.

**Usernames stop being unique.** `login_handle` is unique but exists only so a fresh device can
find its wrap blobs before it holds any key; `display_name` is free-form. A group can therefore
contain two people showing the same name — ids stay distinct, so the fold is unaffected.

## Endpoints

```
POST   /api/auth/challenge  {device_pubkey}             → {nonce}
POST   /api/auth/verify     {device_pubkey, nonce, sig} → session | 401 if unknown/revoked
POST   /api/signup          {login_handle, display_name, account_pubkey,
                             device_pubkey, box_pubkey, label, wraps[]}
GET    /api/wraps?login_handle=…                        → wrap blobs (rate-limited)
GET    /api/devices                                     → list, incl. revoked_at
POST   /api/devices         {pubkey, box_pubkey, label, sig}
DELETE /api/devices/{id}                                → revoke + drop its sessions
GET    /api/groups/{id}/keys                            → wraps addressed to me
POST   /api/groups/{id}/keys                            → upload wraps for a recipient
```

`/api/password` changes meaning: re-wrap `A` client-side and replace the blob. The server can no
longer reset anything, because it holds nothing that could.

## Flows

**Signup** — generate `A` and `D₁`, wrap `A_priv` under the password, post everything. The server
never sees `A_priv` or the password.

**Add a device** — the *new* device shows its public key as a QR; an *existing* device scans it,
because authority lives on the old device. The old device signs an authorisation and wraps every
group key to the new device's public key. No secret crosses the server.

**Enrol with no live device** — fetch wraps by `login_handle`, unwrap `A_priv` locally, self-
authorise a new device key, re-wrap each group key from the `A`-wraps to the new device, then
discard `A_priv` from memory.

**Revoke** — any live device revokes any other. The server marks it revoked and drops its sessions.
The revoked device keeps what it already decrypted but gets nothing new and cannot re-enrol.

**Join** — the invite link carries `G` in the URL **fragment** (`/join#gk=…`), which browsers never
send to the server. The joiner wraps `G` to their own account and devices locally. The server plays
no part in key distribution at all.

Consequence: an invite link *is* the group key. Anywhere a URL is logged or preview-fetched, the
key leaks — so a join link must not be treated as an ordinary share.

**Claim** (account recovery, see [07](07-key-recovery.md) and [12](12-membership.md)) — a `claims`
field on `member.added`, set when an invite named a member to become. The fold builds an alias map
and resolves `splits`, `payers`, settlement `from`/`to`, and comment `author` through it.

Because `member.added` is the one event the *server* writes, and writes in the clear, claiming a
member at most once is enforced rather than left to every client to honour. It also means claiming
can only happen at the instant of joining: there is no event an existing member can write to become
somebody else.

## Accepted risks

- **`GET /api/wraps` hands out offline-crackable material** to anyone who knows a login handle.
  Mitigated with aggressive Argon2id parameters and rate limiting, not closed. Passkey-PRF wraps
  would close it; they are deferred until PRF support is verified, because betting the only
  recovery path on an unverified platform feature is worse than this.
- **Password strength matters more than it used to.** Today a weak password is shielded by
  server-side scrypt and a rate-limited endpoint; against a leaked wrap blob, Argon2id is the only
  defence and the prize is decryption rather than a session.
- **No group-key rotation on member removal** (v1). A departed member keeps what they already had
  either way; rotation only protects future events and adds epoch handling to every read path.
- **Metadata still leaks:** login handles, display names, group membership, event authorship and
  timing, payload and receipt sizes, device counts. E2E, not anonymity.

## Build order

One PR at a time; each leaves a working app.

| PR | Contents |
|---|---|
| **A** | This document. Keypair auth, devices, revocation, password wraps. **No encryption yet** — payloads stay readable so the auth model can be debugged before everything goes opaque. |
| **B** | Group keys, encrypted event payloads, invite-fragment distribution. |
| **C** | Encrypted receipts, content-hash blob ids. |
| **D** | Claim-on-join (`member.added.claims`) and alias folding. |

Passkey-PRF wraps slot in additively at any point via `key_wraps.method`.

**All existing data is dropped** at PR A. This is deliberate and is why now is the cheap moment —
the no-migration-during-development policy is still in force, and it stops being true the day it
is not.
