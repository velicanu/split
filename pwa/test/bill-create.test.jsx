// Publishing a bill from the signed-in app: fill in items, people, and who
// paid, then get a link — and the server sees only ciphertext. See BillCreate.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { BillCreate } from '../src/components/BillCreate.jsx'
import { $, byText, change, click, mount, submit, text, unmount } from './react.mjs'

function serve() {
  const store = { created: null }
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    const method = options.method || (options.body ? 'POST' : 'GET')
    if (path.endsWith('/api/bills') && method === 'POST') {
      store.created = JSON.parse(options.body)
      return { ok: true, json: async () => ({ id: 'newbill', token: 'tok9' }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return store
}

const nameInput = () => $('input[placeholder="name"]')

afterEach(unmount)

describe('publishing a bill', () => {
  test('fills a receipt, seeds a payer, and hands back a link', async () => {
    const store = serve()
    await mount(<BillCreate ai={null} onBack={() => {}} />)

    await click(byText('button', '+ add item'))
    await change($('input[placeholder="item"]'), 'Pizza')
    await change($('.item .pay-amt'), '10.00')

    await click(byText('button', '+ add person'))
    await change(nameInput(), 'Alex')

    // Naming a person makes them selectable under "paid by".
    await change($('input[type=checkbox]'), '')

    await submit($('form'))

    assert.ok(text().includes('Your bill is ready'))
    assert.ok($('.invite').value.includes('bill=newbill'), 'the link names the bill')

    // What the server received is opaque: no item name, no diner name.
    const raw = JSON.stringify(store.created)
    assert.ok(!raw.includes('Pizza'), 'the items are sealed')
    assert.ok(!raw.includes('Alex'), 'the seeded names are sealed')
  })

  test('will not publish with no items', async () => {
    serve()
    await mount(<BillCreate ai={null} onBack={() => {}} />)
    await click(byText('button', '+ add person'))
    await change(nameInput(), 'Alex')
    await submit($('form'))
    assert.ok(text().includes('at least one item'))
  })

  test('will not publish without a payer', async () => {
    serve()
    await mount(<BillCreate ai={null} onBack={() => {}} />)
    await click(byText('button', '+ add item'))
    await change($('input[placeholder="item"]'), 'Pizza')
    await change($('.item .pay-amt'), '10.00')
    await click(byText('button', '+ add person'))
    await change(nameInput(), 'Alex')
    await submit($('form'))
    assert.ok(text().includes('who paid'))
  })
})
