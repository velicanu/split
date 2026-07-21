# Split — high-level plan

**Split** is an offline-first, end-to-end-encrypted group expense splitter. It ships first as a
PWA and later as native apps; every client is a thin renderer over a shared, append-only event
ledger, so any user on any platform (including the same user on PWA *and* native) sees the same
core information.

The system is decomposed into the pieces below. Each links to a dedicated file with the decisions
made so far, the approach, and open questions. Build order roughly follows the numbering — the
shared contract comes first because everything else conforms to it.

| # | Piece | What it is |
|---|-------|-----------|
| 01 | [Shared contract](01-shared-contract.md) | The platform-neutral source of truth — event schema, core algorithm spec with golden test vectors, and the pinned crypto suite that every client must implement identically. |
| 02 | [Data model & event ledger](02-data-model-and-ledger.md) | The domain entities (User, Group, Membership, Expense, Share, Settlement) modelled as an append-only log of immutable events. |
| 03 | [Splitting & balances engine](03-splitting-and-balances.md) | Integer-cents money math, the split modes (equal/exact/percentage/shares), pairwise balances, optional debt simplification, and LWW conflict resolution. |
| 04 | [Offline-first client sync](04-offline-sync.md) | Local-first writes via IndexedDB + an outbox, flushed on app-open / reconnect, with a sync cursor and last-write-wins reconciliation. |
| 05 | [Backend / sync relay](05-backend-relay.md) | A deliberately "dumb" server: auth/identity, groups & membership/invites, an event store + sync endpoint, and blind fan-out of encrypted blobs. |
| 06 | [E2E encryption & key management](06-e2e-encryption.md) | Per-user keypairs, a per-group symmetric key, invite-key-in-URL-fragment distribution, and key rotation on membership changes. |
| 07 | [Key recovery](07-key-recovery.md) | A layered recovery ladder: passkey/PRF, a server-stored wrapped-keys blob, a recovery phrase, and social recovery via group re-invite. |
| 08 | [PWA shell](08-pwa-shell.md) | React + Vite + vite-plugin-pwa: service-worker app-shell precache so the app opens offline, installability, and durable local storage. |
| 09 | [AI features](09-ai-features.md) | Receipt scanning and natural-language split directives via a capability ladder (on-device → in-browser WebGPU → cloud), with consent gating. |
| 10 | [Native apps (later)](10-native-apps.md) | Native clients that speak the same shared contract, reach the OS on-device AI, and resolve the App Store ↔ AGPL licensing tension. |
| 11 | [Identity, devices & revocation](11-identity-and-devices.md) | The concrete slice under 06/07: challenge-signed auth with no server-side passwords, per-device keypairs, real device revocation, and the schema/endpoints/flows for each. |
| 12 | [Ghosts, leaving & membership](12-membership.md) | One mechanism for people who don't use the app, who leave, and who lost their account: ghost members, ghosting as a fork, claim-on-join, and revive. |
| 13 | [Receipt-scanning backends](13-receipt-scanning-backends.md) | All scanning through a backend (direct provider calls removed): a fixed image→JSON contract as the AGPL/licence boundary, group-scoped credentials sealed into the ledger, and real backend-side revocation. |

## Cross-cutting principles

- **The contract is the product.** Interop across PWA/native is a property of the shared event
  schema, core algorithm spec, and crypto suite — not of any client. Protect these as
  first-class, platform-neutral artifacts (see [01](01-shared-contract.md)).
- **Append-only ledger, LWW.** New expenses/settlements are appends (never conflict); LWW only
  resolves concurrent edits to the *same* event by `updated_at`.
- **The server can't read data.** E2E means canonical balance/split logic lives in the shared
  *client* spec, not the server. The server is an auth'd relay of ciphertext.
- **Group-centric recovery.** Because all data lives in groups, key loss degrades to "get
  re-invited" rather than "lose everything" — enabled by stable member ids + rotatable keys.
- **License:** AGPL-3.0 (add a CLA to preserve dual-licensing and native App Store distribution).

## Status

Design agreed across the thread; repo scaffolded. Next concrete artifact to write is the
[shared contract](01-shared-contract.md).
