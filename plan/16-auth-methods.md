# 16 — Sign-in methods

Three ways to unlock an account, on top of the password: a **recovery code**, a
**passkey**, and (kept for later) **device pairing**. This document covers the
first two, which shipped together; pairing is designed in [11](11-identity-and-devices.md)
and deferred.

## The reframe that makes this small

In this system "login" is not a server-auth question. The server only ever
verifies a *signature* from a device key; a fresh device gets one by unlocking
the account key `A` and using it to authorise the new device key. So a sign-in
method is really just **a way to derive the secret that unwraps `A`**.

That reframe does two things. It rules out anything that only proves identity to
the server — email links, SMS, OAuth — because they unlock nothing, and adopting
one as the sole factor would force the server to hold decryptable key material.
And it collapses the remaining options into **wrap methods**: `key_wraps` gains a
row per method, each the *same* secretbox over `A`, differing only in how the
32-byte key is derived.

| method | key derivation | entropy | KDF |
|---|---|---|---|
| password | Argon2id(password) | low, human | slow, on purpose |
| recovery | hash(128-bit code) | high, machine | none needed |
| passkey | hash(PRF output) | high, authenticator | none needed |

`key_wraps` is keyed by a client-chosen **id** (`password`, `recovery`, a
passkey's own id) rather than by method, so a password change replaces just its
row and a passkey adds one, instead of every method fighting over one slot.

## Adding a method needs the account key — which the device never holds

`A` lives *nowhere persistently*: a device holds its own device key and the group
keys, and only ever sees `A` in memory during enrolment. So adding a passkey or a
recovery code from a logged-in device has to **unlock `A` first** (enter the
password), wrap `A` under the new secret, and drop it again. We do not cache `A`
to skip this — a device that could reach `A` would make device revocation
theatre ([11](11-identity-and-devices.md)).

## Recovery code

A machine-generated 128-bit secret, shown once at signup (and re-generatable in
settings). It is the wrap that **closes** the offline-crack risk a password wrap
leaves open: `GET /wraps` hands the wrapped-`A` blob to anyone who knows the
handle, and against 128 random bits that is not crackable, KDF or no KDF.

Encoded in Crockford base32 — no `I`/`L`/`O`/`U`, grouped, with a check symbol
that turns a typo into a clear message instead of a failed decrypt. Deliberately
**not BIP39**: a 2048-word list only earns its weight when you interoperate with
other wallets, which we never do, and it is one more large asset to ship and keep
correct. A self-contained code is simpler and exactly as strong.

Generated at signup by default, so every account has a strong way back in from
the start — one that is not hostage to how good the password is.

## Passkey (WebAuthn PRF)

A passkey derives a stable secret via the WebAuthn **PRF extension**, and that
secret wraps `A`. The key property: **the server does no WebAuthn work at all** —
no assertion verification, no credential table, no attestation, no sign-counter.
The ceremony is entirely client-side; the server stores only the opaque wrap plus
the credential id in `params`, exactly like the password wrap. That keeps the
server dumb and self-hosting trivial.

A fixed PRF salt is shared across an account's passkeys, so a fresh device can
evaluate PRF over *all* of them in one prompt and let the authenticator answer
for whichever it holds.

**Precondition, not a server role:** WebAuthn is only exposed on a secure context
(HTTPS, or `localhost`) with a real domain as the RP id — never a bare IP. This
is the *browser's* rule about the page, independent of our server. It costs the
self-host story nothing: the PWA already needs a secure context for its service
worker, so anywhere the app is properly deployed, passkeys just work; a bare-IP
deployment simply doesn't show the option, and password + recovery still work.

## The weakest-wrap principle

An account is only as strong as its *weakest* wrap: an attacker with a leaked
blob cracks the password wrap even if a passkey also exists. So once a strong
method is in place, the password wrap can be **removed** — with a hard server
invariant that **at least one wrap always remains** (none would mean an
unrecoverable account, and the server holds nothing it could reset).

## Endpoints

```
POST   /api/signup      wraps: [password, recovery]   (unchanged shape, now a list)
GET    /api/wraps?login_handle=…                       → [{id, method, params, ciphertext}]
POST   /api/wraps       {id, method, params, ciphertext}  upsert one (session)
DELETE /api/wraps/{id}                                 remove one, refuses the last (session)
```

`PUT /api/wraps` (replace-all) is gone: a password change must not nuke the
passkey and recovery wraps, so writes are per-wrap.

## Honest limits

- **The weakest wrap sets the floor.** Keeping a bad password around undermines a
  passkey; that's why removing it is offered, not hidden.
- **A leaked recovery code is full account access.** It is a bearer secret; it
  belongs in a password manager or a safe, not a chat.
- **Passkey portability follows the platform.** A synced passkey (iCloud/Google)
  reaches your other devices; an unsynced one (a security key) only helps where
  it's plugged in. Neither is worse than before — password and recovery still
  cover the gap.
- **No group-key rotation** when a method is removed, same as [11](11-identity-and-devices.md):
  removing a wrap closes a *door to `A`*, it does not re-key anything already
  decrypted.

## Deliberately not doing (yet)

- **Device pairing** (QR / short code + fingerprint) — designed in
  [11](11-identity-and-devices.md), the natural next method: authorise a new
  device from an existing one without `A` at all.
- **Passwordless signup** — signup still sets a password; recovery-only accounts
  can come once the flows above have proven out.
- **Server-side WebAuthn** (discoverable-credential login, attestation) — not
  needed while passkeys are only a wrap method.
