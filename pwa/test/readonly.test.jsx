// The account-less read-only view behind a share link: it fetches with the
// read token, decrypts with the key from the link (no device key), folds, and
// shows the group — with no way to edit anything. See readonly.js, viewlink.js.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { ReadOnlyGroup } from '../src/components/ReadOnlyGroup.jsx'
import {
  contentId,
  encryptBytes,
  encryptPayload,
  generateGroupKey,
} from '../src/crypto.js'
import { forgetGroupKeys } from '../src/groupkeys.js'
import { forgetReceipts } from '../src/receipts.js'
import { $, $$, byText, click, mount, text, unmount } from './react.mjs'

const member = (id, name) => ({
  id,
  type: 'member.added',
  payload: { user_id: id, display_name: name },
})

async function serve(key, extra = [], { name = 'Trip', receipt = false } = {}) {
  const blobs = new Map()
  let receiptId = null
  if (receipt) {
    const sealed = await encryptBytes(key, new Uint8Array([1, 2, 3, 4]))
    receiptId = await contentId(sealed)
    blobs.set(receiptId, sealed)
  }
  const dinner = {
    id: 3,
    type: 'expense.created',
    payload: {
      enc: await encryptPayload(key, {
        expense_id: 'e1',
        description: 'Dinner at the pier',
        amount_cents: 1000,
        payers: [{ user_id: 1, paid_cents: 1000 }],
        splits: [
          { user_id: 1, share_cents: 500 },
          { user_id: 2, share_cents: 500 },
        ],
        date: '2026-01-01',
        receipts: receiptId ? [receiptId] : [],
      }),
    },
  }
  const events = [member(1, 'v'), member(2, 'd'), dinner, ...extra]
  const json = (b) => ({ ok: true, json: async () => b })
  globalThis.fetch = async (url, opts) => {
    const p = String(url)
    // The token has to be present — this path exists only for read-token access.
    if (!opts?.headers?.['X-Read-Token']) return { ok: false, status: 401, json: async () => ({}) }
    if (p.match(/\/api\/groups\/7$/)) return json({ id: 7, name, read_only: true })
    if (p.includes('/events')) return json({ version: events.at(-1).id, events })
    if (p.includes('/receipts/')) {
      const bytes = blobs.get(p.split('/receipts/')[1])
      if (!bytes) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(0) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
}

const link = (over = {}) => ({ groupId: 7, gk: KEY, readToken: 'rt', code: 'abc', ...over })
let KEY

afterEach(async () => {
  await unmount()
  forgetGroupKeys()
  forgetReceipts()
})

describe('the read-only share view', () => {
  test('decrypts and shows the group with no account', async () => {
    KEY = await generateGroupKey()
    await serve(KEY)
    await mount(<ReadOnlyGroup link={link()} user={null} onExit={() => {}} />)

    assert.ok(text().includes('Trip'), 'the group name')
    assert.ok(text().includes('Dinner at the pier'), 'the expense, decrypted')
    assert.ok(text().includes('is owed $5.00'), 'balances are folded')
    assert.ok(text().includes('owes $5.00'))
    assert.ok(text().includes('read-only'))
  })

  test('offers no way to edit anything', async () => {
    KEY = await generateGroupKey()
    await serve(KEY)
    await mount(<ReadOnlyGroup link={link()} user={null} onExit={() => {}} />)

    assert.equal(byText('h3', 'Add an expense'), undefined)
    assert.equal(byText('button', 'edit'), undefined)
    assert.equal(byText('button', 'delete'), undefined)
    assert.equal(byText('button', 'Settle up'), undefined)
  })

  test('a signed-in visitor is offered how to join', async () => {
    KEY = await generateGroupKey()
    // A ghost in the split, so "I'm <name>" appears alongside join-as-new.
    const ghost = {
      id: 4,
      type: 'member.ghost_added',
      payload: { enc: await encryptPayload(KEY, { member_id: -5, display_name: 'Sam' }) },
    }
    await serve(KEY, [ghost])
    await mount(
      <ReadOnlyGroup link={link()} user={{ id: 9 }} onExit={() => {}} />
    )
    assert.ok(byText('button', 'Join as a new member'))
    assert.ok(byText('button', 'Sam'), 'and claiming the ghost')
  })

  test('a visitor with no account is pointed at signing in', async () => {
    KEY = await generateGroupKey()
    await serve(KEY)
    await mount(<ReadOnlyGroup link={link()} user={null} onExit={() => {}} />)
    assert.ok(text().includes('Sign in to join'))
    assert.equal(byText('button', 'Join as a new member'), undefined)
  })

  test('a link with no join code is view-only, even signed in', async () => {
    KEY = await generateGroupKey()
    await serve(KEY)
    await mount(
      <ReadOnlyGroup link={link({ code: null })} user={{ id: 9 }} onExit={() => {}} />
    )
    assert.equal(byText('button', 'Join as a new member'), undefined)
    assert.ok(text().includes('read-only'))
  })

  test('lets a viewer click into an expense for the full detail', async () => {
    KEY = await generateGroupKey()
    await serve(KEY)
    await mount(<ReadOnlyGroup link={link()} user={null} onExit={() => {}} />)

    await click(byText('button', 'Dinner at the pier'))
    // The detail: who paid, and who owes what — the point of clicking in.
    assert.ok(byText('h4', 'Paid'))
    assert.ok(byText('h4', 'Owes'))
    assert.ok(text().includes('$10.00'), 'the payer')
    assert.ok(text().includes('$5.00'), 'each share')
  })

  test('the expense detail offers nothing to edit', async () => {
    KEY = await generateGroupKey()
    await serve(KEY)
    await mount(<ReadOnlyGroup link={link()} user={null} onExit={() => {}} />)
    await click(byText('button', 'Dinner at the pier'))

    assert.equal(byText('button', 'Post'), undefined, 'no comment form')
    assert.ok(!text().includes('add a comment'))
    assert.equal(byText('button', 'edit'), undefined)
  })

  test('never asks a viewer for persistent storage', async () => {
    // The reported annoyance: an account-less viewer was prompted to allow
    // storage. Persistence is requested only in the signed-in app now.
    let asked = false
    const had = globalThis.navigator.storage
    Object.defineProperty(globalThis.navigator, 'storage', {
      configurable: true,
      value: { persist: async () => (asked = true) },
    })
    try {
      KEY = await generateGroupKey()
      await serve(KEY)
      await mount(<ReadOnlyGroup link={link()} user={null} onExit={() => {}} />)
      assert.equal(asked, false)
    } finally {
      Object.defineProperty(globalThis.navigator, 'storage', {
        configurable: true,
        value: had,
      })
    }
  })

  test('shows a receipt image, fetched with the read token and link key', async () => {
    KEY = await generateGroupKey()
    await serve(KEY, [], { receipt: true })
    const realCreate = URL.createObjectURL
    const realRevoke = URL.revokeObjectURL
    URL.createObjectURL = () => 'blob:stub'
    URL.revokeObjectURL = () => {}
    try {
      await mount(<ReadOnlyGroup link={link()} user={null} onExit={() => {}} />)
      await click(byText('button', 'Dinner at the pier'))
      assert.ok(byText('h4', 'Receipts'), 'the receipts section is shown')
      assert.ok($('img.receipt-thumb'), 'and the image decrypted and rendered')
    } finally {
      URL.createObjectURL = realCreate
      URL.revokeObjectURL = realRevoke
    }
  })

  test('a dead link says so instead of blanking', async () => {
    KEY = await generateGroupKey()
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ detail: 'invalid' }) })
    await mount(<ReadOnlyGroup link={link()} user={null} onExit={() => {}} />)
    assert.ok(text().includes('not valid'))
  })
})
