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
  wrapAccountKey,
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
  const me = await api('me')
  await saveSession(me)
  return me
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
    // The server rejected the key: revoked from another device. Drop it so the
    // UI offers a fresh sign-in.
    await forgetDeviceKey()
    await forgetSession()
    return null
  }
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
  const me = await api('me')
  await saveSession(me)
  return me
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
