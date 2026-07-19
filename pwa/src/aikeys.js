// LLM provider API keys, sealed the same way group keys are.
//
// The key is a live billable credential, so it gets the same treatment as
// everything else rather than being the one plaintext exception: sealed on
// this device, relayed by a server that cannot open it, opened again on each
// of your own devices.
//
// Sealed to two kinds of recipient, for the same reasons as group keys:
//   device  — everyday use; this browser opens its own copy directly
//   account — the bootstrap copy, so a device enrolled later with only a
//             password picks the key up without the original device being
//             online, or ever coming back
//
// See plan/11-identity-and-devices.md.

import { api } from './api'
import { loadDeviceKey, openSealedText, sealText } from './crypto'

/** Seal `apiKey` to every live device and to the account, then upload. */
export async function saveApiKey(provider, apiKey) {
  const me = await api('me')
  const { account_box_pubkey } = await api('account/box')
  const { devices } = await api('devices')

  const keys = [
    {
      recipient_kind: 'account',
      recipient_id: String(me.id),
      ciphertext: await sealText(account_box_pubkey, apiKey),
    },
  ]
  // Every live device, not just this one — otherwise the key would only reach
  // your other devices if they happened to re-enrol.
  for (const d of devices.filter((d) => !d.revoked_at)) {
    keys.push({
      recipient_kind: 'device',
      recipient_id: d.id,
      ciphertext: await sealText(d.box_pubkey, apiKey),
    })
  }
  await api(`ai/providers/${provider}/keys`, { keys })
}

/** Open the copy sealed to this device. */
export async function openApiKey(sealedKey) {
  if (!sealedKey) return null
  const device = await loadDeviceKey()
  if (!device) return null
  try {
    return await openSealedText(device.box_pubkey, device.box_privkey, sealedKey)
  } catch {
    // Sealed to a device key this browser no longer holds.
    return null
  }
}

/** Turn the server's settings into what the UI wants, opening each key here.
 *  Shape matches what the rest of the app already expects, so nothing
 *  downstream needs to know the key arrived sealed. */
export async function loadAiSettings() {
  const settings = await api('ai/settings')
  const providers = {}
  for (const [id, p] of Object.entries(settings.providers ?? {})) {
    providers[id] = {
      model: p.model,
      api_key: await openApiKey(p.sealed_key),
      // A key exists on the account but is not readable here — a device that
      // enrolled before the key was saved and has not picked it up yet.
      locked: !!p.sealed_key === false,
    }
  }
  return { active: settings.active, providers }
}

/** During enrolment: the account copy is the only one a brand-new device can
 *  open, so re-seal each provider's key to the new device key. The account
 *  secret is passed in and never stored. */
export async function adoptApiKeysForNewDevice(accountKey) {
  // Scanning is optional; enrolling is not. Nothing in here may prevent a
  // device from finishing sign-in, or a user with no AI key at all could be
  // locked out by a feature they never enabled.
  let me
  let settings
  try {
    me = await api('me')
    settings = await api('ai/settings')
  } catch {
    return
  }
  for (const provider of Object.keys(settings.providers ?? {})) {
    try {
      const { keys } = await api(`ai/providers/${provider}/keys`)
      const viaAccount = keys.find((k) => k.recipient_kind === 'account')
      if (!viaAccount) continue
      const apiKey = await openSealedText(
        accountKey.box_pubkey,
        accountKey.box_privkey,
        viaAccount.ciphertext
      )
      const device = await loadDeviceKey()
      await api(`ai/providers/${provider}/keys`, {
        keys: [
          {
            recipient_kind: 'device',
            recipient_id: me.device_id,
            ciphertext: await sealText(device.box_pubkey, apiKey),
          },
        ],
      })
    } catch {
      // One unreadable provider must not stop the others being recovered.
    }
  }
}
