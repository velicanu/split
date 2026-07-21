import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildViewLink, parseViewLink } from './viewlink.js'
import { parseInvite } from './invite.js'

describe('view links', () => {
  test('round-trip, with and without a join code', () => {
    const withCode = buildViewLink('https://split.example', {
      groupId: 7,
      gk: 'a+key/with=base64',
      readToken: 'rt-secret',
      code: 'joincode',
    })
    assert.deepEqual(parseViewLink(withCode), {
      groupId: 7,
      gk: 'a+key/with=base64',
      readToken: 'rt-secret',
      code: 'joincode',
    })

    const readonly = buildViewLink('https://split.example', {
      groupId: 7,
      gk: 'k',
      readToken: 'rt',
    })
    assert.equal(parseViewLink(readonly).code, null)
  })

  test('accepts a bare fragment as well as a whole URL', () => {
    assert.equal(parseViewLink('#view=3&gk=k&rt=t').groupId, 3)
  })

  test('is not an invite, so it never auto-joins', () => {
    // The join code rides as `jc`, not `join`, precisely so the invite parser
    // does not see a view link as something to accept.
    const link = buildViewLink('https://x', { groupId: 1, gk: 'k', rt: 'rt', code: 'c' })
    assert.equal(parseInvite(link), null)
  })

  test('rejects anything missing the group, key, or token', () => {
    assert.equal(parseViewLink(''), null)
    assert.equal(parseViewLink('#view=3&gk=k'), null, 'no token')
    assert.equal(parseViewLink('#gk=k&rt=t'), null, 'no group')
    assert.equal(parseViewLink('#view=0&gk=k&rt=t'), null, 'group 0 is not real')
    assert.equal(parseViewLink('#join=c&gk=k'), null, 'an invite is not a view link')
  })
})
