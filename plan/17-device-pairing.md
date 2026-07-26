# 17 — Device pairing

Add a new device from a device you're already signed in on — no password, no
recovery code. The natural fourth sign-in path, and the first one that needs
neither the account key nor a typed secret. Designed in
[11](11-identity-and-devices.md), deferred in [16](16-auth-methods.md); this is
the build.

## The property that makes it worth doing

Pairing is **`A`-free**. An enrolled device already holds every group key
unwrapped for daily use, so it can authorise the new device's key *and* seal the
group keys straight to it — the account key `A` is never unwrapped or moved.
(Enrol-with-password has to unwrap `A`; pairing doesn't.) Two primitives already
exist and carry it:

- **`POST /api/devices` with `signed_by: 'device'`** — a trusted device signs the
  new device's public key; authority is the signature, not a session. This is
  what enrols the new device.
- **`POST /api/groups/{id}/keys`** — the signed-in device seals each group key to
  the new device's box key (`sealTo`) and stores it.

So the server's *pairing* role is only a **rendezvous**: carry the new device's
public keys to the old one, and signal the new one when it's approved.

## The flow

**New device (N)** — a fresh browser on the sign-in screen, no key:
1. Generate its device keypair `D_N` locally.
2. `POST /api/pairings {new_pubkey, new_box_pubkey, label}` → a short **code**.
3. Show the code, a **QR** encoding `…/#pair=<code>`, and a **fingerprint** (see
   below) derived from `D_N`'s public key.
4. Poll `GET /api/pairings/{code}` until `approved`.
5. On approval: authenticate with `D_N` (the ordinary challenge/verify — the
   device row now exists), save the key and session. The group keys O sealed are
   fetched lazily as the app is used.

**Old device (O)** — signed in, holds `D_O` and a session:
1. Enter the code, or scan the QR (which pre-fills it).
2. `GET /api/pairings/{code}` → the new device's public keys + label.
3. Show the **fingerprint** of the fetched key. The user confirms it matches the
   one on N's screen.
4. On confirm: sign `D_N`'s pubkey with `D_O` and `POST /api/devices`
   (`signed_by: 'device'`) → the new device is enrolled; seal every group key to
   `D_N`; then `POST /api/pairings/{code}/approve`.

## The fingerprint is the security; the code is just a pointer

The code is a **bearer pointer** to server-held rendezvous state — convenient to
type or scan, but not trusted. What stops a man-in-the-middle (a substituted
code, a shoulder-surfed one) is the **fingerprint match**: O displays a short
string derived from the key it fetched, N displays the same string derived from
its own key, and the human confirms they're equal before O signs. Same idea as
Signal's safety numbers or Bluetooth pairing — you're confirming the two devices
see each other's real keys, not an interposed third.

- **Fingerprint** = the first 36 bits of `BLAKE2b(new_pubkey)`, shown as **6
  emoji** from a fixed 64-emoji table. Language-neutral, quick to compare, and
  visually distinct from the code so the two aren't confused. 36 bits is ample:
  forging a key to a target fingerprint needs the target first, which needs the
  victim's code — circular — and the pairing window is short.
- **Code** = 8 URL-safe characters, single-use, ~10-minute TTL. QR carries it for
  the common case; typing is the fallback.

## approve is bound to real enrolment

`POST /pairings/{code}/approve` (session required) flips the flag **only if a
device with the pairing's `new_pubkey` now exists under the approving user** — so
approval can't run without the signed enrolment actually having happened, and it
ties the pairing to the account that did it. The flag is just the signal N polls;
the security-bearing step is the `add_device` signature.

## Schema

```
pairings  code PK, new_pubkey, new_box_pubkey, label, approved, expires_at
```

Bump to SCHEMA_VERSION 12. Expired rows are swept on access, like challenges.

## Honest limits

- **O is protected; N trusts the approver.** The fingerprint confirms O signs the
  *right* new device — protecting the account holder from enrolling a hostile
  one, the serious direction. N joining the *wrong* account would need an attacker
  to grab N's code within the window and approve it into their own account; it
  gains them little and N would see a foreign account. A mutual fingerprint could
  close it later; out of scope for v1.
- **Both devices must be online** during the pairing window.
- **Doesn't help all-devices-lost** — that's still password/recovery's job.
- **The code is bearer within its window.** The fingerprint is what makes leaking
  it safe; short TTL and single-use bound the rest.

## Deliberately not doing

- **A mutual fingerprint** (N also verifies O). Noted above; v1 protects the
  account holder, which is the direction that matters.
- **Pairing across accounts.** A device joins the approver's account, full stop.
- **Camera QR *scanning* as a hard requirement.** Best-effort via `BarcodeDetector`
  where the browser has it; manual code entry always works.
