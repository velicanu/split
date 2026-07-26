// Adding a device from one you're already signed in on (plan/17). The new
// device advertises its public keys and shows a code + fingerprint; the old
// device reads the keys, confirms the fingerprint matches, signs the new key,
// and seals every group key to it — all without the account key.

import { api } from './api'
import { authenticate, deviceLabel } from './auth'
import { generateDeviceKey, sign } from './crypto'
import { deviceFingerprint } from './fingerprint'
import { forgetGroupKeys, sealGroupsToDevice } from './groupkeys'
import { forgetLocalLedger, loadDeviceKey, saveDeviceKey, saveSession } from './store'

/** The QR / deep link a new device shows; scanning it pre-fills the code on the
 *  old device. It carries only the code — a pointer, not a secret. */
export const pairLink = (origin, code) => `${origin}/#pair=${code}`

/** Pull a pairing code out of a scanned link or a typed code, or null. */
export function parsePairCode(input) {
  if (!input) return null
  const s = String(input).trim()
  const m = s.match(/[#&?]pair=([^&\s]+)/)
  if (m) return decodeURIComponent(m[1])
  return /^[\w-]{6,}$/.test(s) ? s : null
}

// --- new device -------------------------------------------------------

/** Generate this device's key and register it for pairing. Returns the code and
 *  fingerprint to display, and the device key to finish with once approved. */
export async function startPairing() {
  const device = await generateDeviceKey()
  const { code } = await api('pairings', {
    new_pubkey: device.pubkey,
    new_box_pubkey: device.box_pubkey,
    label: deviceLabel(),
  })
  return { code, device, fingerprint: await deviceFingerprint(device.pubkey) }
}

/** Has the old device approved yet? Polled by the new device. */
export async function pairingApproved(code) {
  const r = await api(`pairings/${code}`, undefined, 'GET')
  return r.approved
}

/** Finish on the new device once approved: the device row and its sealed group
 *  keys now exist, so authenticate and settle in. Clears any prior account's
 *  cached data, like signup/enrol. */
export async function completePairing(device) {
  await authenticate(device)
  await saveDeviceKey(device)
  forgetGroupKeys()
  await forgetLocalLedger()
  const me = await api('me')
  await saveSession(me)
  return me
}

// --- old device -------------------------------------------------------

/** Read a pending pairing and the fingerprint to confirm against the new
 *  device's screen. */
export async function fetchPairing(code) {
  const p = await api(`pairings/${code}`, undefined, 'GET')
  return { ...p, code, fingerprint: await deviceFingerprint(p.new_pubkey) }
}

/** Approve, after the human confirmed the fingerprints match: sign the new
 *  device's key into this account, seal every group key to it, then flip the
 *  flag the new device is polling. */
export async function approvePairing(pairing) {
  const device = await loadDeviceKey()
  if (!device) throw new Error('This device is not signed in')
  const { device_id } = await api('devices', {
    pubkey: pairing.new_pubkey,
    box_pubkey: pairing.new_box_pubkey,
    label: pairing.label,
    signed_by: 'device',
    signer_pubkey: device.pubkey,
    signature: await sign(device.privkey, pairing.new_pubkey),
  })
  await sealGroupsToDevice(device_id, pairing.new_box_pubkey)
  await api(`pairings/${pairing.code}/approve`, {})
}
