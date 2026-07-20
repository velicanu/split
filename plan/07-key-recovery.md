# 07 — Key recovery

E2E's hardest UX problem: lose your device, lose your keys. We mitigate with a **layered ladder**
plus a **social** path unique to the group-centric model, so no single mechanism has to be
bulletproof.

## Key architectural move: wrap the keys

Don't back up private/group keys directly.

1. Generate a **recovery key-encryption-key (KEK)**.
2. Encrypt the user's E2E keys with the KEK → a **wrapped-keys blob** that's useless without the KEK.
3. Store that blob **anywhere, even our own server** (it's ciphertext).
4. Only the **KEK** (or a phrase that derives it) needs platform-grade protection.

This splits the problem into "where ciphertext lives" (easy) vs "the one recovery secret" (below).

## v1 decision: re-invite is the recovery story

**Decided:** there is no recovery phrase in v1. If a user loses every device *and* their password,
they make a **new account** and get re-invited to each group. Someone still in the group ghosts the
lost member and sends an invite naming it; accepting that invite joins and claims it in one act, so
the old history reattaches to an account that can actually sign for itself
(see [12](12-membership.md)).

There is deliberately no way to do this after the fact. Claiming is a field on the join, not an
event anyone can write, which means no member already in a group can become someone else. The cost
is that a plain invite accepted by mistake cannot be corrected afterwards — the fix is to ghost
them and re-invite with the right link, which is this same path again.

This works only because we do not rotate group keys — one group key decrypts the entire history, so
a re-invited user gets everything back rather than only events from now on.

What it costs: a re-invite per group, and a new `login_handle` (the old one stays taken —
releasing it would mean proving you owned it, which is the identity problem we are dodging). What
stays broken: solo groups, or a group where everyone lost their keys. Nobody left to vouch.

Day-to-day durability comes from the **password-wrapped account key** on the server, not from the
ladder below: password managers persist passwords reliably, and the wrap blob means IndexedDB
eviction costs a cache rather than an account.

The ladder below remains the intended end state, not the v1 build.

## The ladder (layered, no single point of failure)

1. **Passkey + WebAuthn PRF (primary)** — the closest thing to platform-synced backup on the web.
   The passkey syncs via iCloud Keychain / Google Password Manager; PRF derives a stable secret we
   use as the KEK. Recovery = "sign in with your synced passkey." **Caveat:** PRF support is still
   maturing (recent Chrome/Android; Safari/iOS 18-era) — must keep a fallback, verify current
   support before committing it as primary.
2. **Wrapped-keys blob on the server** — restores keys once the KEK is available.
3. **Recovery phrase (BIP39-style)** — the always-works baseline; derives the KEK with no platform
   dependency.
4. **Manual export** — download/share-sheet a recovery file to Drive/iCloud Drive/Files
   (there is **no** web API to write a user's iCloud silently; manual is the universal fallback).

**Do NOT** treat IndexedDB as backup — it's evictable (iOS especially).

## Social recovery (the group-centric superpower)

Because all data lives in groups, key loss degrades to "get re-invited" rather than "lose
everything." This gives a *second, independent* recovery path, so the personal ladder above need
not be perfect.

Requirements and flow:

- **Decouple identity from keys.** Ledger events reference a **stable member id**, not a raw public
  key. Losing all keys = key rotation (bind new keys to the same member id), *not* creating a new
  identity. This is what lets us "associate the relevant ledger pieces to them."
- **Recovery splits in two:**
  - **Server restores *identity*** — it can't read data but knows your account (email/passkey), so
    it proves "this human was member M1" and lets you register new keys.
  - **A member restores *access*** — an existing member re-encrypts the group key (and its
    **history**, for older forward-secret epochs) to your new public key and attests
    "new key K2 belongs to M1." Server = identity; members = decryption.
- **Guard the trust surface** — re-association is also an account-takeover vector:
  - Prefer **M-of-N member approval** (or admin + server identity check) over any-single-member.
  - **Notify all members** on any re-key event.
  - Requiring *both* server identity proof *and* a member re-share raises the bar for attackers.

## Residual cases (where the personal ladder still matters)

- Solo groups, or groups where everyone else also lost keys / left — no one to vouch.
- This social property holds **only because there is no per-user-only encrypted data.** Any future
  private (non-group) data falls back to the personal ladder.

## Open questions

- M-of-N threshold (N=1 admin vs a real quorum).
- Whether we re-share full key history on re-invite (yes for the legitimate same-person case).
