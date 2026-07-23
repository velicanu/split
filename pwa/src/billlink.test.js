import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildBillLink, parseBillLink } from './billlink.js'
import { parseViewLink } from './viewlink.js'
import { parseInvite } from './invite.js'

describe('bill links', () => {
  test('round-trip, key and token through base64', () => {
    const link = buildBillLink('https://split.example', {
      billId: 'aB3-_9xY',
      key: 'a+key/with=base64',
      token: 'tok-secret',
    })
    assert.deepEqual(parseBillLink(link), {
      billId: 'aB3-_9xY',
      key: 'a+key/with=base64',
      token: 'tok-secret',
    })
  })

  test('accepts a bare fragment as well as a whole URL', () => {
    assert.equal(parseBillLink('#bill=xyz&k=k&t=t').billId, 'xyz')
  })

  test('rejects anything missing the id, key, or token', () => {
    assert.equal(parseBillLink(''), null)
    assert.equal(parseBillLink('#bill=xyz&k=k'), null, 'no token')
    assert.equal(parseBillLink('#k=k&t=t'), null, 'no id')
  })

  test('a bill link is not a view link or an invite', () => {
    // The three fragment shapes must not be confused for one another, or a bill
    // link would auto-join a group or open the read-only view.
    const link = buildBillLink('https://x', { billId: 'b', key: 'k', token: 't' })
    assert.equal(parseViewLink(link), null)
    assert.equal(parseInvite(link), null)
  })
})
