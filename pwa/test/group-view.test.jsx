// Drives GroupView against a small stateful fake of our own API, so the
// create-an-expense round trip (post event -> pull -> refold -> re-render) is
// exercised for real. That round trip is where the form's lifecycle bugs live.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { GroupView } from '../src/App.jsx'
import {
  contentId,
  decryptBytes,
  decryptPayload,
  encryptBytes,
  encryptPayload,
  generateAccountKey,
  generateDeviceKey,
  generateGroupKey,
  saveDeviceKey,
  sealTo,
} from '../src/crypto.js'
import { forgetGroupKeys } from '../src/groupkeys.js'
import { forgetReceipts } from '../src/receipts.js'
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
  forgetReceipts()
  const device = await generateDeviceKey()
  await saveDeviceKey(device)
  const account = await generateAccountKey()
  const key = await generateGroupKey()
  const sealedKey = await sealTo(device.box_pubkey, key)

  // Seeded expenses may reference receipts; those blobs have to exist, sealed
  // under this group's key, or a re-scan has nothing to read.
  const blobs = new Map()
  const encSeed = []
  for (const e of seed) {
    const payload = { ...e.payload }
    if (payload.receipts) {
      const ids = []
      for (const _ of payload.receipts) {
        const bytes = await encryptBytes(key, new Uint8Array([9, 8, 7]))
        const id = await contentId(bytes)
        blobs.set(id, bytes)
        ids.push(id)
      }
      payload.receipts = ids
    }
    encSeed.push({ ...e, payload: { enc: await encryptPayload(key, payload) } })
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
    // Revive: groups created, events written into them, groups hidden.
    created: [],
    revived: [],
    hidden: [],
    // receipt id -> ciphertext bytes, as the server would hold them
    blobs,
    uploads: 0,
  }
  const json = (body) => ({ ok: true, json: async () => body })
  const fail = (status, detail) => ({
    ok: false,
    status,
    json: async () => ({ detail }),
  })

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
      // A revive writes into a brand-new group whose key this fake never sees
      // — it is minted on the client and sealed to the device. So those are
      // counted, not opened. What they *contain* is asserted in revive.test.js,
      // where the plan can be folded directly.
      if (!path.includes('/groups/7/')) {
        state.revived.push(body)
        return json({ id: state.revived.length })
      }
      state.raw.push(body)
      // Record the decrypted payload so assertions can read it, but store the
      // ciphertext, so the round trip through the fold is the real one.
      const plain = await decryptPayload(state.key, body.payload.enc)
      state.posted.push({ ...body, payload: plain })
      const id = (state.events.at(-1)?.id ?? 0) + 1
      state.events.push({ id, type: body.type, payload: body.payload, author: 1 })
      return json({ id })
    }
    // Reviving mints a key for the new group and seals it to this device and
    // account, so the fake has to answer both of those.
    if (path.endsWith('/api/me')) {
      return json({ id: 1, display_name: 'v', device_id: 'd1' })
    }
    if (path.endsWith('/account/box')) {
      return json({ account_box_pubkey: account.box_pubkey })
    }
    if (path.endsWith('/hide')) {
      state.hidden.push(Number(path.match(/groups\/(\d+)/)[1]))
      return json({ ok: true, hidden: true })
    }
    if (path.endsWith('/api/groups') && body) {
      state.created.push(body)
      return json({ id: 8, name: body.name, code: 'new' })
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
      // Verify the content hash exactly as the server does, so a client that
      // mislabels a blob fails here rather than silently.
      const bytes = Uint8Array.from(atob(body.ciphertext), (c) => c.charCodeAt(0))
      const id = await contentId(bytes)
      if (id !== body.receipt_id) return fail(400, 'id is not the hash')
      state.blobs.set(body.receipt_id, bytes)
      return json({ receipt_id: body.receipt_id })
    }
    if (path.includes('/receipts/')) {
      const id = path.split('/receipts/')[1]
      const bytes = state.blobs.get(id)
      if (!bytes) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(0) }
    }
    if (path.match(/\/api\/groups\/\d+$/)) {
      return json({ id: 7, name: 'Trip', code: 'abc' })
    }
    // The model.
    return json({ choices: [{ message: { content: JSON.stringify(MODEL_REPLY) } }] })
  }
  return state
}

const opened = []
const open = (ai = AI) =>
  mount(
    <GroupView
      groupId={7}
      me={{ id: 1, display_name: 'v' }}
      ai={ai}
      onBack={() => {}}
      onOpen={(id) => opened.push(id)}
    />
  )

const addForm = () => byText('h3', 'Add an expense')?.closest('form')
const descriptionField = () => addForm().querySelector('input')
const amountField = () => addForm().querySelectorAll('input')[1]
const thumbs = () => $$('.receipt-thumb')
const attachControl = () =>
  byText('label', 'add a receipt')?.querySelector('input')

afterEach(() => {
  opened.length = 0
  return unmount()
})

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
    assert.deepEqual(created.payload.receipts, [...api.blobs.keys()])
    assert.match(created.payload.receipts[0], /^[0-9a-f]{64}$/)
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
    assert.deepEqual(first.payload.receipts, [...api.blobs.keys()])
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
    assert.deepEqual(
      deleted.receipts,
      [...api.blobs.keys()],
      'delete must keep receipts'
    )

    await click(byText('button', 'restore'))
    const restored = api.posted.at(-1).payload
    assert.equal(restored.deleted, false)
    assert.deepEqual(restored.receipts, [...api.blobs.keys()])
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

describe('recovering an account, from the group side', () => {
  const spent = [
    {
      id: 3,
      type: 'expense.created',
      author: 1,
      payload: {
        expense_id: 'e1',
        description: 'Dinner',
        amount_cents: 1000,
        payers: [{ user_id: 1, paid_cents: 1000 }],
        splits: [
          { user_id: 1, share_cents: 500 },
          { user_id: 2, share_cents: 500 },
        ],
        date: '2026-01-01',
      },
    },
  ]

  // Read the balances panel structurally: matching on display names in the
  // whole page would trip over 'd' being a prefix of 'd-again'.
  const balances = () =>
    Object.fromEntries(
      [...(byText('h3', 'Balances')?.nextElementSibling?.children ?? [])].map(
        (li) => [li.children[0].textContent, li.children[1].textContent]
      )
    )

  test('offers no way to turn one member into another', async () => {
    // The control this replaces let any member reassign anyone's history at
    // any time. Claiming now happens only on a join, so the group side has
    // nothing to offer — and nothing to get wrong. See plan/12.
    await fakeApi({ seed: spent })
    await open()
    assert.equal(byText('button', 'someone lost their account?'), undefined)
    assert.equal(byText('h4', 'Same person, new account'), undefined)
  })

  test('a join that claims a member takes over their balance', async () => {
    const api = await fakeApi({ seed: spent })
    // Member 2 lost their account and has come back as member 3, by accepting
    // an invite naming member 2. The server writes the claim into member.added
    // itself, in the clear, which is what lets it enforce claiming-once.
    api.events.push({
      id: 5,
      type: 'member.added',
      payload: { user_id: 3, display_name: 'd-again', claims: 2 },
    })
    await open()

    assert.deepEqual(balances(), {
      v: 'is owed $5.00',
      'd-again': 'owes $5.00',
    })
  })
})

describe('the ledger log', () => {
  const seed = [
    {
      id: 3,
      type: 'expense.created',
      author: 1,
      payload: {
        expense_id: 'e1',
        description: 'Dinner at the Anchor',
        amount_cents: 4350,
        payers: [{ user_id: 1, paid_cents: 4350 }],
        splits: [
          { user_id: 1, share_cents: 2175 },
          { user_id: 2, share_cents: 2175 },
        ],
        date: '2026-01-01',
      },
    },
  ]

  const openLog = async () => {
    const api = await fakeApi({ seed })
    await open()
    await click(byText('button', 'log'))
    return api
  }

  test('opens from the group and lists every entry in order', async () => {
    await openLog()
    const entries = $$('.log-entry').map((li) => li.textContent)
    assert.equal(entries.length, 3, 'two joins and the expense')
    assert.ok(entries[0].includes('member.added'))
    assert.ok(entries[2].includes('expense.created'))
    // Ordered by the server's sequence, which is what the fold depends on.
    assert.deepEqual(
      entries.map((t) => t.match(/#(\d+)/)[1]),
      ['1', '2', '3']
    )
  })

  test('hides payloads until asked, then shows them verbatim', async () => {
    await openLog()
    // Scoped to the payload blocks: the description also appears in the
    // ledger row behind the modal, which says nothing about this feature.
    assert.equal($$('.log-payload').length, 0)

    await click(byText('button', 'raw'))
    const payloads = $$('.log-payload').map((p) => p.textContent).join('')
    assert.equal($$('.log-payload').length, 3)
    // Verbatim: raw cents, not the formatted "$43.50" the UI shows.
    assert.ok(payloads.includes('"amount_cents": 4350'))
    assert.ok(payloads.includes('Dinner at the Anchor'))
  })

  test('downloads the decrypted log, not the ciphertext', async () => {
    // The file has to be re-foldable by anyone, so it must contain the events
    // themselves rather than the sealed blobs the server holds.
    await openLog()

    let saved = null
    const realCreate = URL.createObjectURL
    URL.createObjectURL = (blob) => {
      saved = blob
      return 'blob:stub'
    }
    URL.revokeObjectURL = () => {}
    try {
      await click(byText('button', 'Download JSON'))
    } finally {
      URL.createObjectURL = realCreate
    }

    assert.ok(saved, 'a file was produced')
    const doc = JSON.parse(await saved.text())
    assert.equal(doc.format, 'split.ledger.v1')
    assert.equal(doc.event_count, 3)
    assert.equal(doc.events[2].payload.description, 'Dinner at the Anchor')
    assert.ok(!JSON.stringify(doc).includes('enc'), 'no sealed blobs in the file')
  })
})

describe('someone not using the app', () => {
  test('can be added, and is split with like anyone else', async () => {
    const api = await fakeApi()
    await open()

    const form = byText('h4', 'Someone not using the app')?.closest('form')
    await change(form.querySelector('input'), 'Fran')
    await submit(form)

    const added = api.posted.find((e) => e.type === 'member.ghost_added')
    assert.ok(added, 'a ghost was added')
    assert.equal(added.payload.display_name, 'Fran')
    // Negative so it can never collide with a server-issued user id, and a
    // number so the split maths still works.
    assert.ok(added.payload.member_id < 0)
    assert.equal(typeof added.payload.member_id, 'number')

    // They show up as someone to split with.
    assert.ok(text().includes('Fran'))
  })

  test('is sealed like every other event', async () => {
    const api = await fakeApi()
    await open()
    const form = byText('h4', 'Someone not using the app')?.closest('form')
    await change(form.querySelector('input'), 'Fran')
    await submit(form)

    const raw = api.raw.find((e) => e.type === 'member.ghost_added')
    assert.ok(raw.payload.enc, 'who is in a group is not the server’s business')
    assert.ok(!JSON.stringify(raw).includes('Fran'))
  })

  test('two ghosts get different ids', async () => {
    const api = await fakeApi()
    await open()
    for (const name of ['Fran', 'Sam']) {
      const form = byText('h4', 'Someone not using the app')?.closest('form')
      await change(form.querySelector('input'), name)
      await submit(form)
    }
    const ids = api.posted
      .filter((e) => e.type === 'member.ghost_added')
      .map((e) => e.payload.member_id)
    assert.equal(ids.length, 2)
    assert.notEqual(ids[0], ids[1])
  })

  test('a nameless ghost is refused before it is sent', async () => {
    const api = await fakeApi()
    await open()
    const form = byText('h4', 'Someone not using the app')?.closest('form')
    await submit(form)
    assert.ok(text().includes('Give them a name'))
    assert.equal(api.posted.filter((e) => e.type === 'member.ghost_added').length, 0)
  })
})

describe('inviting someone', () => {
  const inviteForm = () => byText('h4', 'Invite someone')?.closest('form')

  test('creates a ghost and a link that names them', async () => {
    const api = await fakeApi()
    await open()

    await change(inviteForm().querySelector('input'), 'Fran')
    await submit(inviteForm())

    // The ghost exists immediately, so the group can split with Fran whether
    // or not she ever accepts.
    const ghost = api.posted.find((e) => e.type === 'member.ghost_added')
    assert.ok(ghost)
    assert.equal(ghost.payload.display_name, 'Fran')

    const link = $('.invite').value
    assert.ok(link.includes('#join='), 'carries the group')
    assert.ok(link.includes('gk='), 'carries the key')
    assert.ok(
      link.includes(`as=${encodeURIComponent(ghost.payload.member_id)}`),
      'and says who to become'
    )
    assert.ok(text().includes('makes whoever opens it'))
  })

  test('an existing ghost can be invited without making another', async () => {
    const api = await fakeApi()
    await open()
    // One ghost, added without an invite.
    const addForm = byText('h4', 'Someone not using the app')?.closest('form')
    await change(addForm.querySelector('input'), 'Sam')
    await submit(addForm)
    const before = api.posted.filter((e) => e.type === 'member.ghost_added').length

    await click(byText('button', 'Sam'))

    const after = api.posted.filter((e) => e.type === 'member.ghost_added').length
    assert.equal(after, before, 'no duplicate ghost was created')
    const ghostId = api.posted.find((e) => e.type === 'member.ghost_added')
      .payload.member_id
    assert.ok($('.invite').value.includes(`as=${encodeURIComponent(ghostId)}`))
  })

  test('refuses a nameless invite before creating anything', async () => {
    const api = await fakeApi()
    await open()
    await submit(inviteForm())
    assert.ok(text().includes('Give them a name'))
    assert.equal(api.posted.filter((e) => e.type === 'member.ghost_added').length, 0)
    assert.equal($('.invite'), null)
  })
})

describe('when you are no longer part of the group', () => {
  const ghostMe = (id = 3) => ({
    id,
    type: 'member.left',
    author: 2,
    payload: { member_id: 1 },
  })

  const spent = {
    id: 4,
    type: 'expense.created',
    author: 2,
    payload: {
      expense_id: 'e1',
      description: 'Dinner',
      amount_cents: 1000,
      payers: [{ user_id: 2, paid_cents: 1000 }],
      splits: [
        { user_id: 1, share_cents: 500 },
        { user_id: 2, share_cents: 500 },
      ],
      date: '2026-01-01',
    },
  }

  test('says so rather than treating you as someone else', async () => {
    // Member 1 — me — has been ghosted. Falling back to the first member, as
    // this once did, meant silently becoming them, and the next expense added
    // would have been attributed to them.
    await fakeApi({ seed: [ghostMe()] })
    await open()

    assert.ok(text().includes('no longer part of this group'))
    // And crucially, no way to write anything as somebody else.
    assert.equal(byText('h3', 'Add an expense'), undefined)
    assert.equal($('.scan'), null)
  })

  test('says so when someone else joined as me, too', async () => {
    // The other route to having no member id: a join that claimed me.
    const api = await fakeApi()
    api.events.push({
      id: 3,
      type: 'member.added',
      payload: { user_id: 3, display_name: 'not me', claims: 1 },
    })
    await open()
    assert.ok(text().includes('no longer part of this group'))
  })

  test('still shows the ledger as it stood', async () => {
    await fakeApi({ seed: [spent, ghostMe(5)] })
    await open()
    // What you had is still yours to read.
    assert.ok(text().includes('Ledger'))
    assert.ok(text().includes('expense.created'))
  })

  test('offers to revive, and says what stays behind', async () => {
    await fakeApi({ seed: [spent, ghostMe(5)] })
    await open()
    assert.ok(byText('button', 'Revive as my own group'))
    // Receipts and comments do not come across, and a screen that stayed quiet
    // about that would be losing things on the user's behalf. See plan/12.
    assert.ok(text().includes('stay behind'))
  })

  test('reviving clones the ledger into a group of my own', async () => {
    const api = await fakeApi({ seed: [spent, ghostMe(5)] })
    await open()
    await click(byText('button', 'Revive as my own group'))

    assert.equal(api.created.length, 1, 'a new group was made')
    const types = api.revived.map((e) => e.type)
    assert.equal(types[0], 'group.revived_from', 'it says where it came from')
    // Member 2 becomes a ghost; the expense comes across; I am not ghosted in
    // my own group, so there is exactly one ghost.
    assert.equal(types.filter((t) => t === 'member.ghost_added').length, 1)
    assert.equal(types.filter((t) => t === 'expense.created').length, 1)
    assert.equal(types.filter((t) => t === 'member.left').length, 0,
      'nobody is ghosted twice — being a ghost from the start covers it')
    assert.deepEqual(opened, [8], 'and it opens the new group')
  })

  test('everything written into the new group is sealed', async () => {
    const api = await fakeApi({ seed: [spent, ghostMe(5)] })
    await open()
    await click(byText('button', 'Revive as my own group'))

    assert.ok(api.revived.length > 0)
    assert.ok(api.revived.every((e) => e.payload.enc), 'no plaintext escaped')
    assert.ok(!JSON.stringify(api.revived).includes('Dinner'))
  })

  test('hides the old group only after the clone is written', async () => {
    const api = await fakeApi({ seed: [spent, ghostMe(5)] })
    await open()
    await click(byText('button', 'Revive as my own group'))
    assert.deepEqual(api.hidden, [7])
  })

  test('does not hide the old group if the clone fails', async () => {
    // Losing sight of the original with nothing to show for it would be the
    // one genuinely destructive way this can go wrong.
    const api = await fakeApi({ seed: [spent, ghostMe(5)] })
    await open()
    const realFetch = globalThis.fetch
    globalThis.fetch = async (url, options) =>
      String(url).includes('/groups/8/events')
        ? { ok: false, status: 500, json: async () => ({ detail: 'nope' }) }
        : realFetch(url, options)
    try {
      await click(byText('button', 'Revive as my own group'))
    } finally {
      globalThis.fetch = realFetch
    }

    assert.deepEqual(api.hidden, [], 'the original is still there')
    assert.deepEqual(opened, [], 'and we did not navigate away from it')
  })
})
