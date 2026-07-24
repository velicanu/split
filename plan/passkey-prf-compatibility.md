# Passkey PRF — provider compatibility

A companion note to [16 — Sign-in methods](16-auth-methods.md). It explains why a
passkey that signs you in to every other website may still fail in Split with:

> This device's passkey can't derive a key: your passkey provider doesn't
> support PRF.

This is not a bug in Split or in the passkey provider. It is a consequence of
using passkeys for something most sites don't.

## Two different jobs for a passkey

- **Authentication** — the passkey signs a server challenge; the server verifies
  the signature and issues a session. This is what almost every "sign in with a
  passkey" site does, and it works with *any* passkey provider.
- **Key derivation** — the passkey produces a stable secret that Split uses to
  unwrap the account key on-device. Split never authenticates to the server with
  a passkey (it authenticates with a device key). It uses the passkey purely to
  derive an encryption key, via the WebAuthn **PRF** extension (backed by the
  CTAP2 `hmac-secret` extension). See [plan/16](16-auth-methods.md).

PRF is an **optional** extension. A provider can fully support passkey *login*
and still not implement PRF — in which case Split can create the passkey but gets
no secret back, so it can't unlock the account.

## Why there's no fallback that "just works everywhere"

The obvious idea — "then use the passkey the normal way, like every other site" —
doesn't help in an end-to-end model:

- A passkey **signature** can't be an encryption key: WebAuthn signs a fresh
  challenge plus a counter, so the value is different every time.
- A server **session** doesn't unlock anything: the server only holds the account
  key *wrapped*, and being E2E it cannot hand back anything that decrypts. A fresh
  device must unwrap the key locally with a real secret.

The only standard ways to get a stable, passkey-bound secret are **PRF** or the
**largeBlob** extension — both optional, both unevenly supported. There is no
construction that conjures a key from a provider that offers neither.

## What supports PRF (as of July 2026)

Support is per-provider, and it changes over time — verify against the current
platform rather than trusting this list.

- **Works:** Google Password Manager (recent Android/Chrome), iCloud Keychain
  (recent Safari/iOS/macOS), and most hardware security keys (`hmac-secret`).
- **Doesn't, at time of writing:** KeePassDX and KeePass2Android as Android
  passkey providers. They support passkey *login* but not the PRF extension, so a
  passkey created in them can't unlock Split.

## How Split handles it

- **Fail fast, clearly.** If `create()` returns no PRF at all (the provider
  ignored the extension) or `enabled: false`, Split stops immediately with an
  actionable message rather than firing a second, useless prompt. See
  `pwa/src/webauthn.js`.
- **Passkeys are additive.** The password and the recovery code work with every
  provider and every device. A missing PRF costs you the passkey convenience,
  never access.

## Upstream tracking (informational)

The exact capability — a KeePass-family client returning PRF as a passkey
provider — is moving in KeePassXC (desktop), and not yet tracked for the Android
clients. Links for reference; we do not depend on any of them.

- KeePassXC #13039 — WebAuthn PRF for passkeys saved in KeePassXC (open, in
  progress): <https://github.com/keepassxreboot/keepassxc/issues/13039>
- KeePassXC #11920 — WebAuthn PRF for database encryption (open):
  <https://github.com/keepassxreboot/keepassxc/issues/11920>
- KeePassDX #304 — hmac-secret FIDO2 extension. Note: this is about unlocking the
  *database* with a hardware key, **not** about acting as a passkey provider that
  returns PRF: <https://github.com/Kunzisoft/KeePassDX/issues/304>
- KeePass2Android #2574 — passkey support (closed; no PRF mention):
  <https://github.com/PhilippC/keepass2android/issues/2574>

## The fix, for a user who hits this

Either create the Split passkey with a PRF-capable provider (Google Password
Manager, iCloud Keychain, or a hardware security key), or simply use the password
and recovery code — nothing is lost. A passkey created by a non-PRF provider
during a failed attempt is harmless but orphaned; it can be deleted from that
provider.
