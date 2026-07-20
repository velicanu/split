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
import {
  forgetDeviceKey,
  generateAccountKey,
  generateDeviceKey,
  loadDeviceKey,
  saveDeviceKey,
  sign,
  unwrapAccountKey,
  wrapAccountKey,
} from './crypto'


// Signing out has to outlive a refresh. The device key alone is enough to
// authenticate, so without a record of the decision, logging out and reloading
// would put you straight back in — logout would be indistinguishable from a
// page reload.
//
// localStorage rather than the key store: this is a preference about this
// browser, not key material, and it must be readable before any async work so
// the app never flashes a signed-in frame on the way to the sign-in screen.
const SIGNED_OUT = 'split.signed-out'

const isSignedOut = () => localStorage.getItem(SIGNED_OUT) === '1'

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
  const wrap = await wrapAccountKey(account, password)
  await api('signup', {
    login_handle,
    display_name,
    account_pubkey: account.pubkey,
    account_box_pubkey: account.box_pubkey,
    device_pubkey: device.pubkey,
    box_pubkey: device.box_pubkey,
    label: deviceLabel(),
    wraps: [wrap],
  })
  // Only stored once the server has accepted it, so a failed signup doesn't
  // leave a key behind that matches no account.
  await saveDeviceKey(device)
  localStorage.removeItem(SIGNED_OUT)
  return api('me')
}

async function authenticateStoredDevice() {
  const device = await loadDeviceKey()
  if (!device) return null
  try {
    await authenticate(device)
    return await api('me')
  } catch {
    // The key is unknown or revoked — most likely this device was revoked from
    // somewhere else. Drop it so the UI offers a fresh sign-in.
    await forgetDeviceKey()
    return null
  }
}

/** This device already holds a key. Nothing to type — unless the last thing
 *  that happened here was someone deliberately signing out. */
export async function resume() {
  if (isSignedOut()) return null
  return authenticateStoredDevice()
}

/** Sign back in on a device that is still enrolled: one click, no password.
 *  Separate from resume() precisely because it has to be deliberate. */
export async function signBackIn() {
  localStorage.removeItem(SIGNED_OUT)
  return authenticateStoredDevice()
}

/** Whether this browser still holds a device key, and so can sign back in
 *  without a password. */
export async function enrolledHere() {
  return !!(await loadDeviceKey())
}

/** Fresh device: unwrap the account key with the password, then use it to
 *  authorise a brand-new device key. The account key is used and dropped —
 *  it is never written to storage. */
export async function enrol({ login_handle, password }) {
  const { wraps } = await api(
    `wraps?login_handle=${encodeURIComponent(login_handle)}`
  )
  const wrap = wraps.find((w) => w.method === 'password')
  // Same error whether the handle is unknown or the password is wrong, so this
  // doesn't become a way to enumerate accounts.
  if (!wrap) throw new Error('Wrong handle or password')
  const account = await unwrapAccountKey(wrap, password)

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
  localStorage.removeItem(SIGNED_OUT)
  return api('me')
}

/** Re-wrap the account key under a new password. Needs the old one, because
 *  the account key only exists inside the old wrap. */
export async function changePassword({ login_handle, current, next }) {
  const { wraps } = await api(
    `wraps?login_handle=${encodeURIComponent(login_handle)}`
  )
  const wrap = wraps.find((w) => w.method === 'password')
  if (!wrap) throw new Error('No password set for this account')
  const account = await unwrapAccountKey(wrap, current)
  await api('wraps', { wraps: [await wrapAccountKey(account, next)] }, 'PUT')
}

export async function logout() {
  await api('logout', {})
  forgetGroupKeys()
  // Recorded so a refresh does not undo it. The device key stays — this
  // browser is still enrolled, so signing back in needs no password. Revoking
  // is the deliberate, separate act.
  localStorage.setItem(SIGNED_OUT, '1')
}
