# 06 — E2E encryption & key management

Because the [server](05-backend-relay.md) never needs to read expense contents, we can encrypt the
payload with no loss of function. E2E and offline-first want the *same* architecture, so they
reinforce rather than fight each other.

## Threat model — decide this first

- **"Protect against breaches / a curious admin"** → TLS + encryption-at-rest + tight access
  controls may suffice, with none of the key-management pain.
- **"The operator must be *structurally* unable to read expenses"** → true E2E, below.

The plan assumes the stronger goal (structural inability), which the architecture supports cleanly.

## Encryption boundary

Split every event into cleartext routing metadata and an encrypted blob — see the metadata
boundary in [05](05-backend-relay.md). The server stores/relays blobs blind; clients decrypt and
compute locally.

## Key architecture

**Decided — see [11](11-identity-and-devices.md) for the concrete schema, endpoints and flows.**

Three levels, not two:

- **Per-device keypairs**, not one key per user. A device key never leaves the device that made it.
  This is what makes revocation real: with a single shared identity key, revoking a stolen device
  is only advisory, because the thief holds the credential and can re-enrol at will.
- **An account key** that lives nowhere persistently — the server holds it wrapped, and it exists
  in memory only long enough to enrol a fresh device. Devices must never be able to reach it.
- **Each group has a shared symmetric key**, wrapped to every member's account key *and* to each of
  their live devices.

**MLS (RFC 9420) was considered and rejected for now** — it is a lot of machinery for
forward-secrecy guarantees we have not asked for. Hand-rolled group-key wrapping with libsodium
instead. Honest caveat: switching to MLS later *would* be a migration, unlike today.

## Sub-decisions

- **Invite-link flow:** the group key rides in the URL **fragment** (`…/join#gk=…`) — fragments
  are never sent to the server. Simple; anyone with the link gets in. The corollary is that a join
  link *is* the group key, so it must not be treated as an ordinary share.
- **Member removal / forward secrecy:** **no rotation in v1.** A departed member keeps what they
  already downloaded either way; rotation only protects future events, and it adds epoch handling
  to every read path. Revisit if a group ever asks for it.
- **Multi-device:** solved by per-device keypairs above. Any number of devices are live
  simultaneously and behave identically; each can revoke any other.
- **Crypto suite:** pinned in the [shared contract](01-shared-contract.md) — Argon2id +
  XChaCha20-Poly1305 + X25519 via libsodium. Never roll our own crypto.

## What E2E costs

- No server-side data features (server-computed balances, email summaries, web reporting, search).
- Push notifications go generic; the client composes real text after decrypting.
- Metadata still leaks (social graph, timing, sizes).
- Support/abuse investigation is harder.

## Open questions

- Whether an app-level PIN/biometric lock is worth it, so a stolen *unlocked* device isn't an
  instant read of the whole ledger. Nothing cryptographic helps here.
- Passkey + WebAuthn PRF as a second wrap method, once support is verified (see
  [07](07-key-recovery.md)).
