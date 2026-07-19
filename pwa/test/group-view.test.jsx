// Drives GroupView against a small stateful fake of our own API, so the
// create-an-expense round trip (post event -> pull -> refold -> re-render) is
// exercised for real. That round trip is where the form's lifecycle bugs live.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { GroupView } from '../src/App.jsx'
import {
  decryptPayload,
  encryptPayload,
  generateDeviceKey,
  generateGroupKey,
  saveDeviceKey,
  sealTo,
} from '../src/crypto.js'
import { forgetGroupKeys } from '../src/groupkeys.js'
import {
  $,
  $$,
  byText,
  change,
  click,
  mount,
  submit,
  text,
  unmount,
  upload,
} from './react.mjs'

const AI = {
  active: 'openai',
  providers: { openai: { api_key: 'sk-test', model: 'gpt-5.4-nano' } },
}
const NO_AI = { active: null, providers: {} }

const MODEL_REPLY = {
  items: [
    { name: 'Burger', price_cents: 1000 },
    { name: 'Wine', price_cents: 2000 },
  ],
  subtotal_cents: 3000,
  tax_cents: 250,
  tip_cents: 600,
  total_cents: 3850,
}

// Enough of the server to answer what GroupView asks for, and to remember
// what it was told.
// Everything a client writes is encrypted, so the fake has to hold the group
// key too — and the seeded ledger has to be sealed exactly as a real client
// would seal it. That means these tests exercise the real crypto boundary
// rather than stepping around it.
async function fakeApi({ seed = [] } = {}) {
  forgetGroupKeys()
  const device = await generateDeviceKey()
  await saveDeviceKey(device)
  const key = await generateGroupKey()
  const sealedKey = await sealTo(device.box_pubkey, key)

  const encSeed = []
  for (const e of seed) {
    encSeed.push({ ...e, payload: { enc: await encryptPayload(key, e.payload) } })
  }

  const state = {
    key,
    events: [
      { id: 1, type: 'member.added', payload: { user_id: 1, display_name: 'v' } },
      { id: 2, type: 'member.added', payload: { user_id: 2, display_name: 'd' } },
      ...encSeed,
    ],
    posted: [],
    // Exactly what went over the wire, before any decryption.
    raw: [],
    uploads: 0,
  }
  const json = (body) => ({ ok: true, json: async () => body })

  globalThis.fetch = async (url, options) => {
    const path = String(url)
    const body = options?.body ? JSON.parse(options.body) : null

    if (path.includes('/events') && !body) {
      const since = Number(path.split('since=')[1] ?? 0)
      const fresh = state.events.filter((e) => e.id > since)
      const version = state.events.at(-1)?.id ?? 0
      return json({ version, events: fresh })
    }
    if (path.includes('/events')) {
      state.raw.push(body)
      // Record the decrypted payload so assertions can read it, but store the
      // ciphertext, so the round trip through the fold is the real one.
      const plain = await decryptPayload(state.key, body.payload.enc)
      state.posted.push({ ...body, payload: plain })
      const id = (state.events.at(-1)?.id ?? 0) + 1
      state.events.push({ id, type: body.type, payload: body.payload, author: 1 })
      return json({ id })
    }
    if (path.endsWith('/keys')) {
      if (body) return json({ ok: true })
      return json({
        keys: [
          { recipient_kind: 'device', recipient_id: 'd1', ciphertext: sealedKey },
        ],
      })
    }
    if (path.endsWith('/receipts')) {
      state.uploads += 1
      return json({ receipt_id: `r${state.uploads}` })
    }
    if (path.startsWith('/api/receipts/')) {
      return { ok: true, blob: async () => ({ name: 'stored.jpg' }) }
    }
    if (path.match(/\/api\/groups\/\d+$/)) {
      return json({ id: 7, name: 'Trip', code: 'abc' })
    }
    // The model.
    return json({ choices: [{ message: { content: JSON.stringify(MODEL_REPLY) } }] })
  }
  return state
}

const open = (ai = AI) =>
  mount(<GroupView groupId={7} me={{ id: 1, display_name: 'v' }} ai={ai} onBack={() => {}} />)

const addForm = () => byText('h3', 'Add an expense')?.closest('form')
const descriptionField = () => addForm().querySelector('input')
const amountField = () => addForm().querySelectorAll('input')[1]
const thumbs = () => $$('.receipt-thumb')
const attachControl = () =>
  byText('label', 'add a receipt')?.querySelector('input')

afterEach(unmount)

async function fillAndSubmit({ description = 'Lunch', amount = '20.00' } = {}) {
  await change(descriptionField(), description)
  await change(amountField(), amount)
  await submit(addForm())
}

describe('creating an expense with a receipt', () => {
  test('files the receipt id with the expense', async () => {
    const api = await fakeApi()
    await open()
    await upload(attachControl(), { name: 'receipt.jpg' })
    await fillAndSubmit()

    const created = api.posted.find((e) => e.type === 'expense.created')
    assert.deepEqual(created.payload.receipts, ['r1'])
  })

  test('clears the form once the expense is filed', async () => {
    // The bug: creating doesn't change the form's key, so without an explicit
    // reset the draft — receipt thumbnail and all — sat there afterwards.
    const api = await fakeApi()
    await open()
    await upload(attachControl(), { name: 'receipt.jpg' })
    assert.equal(thumbs().length, 1, 'thumbnail should show while drafting')

    await fillAndSubmit()

    assert.equal(api.posted.length, 1, 'sanity: the expense was actually filed')
    assert.equal(thumbs().length, 0, 'receipt should not outlive the draft')
    assert.equal(descriptionField().value, '')
    assert.equal(amountField().value, '')
  })

  test('a second expense does not inherit the first receipt', async () => {
    const api = await fakeApi()
    await open()
    await upload(attachControl(), { name: 'receipt.jpg' })
    await fillAndSubmit({ description: 'First' })
    await fillAndSubmit({ description: 'Second' })

    const [first, second] = api.posted
    assert.deepEqual(first.payload.receipts, ['r1'])
    assert.deepEqual(second.payload.receipts, [])
  })
})

// An expense already in the ledger, with a receipt attached.
const withReceiptSeed = [
    {
      id: 3,
      type: 'expense.created',
      author: 1,
      payload: {
        expense_id: 'e1',
        description: 'Dinner',
        amount_cents: 4350,
        payers: [{ user_id: 1, paid_cents: 4350 }],
        splits: [
          { user_id: 1, share_cents: 2175 },
          { user_id: 2, share_cents: 2175 },
        ],
        date: '2026-01-01',
        receipts: ['stored-1'],
      },
    },
]

describe('the receipt on an existing expense', () => {
  const withReceipt = withReceiptSeed

  const openDetail = async (ai = AI) => {
    await fakeApi({ seed: withReceipt })
    await open(ai)
    await click($('.expense.clickable'))
  }

  test('is shown on the expense, with a scan button', async () => {
    await openDetail()
    assert.ok(text().includes('Receipts'))
    assert.equal(thumbs().length, 1)
    assert.ok(byText('button', 'scan'), 'scan belongs on the expense')
  })

  test('offers no scan button without an API key', async () => {
    await openDetail(NO_AI)
    assert.equal(thumbs().length, 1, 'the receipt still shows')
    assert.equal(byText('button', 'scan'), undefined)
  })

  test('survives a delete and a restore', async () => {
    // A revision replaces the expense wholesale, so a delete that rebuilds the
    // payload by hand silently destroys whatever it forgets to copy.
    const api = await fakeApi({ seed: withReceipt })
    await open()

    await click(byText('button', 'delete'))
    const deleted = api.posted.at(-1).payload
    assert.equal(deleted.deleted, true)
    assert.deepEqual(deleted.receipts, ['stored-1'], 'delete must keep receipts')

    await click(byText('button', 'restore'))
    const restored = api.posted.at(-1).payload
    assert.equal(restored.deleted, false)
    assert.deepEqual(restored.receipts, ['stored-1'])
  })

  test('keeps its split recipe through a delete', async () => {
    // Same trap: the recipe is what makes an itemised expense re-editable.
    const recipe = { mode: 'items', participants: [1, 2], items: [], tax_cents: 250 }
    const api = await fakeApi({
      seed: [
        {
          ...withReceipt[0],
          payload: { ...withReceipt[0].payload, split: recipe },
        },
      ],
    })
    await open()
    await click(byText('button', 'delete'))
    assert.deepEqual(api.posted.at(-1).payload.split, recipe)
  })

  test('scanning it opens the expense for editing with the result applied', async () => {
    await openDetail()
    await click(byText('button', 'scan'))

    // The detail overlay gives way to the edit form, already scanned.
    assert.ok(!text().includes('Comments'), 'detail should have closed')
    assert.ok(byText('h3', 'Edit expense'))
    assert.deepEqual(
      $$('.item-head input:first-child').map((i) => i.value),
      ['Burger', 'Wine']
    )
    assert.equal($('select').value, 'items')
  })
})

describe('the add form', () => {
  test('offers no per-receipt scan button', async () => {
    // Re-reading a receipt needs an expense to attach the result to, so that
    // button lives on the detail view instead.
    await fakeApi()
    await open()
    await upload(attachControl(), { name: 'receipt.jpg' })
    assert.equal(thumbs().length, 1)
    assert.equal(byText('button', 'scan'), undefined)
    assert.ok(byText('button', 'remove'), 'but it can still be taken off')
  })
})

describe('what actually crosses the wire', () => {
  test('an expense leaves this device encrypted', async () => {
    const api = await fakeApi()
    await open()
    await change(descriptionField(), 'Anniversary dinner')
    await change(amountField(), '99.99')
    await submit(addForm())

    const sent = JSON.stringify(api.raw)
    assert.ok(sent.includes('"enc"'), 'the payload must be sealed')
    assert.ok(!sent.includes('Anniversary'), 'no description in the clear')
    assert.ok(!sent.includes('9999'), 'no amount in the clear')
    // The type stays readable — the server routes on it and it leaks little.
    assert.equal(api.raw[0].type, 'expense.created')
  })

  test('comments and settlements are sealed too, not just expenses', async () => {
    const api = await fakeApi({ seed: withReceiptSeed })
    await open()
    await click($('.expense.clickable'))
    await change($('.modal input'), 'we should do this again')
    await submit($('.modal form'))

    const comment = api.raw.find((e) => e.type === 'comment.created')
    assert.ok(comment, 'the comment was posted')
    assert.ok(comment.payload.enc)
    assert.ok(!JSON.stringify(comment).includes('do this again'))
  })

  test('a device with no key sees a locked group rather than an empty one', async () => {
    const api = await fakeApi({ seed: withReceiptSeed })
    // Same ledger, but this browser holds no key that opens it.
    const original = globalThis.fetch
    globalThis.fetch = async (url, options) =>
      String(url).endsWith('/keys') && !options?.body
        ? { ok: true, json: async () => ({ keys: [] }) }
        : original(url, options)

    await open()
    assert.ok(text().includes('no key for this group'))
    // And emphatically not a group that merely looks empty.
    assert.ok(!text().includes('Add an expense'))
    assert.equal(api.posted.length, 0)
  })

  test('an entry that will not decrypt is skipped, not fatal', async () => {
    await fakeApi({ seed: withReceiptSeed })
    const original = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      const res = await original(url, options)
      if (String(url).includes('/events') && !options?.body) {
        const body = await res.json()
        return {
          ok: true,
          json: async () => ({
            ...body,
            events: [
              ...body.events,
              { id: 99, type: 'expense.created', payload: { enc: 'AAAA.BBBB' } },
            ],
          }),
        }
      }
      return res
    }

    await open()
    assert.ok(text().includes('could not be decrypted'))
    // The readable expense still folded.
    assert.ok(text().includes('Dinner'))
  })
})
