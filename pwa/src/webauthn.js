// WebAuthn, used for one thing only: deriving a stable high-entropy secret from
// a passkey via the PRF extension, to wrap the account key (crypto.js). The
// server never sees any of this and does no WebAuthn verification — no assertion
// checking, no credential store, no attestation. The passkey ceremony happens
// entirely on the client; the server only ever holds the resulting opaque wrap.
// See plan/16.
//
// This can't run in the unit/live harness (jsdom has no authenticator), so the
// ceremony is kept thin and the wrap/unwrap around it is what the tests cover,
// with navigator.credentials stubbed.

const RP_NAME = 'Split'
const rpId = () => window.location.hostname

// A fixed PRF input, shared by every passkey on the account. Because it's
// constant, a fresh device can evaluate PRF over all of the account's passkeys
// in one prompt and let the authenticator answer for whichever it holds.
const PRF_SALT = new TextEncoder().encode('split.account-key.prf.v1')

const rand = (n) => {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return a
}
const toB64 = (bytes) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const fromB64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0))
const toB64url = (bytes) =>
  toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Whether this browser can do WebAuthn at all. PRF specifically can't be known
 *  until we try, so creation still has to handle its absence. */
export function passkeySupported() {
  return (
    typeof window !== 'undefined' &&
    !!window.PublicKeyCredential &&
    !!navigator.credentials
  )
}

const CANT_DERIVE = "This device's passkey can't derive a key"
// PRF is an optional extension; not every passkey provider implements the
// hmac-secret it rides on. KeePassDX, for one, doesn't — the credential is
// created fine but yields no PRF, so it can't unlock the account. The fix is a
// provider that does support it, or the password / recovery code.
const USE_INSTEAD =
  'Use a provider that supports PRF (Google Password Manager, iCloud Keychain, or a security key), or sign in with your password or recovery code.'

// Distinguish the failure shapes so a report from a real device pins down the
// cause:
//   - no prf output at all  -> the provider ignored the extension (e.g. KeePassDX)
//   - enabled === false     -> the passkey has no PRF (no hmac-secret)
//   - enabled, no results   -> PRF ran but returned nothing (a request problem)
function prfDiagnostic(prf) {
  if (!prf) {
    return `${CANT_DERIVE}: your passkey provider doesn't support PRF. ${USE_INSTEAD}`
  }
  if (prf.enabled === false) {
    return `${CANT_DERIVE}: this passkey has no PRF (hmac-secret). ${USE_INSTEAD}`
  }
  return `${CANT_DERIVE}: PRF was enabled but returned no value. ${USE_INSTEAD}`
}

// The PRF output from a create() or get() result, or null if absent. Browsers
// differ on when results arrive: Chrome can return them from create(), others
// only from a get() — so callers try create first, then fall back.
function prfBytesOf(credential) {
  const prf = credential?.getClientExtensionResults?.().prf
  const first = prf?.results?.first
  return { prf, bytes: first ? new Uint8Array(first) : null }
}

const prfValues = () => ({ first: PRF_SALT })
const passkeyLabel = () => `passkey · ${new Date().toISOString().slice(0, 10)}`

// Evaluate PRF for a set of credentials in one get() ceremony; returns which
// credential answered and the secret it produced. Requests PRF both ways —
// top-level `eval` and per-credential `evalByCredential` — because some Chrome
// builds honour only the latter once `allowCredentials` is set. User
// verification is required: the hmac-secret behind PRF is released only when it
// happens.
async function evaluatePRF(allowCredentials) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      // The server verifies nothing, so the challenge is unused — but it must be
      // present and fresh for the ceremony to run.
      challenge: rand(32),
      rpId: rpId(),
      allowCredentials: allowCredentials.map((id) => ({
        type: 'public-key',
        id: fromB64(id),
      })),
      userVerification: 'required',
      extensions: {
        prf: {
          eval: prfValues(),
          evalByCredential: Object.fromEntries(
            allowCredentials.map((id) => [toB64url(fromB64(id)), prfValues()])
          ),
        },
      },
    },
  })
  const { prf, bytes } = prfBytesOf(assertion)
  if (!bytes) throw new Error(prfDiagnostic(prf))
  return { credentialId: toB64(new Uint8Array(assertion.rawId)), prf: bytes }
}

/** Create a passkey (enabling PRF), then derive its secret. Returns the pieces a
 *  passkey wrap needs. */
export async function createPasskey({ userId, userName }) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: rand(32),
      rp: { id: rpId(), name: RP_NAME },
      user: {
        id: new TextEncoder().encode(String(userId)),
        name: userName,
        displayName: userName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      extensions: { prf: { eval: prfValues() } },
    },
  })
  if (!cred) throw new Error('Passkey setup was cancelled')
  const credentialId = toB64(new Uint8Array(cred.rawId))
  const created = prfBytesOf(cred)
  // Best case, and the common one on Chrome/Android: the secret is on the create
  // itself — no second prompt.
  if (created.bytes) {
    return { credentialId, prfBytes: created.bytes, label: passkeyLabel() }
  }
  // No secret, and either no PRF object at all (the provider ignored the
  // extension) or a firm enabled:false — a get() cannot conjure PRF a provider
  // doesn't have, so fail now rather than firing a second, pointless prompt.
  if (!created.prf || created.prf.enabled === false) {
    throw new Error(prfDiagnostic(created.prf))
  }
  // PRF is enabled but the value only comes at get-time (some browsers): derive.
  const prfBytes = (await evaluatePRF([credentialId])).prf
  return { credentialId, prfBytes, label: passkeyLabel() }
}

/** Re-derive the secret for a set of existing passkey wraps, in one prompt.
 *  Returns { credentialId, prfBytes } for whichever the authenticator holds, so
 *  the caller can pick the matching wrap. */
export async function passkeyPRF(credentialIds) {
  const { credentialId, prf } = await evaluatePRF(credentialIds)
  return { credentialId, prfBytes: prf }
}
