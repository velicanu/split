// A short verification string over a device's public key, shown on both devices
// during pairing so the humans can confirm they match before the old device
// signs the new one's key. Emoji: language-neutral, quick to compare, and
// visually distinct from the pairing code so the two aren't confused.
//
// 36 bits (6 emoji from a table of 64). Ample here: forging a key to a target
// fingerprint needs the target first, which needs the other device's
// short-lived code — circular — and the pairing window is short. See plan/17.

import sodium from 'libsodium-wrappers-sumo'

const ready = sodium.ready

// 64 distinct, widely-rendered emoji — 6 bits each.
const EMOJI = [
  '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼',
  '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
  '🐧', '🐦', '🦆', '🦉', '🐴', '🦄', '🐝', '🐛',
  '🦋', '🐌', '🐞', '🐢', '🐍', '🐙', '🦀', '🐠',
  '🐬', '🐳', '🌵', '🌲', '🌸', '🌻', '🌈', '⭐',
  '🔥', '💧', '🍎', '🍊', '🍋', '🍉', '🍓', '🍒',
  '🍑', '🥝', '🥑', '🌽', '🥕', '🍔', '🍕', '🍦',
  '🍩', '🍪', '🎈', '🎁', '🎸', '🚀', '⚓', '🎵',
]

/** Six emoji derived from a public key. Deterministic, so both devices compute
 *  the same string from the same key. */
export async function deviceFingerprint(pubkeyB64) {
  await ready
  const bytes = sodium.from_base64(pubkeyB64, sodium.base64_variants.ORIGINAL)
  const hash = sodium.crypto_generichash(32, bytes)
  const out = []
  let acc = 0
  let bits = 0
  for (const byte of hash) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 6 && out.length < 6) {
      bits -= 6
      out.push(EMOJI[(acc >> bits) & 63])
    }
    if (out.length === 6) break
  }
  return out.join(' ')
}
