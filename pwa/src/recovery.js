// The recovery code: a high-entropy secret the machine generates, which wraps
// the account key (crypto.js) so a fresh device can bootstrap with no password
// and no other device. Because it is 128 random bits, it needs no slow KDF and
// the offline-crack risk that dogs a password wrap simply doesn't apply.
//
// Encoded in Crockford base32 — no I/L/O/U, so it survives being read aloud or
// written on paper — grouped, with a check symbol that catches most typos
// before we even try to decrypt. See plan/16.
//
// It is deliberately NOT BIP39: a 2048-word list is only worth its weight when
// you interoperate with other wallets, which we never do, and it is one more big
// asset to ship and keep correct. A self-contained base32 code is simpler and
// exactly as strong.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ENTROPY_BYTES = 16 // 128 bits
const DATA_SYMBOLS = Math.ceil((ENTROPY_BYTES * 8) / 5) // 26

// Bytes -> 5-bit symbols (big-endian bit order), padding the final symbol.
function toSymbols(bytes) {
  const out = []
  let acc = 0
  let bits = 0
  for (const byte of bytes) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push((acc >> bits) & 31)
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31)
  return out
}

// 5-bit symbols -> bytes, keeping the first ENTROPY_BYTES (the tail bits are
// padding).
function fromSymbols(symbols) {
  const bytes = []
  let acc = 0
  let bits = 0
  for (const s of symbols) {
    acc = (acc << 5) | s
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes.slice(0, ENTROPY_BYTES))
}

// A single check symbol over the data symbols. Not cryptographic — it only
// turns a mistyped code into a clear "that code isn't right" instead of a
// failed decrypt further along.
const checkSymbol = (symbols) =>
  symbols.reduce((sum, s) => sum + s, 0) % ALPHABET.length

const group = (s) => s.match(/.{1,5}/g).join('-')

function format(symbols) {
  const body = symbols.map((s) => ALPHABET[s]).join('')
  return group(body + ALPHABET[checkSymbol(symbols)])
}

/** A fresh recovery code and the raw entropy behind it. Show the code once and
 *  wrap the account key under the entropy; we never store the code. */
export function generateRecoveryCode() {
  const entropy = new Uint8Array(ENTROPY_BYTES)
  crypto.getRandomValues(entropy)
  return { code: format(toSymbols(entropy)), entropy }
}

// Crockford normalisation: upper-case, and the look-alikes fold to digits.
function normalize(code) {
  return String(code)
    .toUpperCase()
    .replace(/[ILO]/g, (c) => ({ I: '1', L: '1', O: '0' })[c])
    .split('')
    .filter((c) => ALPHABET.includes(c))
    .join('')
}

/** Recover the entropy from a typed code, or throw if it is the wrong length or
 *  fails its check symbol. A wrong-but-well-formed code still fails later at the
 *  decrypt; this is only the early, friendly rejection. */
export function decodeRecoveryCode(code) {
  const clean = normalize(code)
  if (clean.length !== DATA_SYMBOLS + 1) {
    throw new Error('That recovery code is the wrong length')
  }
  const symbols = [...clean].map((c) => ALPHABET.indexOf(c))
  const data = symbols.slice(0, DATA_SYMBOLS)
  if (symbols[DATA_SYMBOLS] !== checkSymbol(data)) {
    throw new Error("That recovery code doesn't look right — check for a typo")
  }
  return fromSymbols(data)
}
