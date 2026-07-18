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

- **Each user has a keypair** — public key on the server, private key never leaves their devices.
- **Each group has a shared symmetric key** — the expense blobs are encrypted with it.
- **Adding a member** — an existing member encrypts the group key to the newcomer's public key and
  uploads that blob (server relays what it can't read). This is the Signal-groups / **MLS
  (RFC 9420)** pattern — worth looking at MLS for the grown-up group key agreement.

## Sub-decisions

- **Invite-link flow:** the group key rides in the URL **fragment** (`…/join#gk=…`) — fragments
  are never sent to the server. Simple; anyone with the link gets in.
- **Member removal / forward secrecy:** rotate the group key on removal so a departed member can't
  read *future* expenses (they keep what they already downloaded — can't un-send that). Emit a
  `member.key_rotated` event; decide whether we care per group.
- **Multi-device:** the private key reaches all of a user's devices — either sync it E2E (encrypted
  under a password-derived key) or per-device keypairs. "Same user on PWA + native" is just the
  multi-device case.
- **Crypto suite:** pinned in the [shared contract](01-shared-contract.md) — Argon2id +
  XChaCha20-Poly1305 + X25519 via libsodium. Never roll our own crypto.

## What E2E costs

- No server-side data features (server-computed balances, email summaries, web reporting, search).
- Push notifications go generic; the client composes real text after decrypting.
- Metadata still leaks (social graph, timing, sizes).
- Support/abuse investigation is harder.

## Open questions

- MLS library vs hand-rolled group key agreement with libsodium.
- Do we rotate on every removal, or only on demand?
