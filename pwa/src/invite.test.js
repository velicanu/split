import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildInviteLink, parseInvite } from './invite.js'

describe('invite links', () => {
  // Base64 keys contain +, / and =, all of which need escaping in a URL.
  const key = 'ab+c/d=='

  test('round trips a key with awkward characters', () => {
    const link = buildInviteLink('https://split.example', 'code123', key)
    assert.deepEqual(parseInvite(link), {
      code: 'code123',
      gk: key,
      member_id: null,
    })
  })

  test('carries the member id the joiner is to become', () => {
    // Negative, because ghosts are. Round-tripping the sign matters: claiming
    // member 100 instead of -100 would take over the wrong person.
    const link = buildInviteLink('https://split.example', 'c', key, -12345)
    assert.deepEqual(parseInvite(link), { code: 'c', gk: key, member_id: -12345 })
  })

  test('a link with no member id claims nobody', () => {
    assert.equal(parseInvite('#join=c&gk=k').member_id, null)
  })

  test('a member id that is not a number is ignored, not guessed at', () => {
    assert.equal(parseInvite('#join=c&gk=k&as=nonsense').member_id, null)
    assert.equal(parseInvite('#join=c&gk=k&as=').member_id, null)
  })

  test('keeps the key in the fragment, never the query', () => {
    const link = buildInviteLink('https://split.example', 'c', key)
    const [before, after] = link.split('#')
    assert.ok(!before.includes('gk='), 'a query string would reach the server')
    assert.ok(after.includes('gk='))
  })

  test('accepts a bare fragment as well as a whole URL', () => {
    const expected = { code: 'c', gk: 'k', member_id: null }
    assert.deepEqual(parseInvite('#join=c&gk=k'), expected)
    assert.deepEqual(parseInvite('join=c&gk=k'), expected)
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
