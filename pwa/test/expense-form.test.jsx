// Drives the real ExpenseForm through the real ai.js extraction path. Only
// the network and the canvas are stubbed, so the prompt/schema/normalize
// chain is exercised end to end rather than mocked away.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'

import { ExpenseForm } from '../src/App.jsx'
import {
  $,
  $$,
  byText,
  change,
  click,
  mount,
  submit,
  text,
  upload,
  values,
} from './react.mjs'

const MEMBERS = [
  { id: 1, username: 'v' },
  { id: 2, username: 'd' },
]
const AI = {
  active: 'openai',
  providers: { openai: { api_key: 'sk-test', model: 'gpt-5.4-nano' } },
}

// Two items totalling $30, plus $2.50 tax and $6 tip.
const reply = ({ subtotal, total }) => ({
  ok: true,
  json: async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            items: [
              { name: 'Burger', price_cents: 1000 },
              { name: 'Wine', price_cents: 2000 },
            ],
            subtotal_cents: subtotal,
            tax_cents: 250,
            tip_cents: 600,
            total_cents: total,
          }),
        },
      },
    ],
  }),
})

// Routes the two calls the form makes: uploading a receipt to our own server
// and asking the model to read one. Records what was uploaded so tests can
// assert an image was kept even when no scan ran.
let uploaded
function serve({ subtotal = 3000, total = 3850, uploadFails = false } = {}) {
  uploaded = []
  globalThis.fetch = async (url, options) => {
    const path = String(url)
    if (path.endsWith('/receipts')) {
      if (uploadFails) {
        return { ok: false, status: 500, json: async () => ({ detail: 'disk full' }) }
      }
      uploaded.push(JSON.parse(options.body).data_url)
      return { ok: true, json: async () => ({ receipt_id: `r${uploaded.length}` }) }
    }
    // Fetching a stored receipt back, for a re-scan.
    if (path.startsWith('/api/receipts/')) {
      return { ok: true, blob: async () => ({ name: 'stored.jpg' }) }
    }
    return reply({ subtotal, total })
  }
}

let saved
async function render(ai = AI) {
  saved = []
  await mount(
    <ExpenseForm
      groupId={7}
      members={MEMBERS}
      me="v"
      ai={ai}
      onSubmit={(e) => saved.push(e)}
      onCancel={() => {}}
    />
  )
}

// Two file inputs now: one keeps the receipt, one keeps it *and* scans. The
// stand-in File is never read — createImageBitmap is stubbed.
const control = (label) => byText('label', label)?.querySelector('input')
const attachControl = () => control('add a receipt')
const scanControl = () => control('add and scan')
const pickReceipt = () => upload(scanControl(), { name: 'receipt.jpg' })
const pickAttachment = () => upload(attachControl(), { name: 'receipt.jpg' })
const thumbs = () => $$('.receipt-thumb')

const amountField = () => $$('input')[1]
const itemNames = () => values('.item-head input:first-child')
const itemPrices = () => $$('.item-head .pay-amt')
const field = (label) => byText('label', label)?.querySelector('input')

describe('scanning a receipt that reconciles', () => {
  beforeEach(async () => {
    serve()
    await render()
    await pickReceipt()
  })

  test('applies straight to the form with no confirmation', () => {
    assert.ok(!text().includes('check this scan'))
    assert.equal($('select').value, 'items')
    assert.deepEqual(itemNames(), ['Burger', 'Wine'])
    assert.equal(amountField().value, '38.50')
  })

  test('captures tax and tip', () => {
    assert.equal(field('tax (optional)').value, '2.50')
    assert.equal(field('tip (optional)').value, '6.00')
    assert.ok(text().includes('items $30.00 · tax $2.50 · tip $6.00 · total $38.50'))
  })

  test('saves nothing on its own', () => {
    assert.equal(saved.length, 0)
  })
})

describe('scanning a receipt whose items miss the subtotal', () => {
  beforeEach(async () => {
    // Items sum to $30 but the receipt says $35 — a line was misread.
    serve({ subtotal: 3500, total: 4350 })
    await render()
    await pickReceipt()
  })

  test('asks for confirmation instead of filling the form', () => {
    assert.ok(text().includes('check this scan'))
    assert.equal($('select').value, 'equal')
    assert.equal(amountField().value, '')
    assert.equal(saved.length, 0)
  })

  test('shows both figures, the gap, and the items to check', () => {
    assert.ok(text().includes('add up to $30.00'))
    assert.ok(text().includes('subtotal reads $35.00'))
    assert.ok(text().includes('$5.00 short'))
    assert.deepEqual(itemNames(), ['Burger', 'Wine'])
  })

  test('correcting a misread price clears the warning as you type', async () => {
    // The Wine line was read as $20; the receipt actually says $25.
    await change(itemPrices()[1], '25.00')
    assert.ok(!text().includes('short'), 'warning should be gone')
    assert.ok(text().includes('matching the subtotal'))
    assert.ok(byText('button', 'use these items'))
  })

  test('correcting the subtotal instead also reconciles', async () => {
    // Maybe it was the subtotal that was misread, not a line.
    await change(field('subtotal printed on the receipt'), '30.00')
    assert.ok(text().includes('matching the subtotal'))
  })

  test('a missing line can be added', async () => {
    await click(byText('button', '+ add item'))
    const names = () => $$('.item-head input:first-child')
    await change(names()[2], 'Dessert')
    await change(itemPrices()[2], '5.00')
    assert.ok(text().includes('matching the subtotal'))
  })

  test('a line the model invented can be removed', async () => {
    // Drop Wine, then the remaining $10 needs a $10 subtotal to reconcile.
    await click($$('.item-head .link.danger')[1])
    assert.deepEqual(itemNames(), ['Burger'])
    assert.ok(text().includes('add up to $10.00'))
    await change(field('subtotal printed on the receipt'), '10.00')
    assert.ok(text().includes('matching the subtotal'))
  })

  test('edits stay in the panel until the scan is used', async () => {
    await change(itemPrices()[1], '25.00')
    assert.equal($('select').value, 'equal', 'form untouched while pending')
    assert.equal(amountField().value, '')
    assert.equal(saved.length, 0)
  })

  test('the corrected items are what land in the form', async () => {
    await change(itemPrices()[1], '25.00')
    await click(byText('button', 'use these items'))
    assert.ok(!text().includes('check this scan'))
    assert.equal($('select').value, 'items')
    assert.deepEqual(itemPrices().map((i) => i.value), ['10.00', '25.00'])
    // The total is what was charged, not the corrected subtotal.
    assert.equal(amountField().value, '43.50')
  })

  test('"use them anyway" applies the scan unreconciled', async () => {
    await click(byText('button', 'use them anyway'))
    assert.ok(!text().includes('check this scan'))
    assert.equal($('select').value, 'items')
    assert.equal(amountField().value, '43.50')
    assert.deepEqual(itemNames(), ['Burger', 'Wine'])
  })

  test('"discard scan" throws it away and leaves the form untouched', async () => {
    await click(byText('button', 'discard scan'))
    assert.ok(!text().includes('check this scan'))
    assert.equal($('select').value, 'equal')
    assert.equal(amountField().value, '')
    assert.equal($$('.item-head').length, 0)
  })
})

describe('saving a scanned receipt', () => {
  beforeEach(async () => {
    serve()
    await render()
    await pickReceipt()
    await change($('input'), 'Dinner')
    await submit($('form'))
  })

  test('carries tax and tip on the recipe', () => {
    assert.equal(saved[0].split.tax_cents, 250)
    assert.equal(saved[0].split.tip_cents, 600)
  })

  test('splits still add up to the total, with no split for tax or tip', () => {
    const expense = saved[0]
    const total = expense.splits.reduce((t, s) => t + s.share_cents, 0)
    assert.equal(total, expense.amount_cents)
    assert.equal(expense.splits.length, MEMBERS.length)
  })
})

describe('the receipt controls', () => {
  const NO_AI = { active: null, providers: {} }

  test('both are offered in every split mode when a key exists', async () => {
    serve()
    await render()
    for (const mode of ['equal', 'percentage', 'shares', 'items']) {
      await change($('select'), mode)
      assert.ok(attachControl(), `no attach control in ${mode} mode`)
      assert.ok(scanControl(), `no scan control in ${mode} mode`)
    }
  })

  test('attaching is offered without a key; scanning is not', async () => {
    serve()
    await render(NO_AI)
    assert.ok(attachControl(), 'keeping a receipt must not need an API key')
    assert.equal(scanControl(), undefined)
  })
})

describe('attaching a receipt without scanning', () => {
  beforeEach(async () => {
    serve()
    await render()
    await pickAttachment()
  })

  test('uploads the image and shows it', () => {
    assert.equal(uploaded.length, 1)
    assert.ok(uploaded[0].startsWith('data:image/jpeg;base64,'))
    assert.equal(thumbs().length, 1)
  })

  test('leaves the form alone — no scan ran', () => {
    assert.equal($('select').value, 'equal')
    assert.equal(amountField().value, '')
    assert.equal($$('.item-head').length, 0)
    assert.ok(!text().includes('check this scan'))
  })

  test('saves the receipt id on the expense', async () => {
    await change($('input'), 'Lunch')
    await change(amountField(), '20.00')
    await submit($('form'))
    assert.deepEqual(saved[0].receipts, ['r1'])
  })
})

describe('attaching a receipt without an API key', () => {
  test('works end to end', async () => {
    serve()
    await render({ active: null, providers: {} })
    await pickAttachment()
    assert.equal(thumbs().length, 1)
    await change($('input'), 'Lunch')
    await change(amountField(), '20.00')
    await submit($('form'))
    assert.deepEqual(saved[0].receipts, ['r1'])
  })
})

describe('scanning keeps the receipt too', () => {
  test('a one-shot scan uploads the image as well as reading it', async () => {
    serve()
    await render()
    await pickReceipt()
    assert.equal(uploaded.length, 1, 'the photo should be kept, not just read')
    assert.equal(thumbs().length, 1)
    assert.equal($('select').value, 'items')

    await change($('input'), 'Dinner')
    await submit($('form'))
    assert.deepEqual(saved[0].receipts, ['r1'])
  })

  test('several receipts can be attached to one expense', async () => {
    serve()
    await render()
    await pickAttachment()
    await pickAttachment()
    assert.equal(thumbs().length, 2)
    await change($('input'), 'Dinner')
    await change(amountField(), '20.00')
    await submit($('form'))
    assert.deepEqual(saved[0].receipts, ['r1', 'r2'])
  })

  test('a receipt can be removed again', async () => {
    serve()
    await render()
    await pickAttachment()
    await click(byText('button', 'remove'))
    assert.equal(thumbs().length, 0)
    await change($('input'), 'Dinner')
    await change(amountField(), '20.00')
    await submit($('form'))
    assert.deepEqual(saved[0].receipts, [])
  })
})

describe('re-scanning a stored receipt', () => {
  // Driven by the detail view, which opens the form with a receipt to read.
  test('reads the stored image without uploading it again', async () => {
    serve()
    await mount(
      <ExpenseForm
        groupId={7}
        members={MEMBERS}
        me="v"
        ai={AI}
        scanOnOpen="stored-1"
        onSubmit={(e) => saved.push(e)}
        onCancel={() => {}}
      />
    )
    assert.equal($('select').value, 'items')
    assert.deepEqual(itemNames(), ['Burger', 'Wine'])
    assert.equal(uploaded.length, 0, 'a re-scan must not re-upload the image')
  })

  test('attaching alone never scans', async () => {
    serve()
    await render()
    await pickAttachment()
    assert.equal($('select').value, 'equal')
    assert.equal($$('.item-head').length, 0)
  })
})

describe('an expense that already has receipts', () => {
  test('keeps them when edited', async () => {
    serve()
    await mount(
      <ExpenseForm
        groupId={7}
        members={MEMBERS}
        me="v"
        ai={AI}
        initial={{
          expense_id: 'e1',
          description: 'Dinner',
          amount_cents: 2000,
          payers: [{ user_id: 1, paid_cents: 2000 }],
          splits: [
            { user_id: 1, share_cents: 1000 },
            { user_id: 2, share_cents: 1000 },
          ],
          receipts: ['old-1'],
          date: '2026-01-01',
        }}
        onSubmit={(e) => saved.push(e)}
        onCancel={() => {}}
      />
    )
    assert.equal(thumbs().length, 1)
    await submit($('form'))
    assert.deepEqual(saved[0].receipts, ['old-1'])
  })
})

describe('failures', () => {
  test('a failed scan reports the error and changes nothing', async () => {
    serve()
    const ok = globalThis.fetch
    globalThis.fetch = async (url, options) =>
      String(url).endsWith('/receipts')
        ? ok(url, options)
        : {
            ok: false,
            status: 401,
            json: async () => ({ error: { message: 'bad key' } }),
          }
    await render()
    await pickReceipt()
    assert.ok(text().includes('rejected the API key'))
    assert.equal($('select').value, 'equal')
    assert.equal(amountField().value, '')
    // The upload happened first, so the photo is kept even though the read failed.
    assert.equal(thumbs().length, 1)
  })

  test('a failed upload reports the error and skips the scan', async () => {
    serve({ uploadFails: true })
    await render()
    await pickReceipt()
    assert.equal(thumbs().length, 0)
    assert.equal($('select').value, 'equal', 'no scan should have run')
    assert.ok(text().includes('disk full'))
  })
})
