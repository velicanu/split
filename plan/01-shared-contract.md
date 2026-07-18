# 01 — Shared contract

The one artifact that makes "any app, any platform, same data" work. Both the PWA and future
native apps are just clients of this contract; interop is a property of the contract, not of any
client. Write this **before** any client code, and treat it as versioned and first-class.

## Three parts

1. **Event schema** — the append-only ledger's event types, defined platform-neutrally
   (JSON Schema now, protobuf later if we want). Every event carries `event_id`, `group_id`,
   `author` (stable member id — see [02](02-data-model-and-ledger.md)), `updated_at`, and
   `schema_version`. The payload fields (amount, description, splits) are the encrypted part.
2. **Core algorithm spec + golden vectors** — the exact rules for money math, split resolution,
   balance computation, and LWW tie-breaks, written as language-neutral prose **plus** a table of
   `input → expected output` test vectors. Every client must pass the same vectors, or two clients
   will show different numbers for the same group. This is non-optional because the server (being
   E2E-blind) cannot be the canonical calculator.
3. **Pinned crypto suite** — the exact primitives (KDF, AEAD, curve) so a blob encrypted by the
   PWA decrypts on native for the same user. Proposed: **Argon2id** (KDF) + **XChaCha20-Poly1305**
   (AEAD) + **X25519** (key agreement), via libsodium, which has faithful implementations on
   every platform.

## Decisions made

- Ledger events reference a **stable member id**, never a raw public key (enables key rotation and
  social recovery).
- `schema_version` on every event from day one so old/new clients coexist.
- Prefer libsodium precisely for cross-platform fidelity.

## Optional upgrade

Extract the core algorithm into a **portable shared library** (Rust or Kotlin Multiplatform →
WASM for the PWA, native for the apps) so there is literally one implementation. Not required for
v1; the spec + golden vectors are the minimum bar.

## Open questions

- JSON Schema vs protobuf for the wire format (start JSON, revisit for native).
- Exact remainder-cent distribution rule (see [03](03-splitting-and-balances.md)).
- Where the golden-vector suite lives so all clients can consume it in CI.
