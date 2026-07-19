import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildInviteLink, parseInvite } from './invite.js'

describe('invite links', () => {
  // Base64 keys contain +, / and =, all of which need escaping in a URL.
  const key = 'ab+c/d=='

  test('round trips a key with awkward characters', () => {
    const link = buildInviteLink('https://split.example', 'code123', key)
    assert.deepEqual(parseInvite(link), { code: 'code123', gk: key })
  })

  test('keeps the key in the fragment, never the query', () => {
    const link = buildInviteLink('https://split.example', 'c', key)
    const [before, after] = link.split('#')
    assert.ok(!before.includes('gk='), 'a query string would reach the server')
    assert.ok(after.includes('gk='))
  })

  test('accepts a bare fragment as well as a whole URL', () => {
    assert.deepEqual(parseInvite('#join=c&gk=k'), { code: 'c', gk: 'k' })
    assert.deepEqual(parseInvite('join=c&gk=k'), { code: 'c', gk: 'k' })
  })

  test('rejects anything that is not a complete invite', () => {
    assert.equal(parseInvite('#join=c'), null, 'a code alone is not enough now')
    assert.equal(parseInvite('#gk=k'), null)
    assert.equal(parseInvite('#'), null)
    assert.equal(parseInvite(''), null)
    assert.equal(parseInvite(null), null)
    assert.equal(parseInvite('https://split.example/'), null)
  })
})
