// A standalone shared bill (plan/15): one receipt, split by claiming, no
// accounts for the people claiming. The static half — items, who paid, the
// receipt image — is sealed once by the logged-in creator; the mutable half is
// each participant's claims. This module is the whole client side of that: seal
// and publish, load and fold, join and claim.
//
// It deliberately reuses the group's split maths (receiptWeights ->
// splitByWeights, and simplify for who-owes-whom), so a bill and a group
// compute a receipt the same way. Participant ids are numbers for exactly that
// reason — those functions key on numeric ids.

import { api } from './api'
import {
  contentId,
  decryptBytes,
  decryptPayload,
  encryptBytes,
  encryptPayload,
  generateGroupKey,
} from './crypto'
import { prepareImage } from './ai'
import { receiptWeights, simplify, splitByWeights } from './ledger'

const header = (token) => ({ 'X-Bill-Token': token })

const bytesToB64 = (bytes) => {
  let s = ''
  for (const byte of bytes) s += String.fromCharCode(byte)
  return btoa(s)
}

// A random positive participant id, small enough to stay a safe integer. Each
// browser mints its own — the server enforces uniqueness — so no coordination
// is needed for two people to join at once. Mirrors the group's ghost ids.
function randomId() {
  const a = new Uint32Array(2)
  crypto.getRandomValues(a)
  return a[0] * 8192 + (a[1] % 8192) + 1
}

// The join secret: the account-less stand-in for membership. Whoever holds it
// owns that participant's claims. Unguessable, and never leaves the client
// except to the server, which only ever compares it.
function randomSecret() {
  const a = new Uint8Array(24)
  crypto.getRandomValues(a)
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const sealName = (key, name) => encryptPayload(key, { display_name: name })

/** Publish a bill. Seals the static snapshot and every seeded name under a
 *  fresh bill key, uploads the receipt image sealed too, and returns the link
 *  parts: the id and token the server minted, plus the key that never touched
 *  it. `participants` are the diners the creator seeds as ghosts. */
export async function createBill({ snapshot, participants = [], receiptFile }) {
  const key = await generateGroupKey()

  const receipts = []
  const receiptIds = []
  if (receiptFile) {
    const { base64 } = await prepareImage(receiptFile)
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const sealed = await encryptBytes(key, raw)
    const receipt_id = await contentId(sealed)
    receipts.push({ receipt_id, ciphertext: bytesToB64(sealed) })
    receiptIds.push(receipt_id)
  }

  const sealedSnapshot = await encryptPayload(key, { ...snapshot, receipts: receiptIds })
  const sealedParticipants = await Promise.all(
    participants.map(async (p) => ({
      participant_id: p.participant_id,
      name: await sealName(key, p.name),
    }))
  )

  const res = await api('bills', {
    snapshot: sealedSnapshot,
    participants: sealedParticipants,
    receipts,
  })
  return { billId: res.id, token: res.token, key }
}

// items (each with a resolved claimed_by) + participants -> the split. Unclaimed
// items spread across everyone, exactly as a group receipt does — this is the
// same maths, on purpose (plan/15).
function foldSplit(items, payers, totalCents, participants) {
  const ids = participants.map((p) => p.participant_id)
  const weights = receiptWeights(items, ids)
  const owed = splitByWeights(totalCents, weights)

  const paid = {}
  for (const pay of payers || []) {
    paid[pay.participant_id] = (paid[pay.participant_id] || 0) + (pay.paid_cents || 0)
  }

  const balances = participants.map((p) => ({
    user_id: p.participant_id,
    display_name: p.name,
    net_cents: (paid[p.participant_id] || 0) - (owed[p.participant_id] || 0),
  }))
  return {
    owed,
    paid,
    balances,
    transfers: simplify(balances),
  }
}

/** Fetch, decrypt, and fold a bill for a link-holder. Skips anything that will
 *  not decrypt (a mangled link) rather than blanking the view. */
export async function loadBill({ billId, key, token }) {
  const res = await api(`bills/${billId}`, undefined, 'GET', header(token))
  const snapshot = await decryptPayload(key, res.snapshot)

  let unreadable = 0
  const participants = []
  for (const p of res.participants) {
    let name
    try {
      name = (await decryptPayload(key, p.name)).display_name
    } catch {
      unreadable += 1
      continue
    }
    let claimedItemIds = []
    if (p.claims) {
      try {
        claimedItemIds = (await decryptPayload(key, p.claims)).item_ids || []
      } catch {
        // A claims blob we can't open — treat it as no claims rather than
        // dropping the whole participant.
        claimedItemIds = []
      }
    }
    participants.push({
      participant_id: p.participant_id,
      name,
      claimed: p.claimed,
      claimed_item_ids: claimedItemIds,
    })
  }

  const items = (snapshot.items || []).map((it) => ({
    ...it,
    claimed_by: participants
      .filter((p) => p.claimed_item_ids.includes(it.id))
      .map((p) => p.participant_id),
  }))

  const split = foldSplit(items, snapshot.payers, snapshot.total_cents || 0, participants)

  return { billId, key, token, snapshot, participants, items, split, unreadable }
}

/** Add yourself to a bill under a new name. Returns the identity to remember. */
export async function joinBill({ billId, key, token }, name) {
  const participant_id = randomId()
  const secret = randomSecret()
  await api(
    `bills/${billId}/participants`,
    { participant_id, name: await sealName(key, name), secret },
    'POST',
    header(token)
  )
  return { participant_id, secret }
}

/** Take over a seeded ghost. First bind wins on the server; a 409 means someone
 *  else got there first. */
export async function claimGhost({ billId, token }, participantId) {
  const secret = randomSecret()
  await api(
    `bills/${billId}/participants/${participantId}/claim`,
    { secret },
    'POST',
    header(token)
  )
  return { participant_id: participantId, secret }
}

/** Replace my claimed item ids. The secret proves the row is mine. */
export async function setClaims({ billId, key, token }, participantId, secret, itemIds) {
  await api(
    `bills/${billId}/participants/${participantId}/claims`,
    { secret, claims: await encryptPayload(key, { item_ids: itemIds }) },
    'PUT',
    header(token)
  )
}

// Who I am on this bill, per browser. localStorage rather than the key store:
// no account, no device key, just a small bearer identity scoped to one bill.
// Best-effort — a browser with storage blocked simply re-joins each visit.
const meKey = (billId) => `split-bill-${billId}`

export function rememberMe(billId, identity) {
  try {
    localStorage.setItem(meKey(billId), JSON.stringify(identity))
  } catch {
    // storage disabled or full — nothing to do
  }
}

export function loadMe(billId) {
  try {
    const raw = localStorage.getItem(meKey(billId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// --- receipt image, via the bill token --------------------------------

async function fetchBillReceipt(billId, receiptId, { key, token }) {
  const res = await fetch(`/api/bills/${billId}/receipts/${receiptId}`, {
    headers: header(token),
  })
  if (!res.ok) throw new Error("Couldn't load that receipt")
  const sealed = new Uint8Array(await res.arrayBuffer())
  if ((await contentId(sealed)) !== receiptId) {
    throw new Error('That receipt does not match its address')
  }
  return decryptBytes(key, sealed)
}

const urls = new Map()

export async function billReceiptUrl(billId, receiptId, access) {
  if (urls.has(receiptId)) return urls.get(receiptId)
  const bytes = await fetchBillReceipt(billId, receiptId, access)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
  urls.set(receiptId, url)
  return url
}

export function forgetBillReceipts() {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
}
