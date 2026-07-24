// The three ways a browser gets a session, all resolving to the same thing:
// a device keypair in IndexedDB that can sign the server's challenge.
//
//   signup  — new account, new account key, new device key
//   resume  — this device already has a key; just prove it
//   enrol   — this device has no key, but the password unwraps the account key,
//             which can authorise a new device key
//
// The server never sees a password or any private key. See plan/11.

import { api } from './api'
import { adoptApiKeysForNewDevice } from './aikeys'
import { adoptGroupsForNewDevice, forgetGroupKeys } from './groupkeys'
import { forgetLocalLedger } from './store'
import { decodeRecoveryCode, generateRecoveryCode } from './recovery'
import { createPasskey, passkeyPRF } from './webauthn'
import {
  forgetDeviceKey,
  forgetSession,
  generateAccountKey,
  generateDeviceKey,
  loadDeviceKey,
  loadSession,
  saveDeviceKey,
  saveSession,
  sign,
  unwrapAccountKey,
  unwrapAccountKeyPasskey,
  unwrapAccountKeyRecovery,
  wrapAccountKey,
  wrapAccountKeyPasskey,
  wrapAccountKeyRecovery,
} from './crypto'


const deviceLabel = () => {
  const ua = navigator.userAgent || ''
  const os =
    /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : 'browser'
  return `${os} · ${new Date().toISOString().slice(0, 10)}`
}

/** Prove possession of this device's key and get a session cookie. */
async function authenticate(device) {
  const { nonce } = await api('auth/challenge', { device_pubkey: device.pubkey })
  await api('auth/verify', {
    device_pubkey: device.pubkey,
    nonce,
    signature: await sign(device.privkey, nonce),
  })
}

export async function signup({ login_handle, display_name, password }) {
  const account = await generateAccountKey()
  const device = await generateDeviceKey()
  // A recovery code is minted at signup and wrapped alongside the password, so
  // every account has a strong way back in from the start — and one that isn't
  // hostage to how good the password is. The caller shows it once; we never
  // store the code itself, only the wrap it produced. See plan/16.
  const recovery = generateRecoveryCode()
  await api('signup', {
    login_handle,
    display_name,
    account_pubkey: account.pubkey,
    account_box_pubkey: account.box_pubkey,
    device_pubkey: device.pubkey,
    box_pubkey: device.box_pubkey,
    label: deviceLabel(),
    wraps: [
      await wrapAccountKey(account, password),
      await wrapAccountKeyRecovery(account, recovery.entropy),
    ],
  })
  // Only stored once the server has accepted it, so a failed signup doesn't
  // leave a key behind that matches no account.
  await saveDeviceKey(device)
  // A brand-new identity inherits nothing. Clear any ledger or group keys a
  // previous account left on this device, so their differently-keyed events do
  // not surface as undecryptable under this account's groups.
  forgetGroupKeys()
  await forgetLocalLedger()
  const me = await api('me')
  await saveSession(me)
  return { ...me, recoveryCode: recovery.code }
}

/** This device already holds a key. Nothing to type. */
export async function resume() {
  const device = await loadDeviceKey()
  if (!device) return null
  try {
    await authenticate(device)
    const me = await api('me')
    // Remembered so the next offline refresh has someone to be.
    await saveSession(me)
    return me
  } catch (err) {
    if (err.offline) {
      // Couldn't reach the server — not the same as being turned away. Keep the
      // key and open against whatever this device already holds. A refresh with
      // no signal must not sign you out, still less delete your only key.
      return (await loadSession()) ?? null
    }
    // The server rejected the key: this device is gone server-side — revoked
    // from another device, or the server was reset out from under us. Either
    // way its cached ledger and group keys are orphaned, and leaving them lets
    // events from a previous life collide with a group that later reuses the
    // same id (exactly what a dev-time wipe produces: they show up as
    // undecryptable under the new group's key). Clear everything, as logout does.
    await forgetDeviceKey()
    await forgetSession()
    forgetGroupKeys()
    await forgetLocalLedger()
    return null
  }
}

/** The wraps a fresh device can choose between to unlock the account. Fetched
 *  by handle — deliberately unauthenticated, since a new device holds no key
 *  yet. See plan/11. */
export async function fetchWraps(login_handle) {
  return api(`wraps?login_handle=${encodeURIComponent(login_handle)}`)
}

/** The tail shared by every enrolment path: once the account key is in hand
 *  (however it was unwrapped), authorise a brand-new device key with it, adopt
 *  the group and AI keys onto that device, and drop the account key. It is only
 *  ever in memory here, never written to storage. */
async function finishEnrol(account) {
  const device = await generateDeviceKey()
  await api('devices', {
    pubkey: device.pubkey,
    box_pubkey: device.box_pubkey,
    label: deviceLabel(),
    signed_by: 'account',
    signer_pubkey: account.pubkey,
    signature: await sign(account.privkey, device.pubkey),
  })
  await saveDeviceKey(device)
  await authenticate(device)
  // The account copies are the only ones this browser can open, so re-seal
  // them to the new device key before the account key is dropped.
  await adoptGroupsForNewDevice(account)
  await adoptApiKeysForNewDevice(account)
  const me = await api('me')
  await saveSession(me)
  return me
}

/** Fresh device, unlocked with the password. */
export async function enrol({ login_handle, password }) {
  const { wraps } = await fetchWraps(login_handle)
  const wrap = wraps.find((w) => w.method === 'password')
  // Same error whether the handle is unknown or the password is wrong, so this
  // doesn't become a way to enumerate accounts.
  if (!wrap) throw new Error('Wrong handle or password')
  const account = await unwrapAccountKey(wrap, password)
  return finishEnrol(account)
}

/** Fresh device, unlocked with the recovery code. */
export async function enrolWithRecovery({ login_handle, code }) {
  const { wraps } = await fetchWraps(login_handle)
  const wrap = wraps.find((w) => w.method === 'recovery')
  if (!wrap) throw new Error('No recovery code set for this account')
  const account = await unwrapAccountKeyRecovery(wrap, decodeRecoveryCode(code))
  return finishEnrol(account)
}

/** Fresh device, unlocked with a passkey. One prompt covers every passkey on
 *  the account: the authenticator answers for whichever it holds, and its PRF
 *  output unwraps that passkey's wrap. Nothing about the passkey reaches the
 *  server. */
export async function enrolWithPasskey({ login_handle }) {
  const { wraps } = await fetchWraps(login_handle)
  const passkeys = wraps.filter((w) => w.method === 'passkey')
  if (!passkeys.length) throw new Error('No passkey set for this account')
  const { credentialId, prfBytes } = await passkeyPRF(
    passkeys.map((w) => JSON.parse(w.params).credential_id)
  )
  const wrap = passkeys.find(
    (w) => JSON.parse(w.params).credential_id === credentialId
  )
  if (!wrap) throw new Error('That passkey is not on this account')
  const account = await unwrapAccountKeyPasskey(wrap, prfBytes)
  return finishEnrol(account)
}

/** Re-wrap the account key under a new password. Needs the old one, because the
 *  account key only exists inside the old wrap. Upserts just the password wrap,
 *  leaving any passkey or recovery wrap untouched. */
export async function changePassword({ login_handle, current, next }) {
  const { wraps } = await fetchWraps(login_handle)
  const wrap = wraps.find((w) => w.method === 'password')
  if (!wrap) throw new Error('No password set for this account')
  const account = await unwrapAccountKey(wrap, current)
  await api('wraps', await wrapAccountKey(account, next), 'POST')
}

/** Re-derive the account key from the password wrap. Adding a new unlock method
 *  from a logged-in device needs the account key, which the device deliberately
 *  never holds — so it is unwrapped fresh here and dropped. */
export async function unlockAccount({ login_handle, password }) {
  const { wraps } = await fetchWraps(login_handle)
  const wrap = wraps.find((w) => w.method === 'password')
  if (!wrap) throw new Error('This account has no password to unlock with')
  return unwrapAccountKey(wrap, password)
}

/** Mint a fresh recovery code, wrap the account key under it, and store the wrap
 *  (replacing any previous recovery code). Returns the code to show once. */
export async function addRecoveryWrap(account) {
  const recovery = generateRecoveryCode()
  await api(
    'wraps',
    await wrapAccountKeyRecovery(account, recovery.entropy),
    'POST'
  )
  return recovery.code
}

/** Create a passkey and wrap the account key under its PRF secret. The account
 *  must already be unlocked (the device never holds it). Returns the new wrap's
 *  label. */
export async function addPasskey(account, { userId, userName }) {
  const { credentialId, prfBytes, label } = await createPasskey({
    userId,
    userName,
  })
  await api(
    'wraps',
    await wrapAccountKeyPasskey(account, prfBytes, {
      id: `passkey:${credentialId}`,
      credentialId,
      label,
    }),
    'POST'
  )
  return label
}

/** List the account's unlock methods, for showing and managing them. */
export async function listWraps(login_handle) {
  const { wraps } = await fetchWraps(login_handle)
  return wraps ?? []
}

/** Remove one unlock method. The server refuses to remove the last one. */
export async function removeWrap(id) {
  await api(`wraps/${encodeURIComponent(id)}`, undefined, 'DELETE')
}

/** Log out, which means un-enrolling this browser.
 *
 *  The device key alone can sign the server's challenge, so a browser that
 *  keeps its key after logging out is one that anyone can walk up to and sign
 *  back in on. Keeping it was the earlier design and it was wrong: on a shared
 *  computer "log out" has to mean it.
 *
 *  The server deletes the device; this drops the key that would have proved
 *  ownership of it. Getting back in needs the password, via enrol(). */
export async function logout() {
  try {
    await api('logout', {})
  } catch {
    // Offline, so the device can't be deleted server-side right now — the row
    // lingers until it's revoked from another device. But logging out still
    // has to clear everything local: on a shared computer that is the whole
    // point, and it must not depend on there being a signal.
  }
  await forgetDeviceKey()
  await forgetSession()
  forgetGroupKeys()
  // The local ledger goes too. It outlives the credentials that justified it
  // otherwise — and on a shared computer that is the whole group's history
  // sitting there after someone thought they had left.
  await forgetLocalLedger()
}
