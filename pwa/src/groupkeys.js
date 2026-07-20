// Getting a group's symmetric key onto the devices entitled to it.
//
// Nobody ever wraps a key for anyone else. You obtain the key — by creating the
// group, or from an invite link's URL fragment — and then seal it to your own
// account and your own devices. The server relays sealed blobs it cannot open
// and enforces only that you address yourself.
//
// Two recipients per device-owner, for different jobs:
//   device  — everyday use; the key this browser can open directly
//   account — the bootstrap copy, so a device enrolled with only a password
//             can recover group access without another device's help
//
// See plan/11-identity-and-devices.md.

import { api } from './api'
import { localGroupKey, saveGroupKey } from './store'
import {
  generateGroupKey,
  loadDeviceKey,
  openSealed,
  sealTo,
} from './crypto'

const cache = new Map()

/** Seal `groupKey` to this device and to the account, and upload both. */
export async function publishGroupKey(groupId, groupKey, accountBoxPubkey) {
  const device = await loadDeviceKey()
  const me = await api('me')
  const { account_box_pubkey } =
    accountBoxPubkey === undefined
      ? await api('account/box')
      : { account_box_pubkey: accountBoxPubkey }

  await api(`groups/${groupId}/keys`, {
    keys: [
      {
        recipient_kind: 'device',
        recipient_id: me.device_id,
        ciphertext: await sealTo(device.box_pubkey, groupKey),
      },
      {
        recipient_kind: 'account',
        recipient_id: String(me.id),
        ciphertext: await sealTo(account_box_pubkey, groupKey),
      },
    ],
  })
  cache.set(groupId, groupKey)
  await saveGroupKey(groupId, groupKey)
}

/** The key for a group, or null if this device has no copy it can open.
 *
 *  Checked in order of what still works with no network: memory, then this
 *  device's own store, then the server. Without the local copy a group would
 *  be unreadable offline — the events are here, but nothing could open them,
 *  which is the same as having nothing. See plan/04. */
export async function groupKey(groupId) {
  if (cache.has(groupId)) return cache.get(groupId)

  const saved = await localGroupKey(groupId)
  if (saved) {
    cache.set(groupId, saved)
    return saved
  }

  const device = await loadDeviceKey()
  if (!device) return null
  let keys
  try {
    ;({ keys } = await api(`groups/${groupId}/keys`))
  } catch {
    // Offline, and nothing stored here yet.
    return null
  }
  const mine = keys.find((k) => k.recipient_kind === 'device')
  if (!mine) return null
  try {
    const key = await openSealed(
      device.box_pubkey,
      device.box_privkey,
      mine.ciphertext
    )
    cache.set(groupId, key)
    await saveGroupKey(groupId, key)
    return key
  } catch {
    // Sealed to a device key this browser no longer holds.
    return null
  }
}

export async function createGroupKey(groupId) {
  const key = await generateGroupKey()
  await publishGroupKey(groupId, key)
  await saveGroupKey(groupId, key)
  return key
}

/** After enrolling a fresh device: the account copy is the only one this
 *  browser can open, so re-seal each group's key to the new device key.
 *  The account secret is passed in and never stored. */
export async function adoptGroupsForNewDevice(accountKey) {
  const device = await loadDeviceKey()
  const me = await api('me')
  const groups = await api('groups')
  for (const g of groups.groups ?? groups) {
    try {
      const { keys } = await api(`groups/${g.id}/keys`)
      const viaAccount = keys.find((k) => k.recipient_kind === 'account')
      if (!viaAccount) continue
      const key = await openSealed(
        accountKey.box_pubkey,
        accountKey.box_privkey,
        viaAccount.ciphertext
      )
      await api(`groups/${g.id}/keys`, {
        keys: [
          {
            recipient_kind: 'device',
            recipient_id: me.device_id,
            ciphertext: await sealTo(device.box_pubkey, key),
          },
        ],
      })
      cache.set(g.id, key)
    } catch {
      // One unreadable group must not stop the others being recovered.
    }
  }
}

export function forgetGroupKeys() {
  cache.clear()
}
