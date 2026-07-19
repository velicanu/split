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

let saved
async function render() {
  saved = []
  await mount(
    <ExpenseForm
      members={MEMBERS}
      me="v"
      ai={AI}
      onSubmit={(e) => saved.push(e)}
      onCancel={() => {}}
    />
  )
}

// The scan control is a file input; the stand-in File is never read, since
// createImageBitmap is stubbed and the model reply is mocked.
const pickReceipt = () => upload($('.scan input'), { name: 'receipt.jpg' })

const amountField = () => $$('input')[1]
const itemNames = () => values('.item-head input:first-child')
const field = (label) => byText('label', label)?.querySelector('input')

describe('scanning a receipt that reconciles', () => {
  beforeEach(async () => {
    globalThis.fetch = async () => reply({ subtotal: 3000, total: 3850 })
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
    globalThis.fetch = async () => reply({ subtotal: 3500, total: 4350 })
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
    assert.ok(text().includes("subtotal reads $35.00"))
    assert.ok(text().includes('$5.00 short'))
    assert.ok(text().includes('Burger'))
  })

  test('"use it anyway" applies the scan', async () => {
    await click(byText('button', 'use it anyway'))
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
    globalThis.fetch = async () => reply({ subtotal: 3000, total: 3850 })
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

describe('the scan control', () => {
  test('is offered in every split mode once a key exists', async () => {
    await render()
    for (const mode of ['equal', 'percentage', 'shares', 'items']) {
      await change($('select'), mode)
      assert.ok($('.scan'), `no scan control in ${mode} mode`)
    }
  })

  test('is hidden when no provider is configured', async () => {
    await mount(
      <ExpenseForm
        members={MEMBERS}
        me="v"
        ai={{ active: null, providers: {} }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    )
    assert.equal($('.scan'), null)
  })
})

describe('a failed scan', () => {
  test('reports the error and changes nothing', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'bad key' } }),
    })
    await render()
    await pickReceipt()
    assert.ok(text().includes('rejected the API key'))
    assert.equal($('select').value, 'equal')
    assert.equal(amountField().value, '')
  })
})
