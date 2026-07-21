// The control that turns read-sharing on and hands out the link. The server
// side is covered in pytest; this checks the wiring: enabling produces a link
// that parses back to this group and token, and turning off clears it.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { ShareReadOnly } from '../src/App.jsx'
import { generateGroupKey } from '../src/crypto.js'
import { forgetGroupKeys } from '../src/groupkeys.js'
import { forgetLocalLedger, saveGroupKey } from '../src/store.js'
import { parseViewLink } from '../src/viewlink.js'
import { $, byText, click, mount, text, unmount } from './react.mjs'

let token
function serve() {
  token = null
  const json = (b) => ({ ok: true, json: async () => b })
  globalThis.fetch = async (url, opts) => {
    const p = String(url)
    const body = opts?.body ? JSON.parse(opts.body) : null
    if (p.endsWith('/read-sharing') && !body) return json({ read_token: token })
    if (p.endsWith('/read-sharing')) {
      token = body.enabled ? 'rt-secret-123' : null
      return json({ read_token: token })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
}

afterEach(async () => {
  await unmount()
  forgetGroupKeys()
  await forgetLocalLedger()
})

describe('the read-only share control', () => {
  test('off by default, then creating a link hands out a working one', async () => {
    serve()
    const key = await generateGroupKey()
    await saveGroupKey(7, key) // so groupKey(7) resolves without a network
    await mount(<ShareReadOnly groupId={7} code="joincode" />)

    assert.ok(byText('button', 'Create read-only link'))

    await click(byText('button', 'Create read-only link'))
    const input = $('.invite')
    assert.ok(input, 'a link input appeared')
    const parsed = parseViewLink(input.value)
    assert.deepEqual(parsed, {
      groupId: 7,
      gk: key,
      readToken: 'rt-secret-123',
      code: 'joincode',
    })
  })

  test('turning it off returns to the create button', async () => {
    serve()
    await saveGroupKey(7, await generateGroupKey())
    await mount(<ShareReadOnly groupId={7} code="joincode" />)
    await click(byText('button', 'Create read-only link'))
    await click(byText('button', 'turn off'))
    assert.ok(byText('button', 'Create read-only link'))
  })
})
