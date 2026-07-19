import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { describeError } from './api.js'

const res = (status, statusText = '') => ({ status, statusText })

describe('describeError', () => {
  test('passes a plain server message straight through', () => {
    assert.equal(
      describeError(res(409), { detail: 'login handle already taken' }),
      'login handle already taken'
    )
  })

  test('never renders a validation list as [object Object]', () => {
    // The actual shape FastAPI returns, and the actual bug users hit.
    const detail = [
      { type: 'missing', loc: ['body', 'login_handle'], msg: 'Field required' },
      { type: 'missing', loc: ['body', 'display_name'], msg: 'Field required' },
    ]
    const message = describeError(res(422), { detail })
    assert.ok(!message.includes('[object Object]'))
    assert.ok(message.includes('old version'), 'should say what to do')
    assert.ok(message.includes('login_handle'), 'and what was rejected')
  })

  test('reads a 422 as a stale client, because we build every request body', () => {
    const message = describeError(res(422), { detail: [] })
    assert.ok(/reload/i.test(message))
  })

  test('joins non-422 list messages', () => {
    const message = describeError(res(400), {
      detail: [{ msg: 'too short' }, { msg: 'not a number' }],
    })
    assert.equal(message, 'too short; not a number')
  })

  test('falls back to the status when there is no detail', () => {
    assert.equal(describeError(res(500, 'Internal Server Error'), {}), 'Internal Server Error')
    assert.equal(describeError(res(503), {}), 'Request failed (503)')
    assert.equal(describeError(res(500, 'Boom'), null), 'Boom')
  })
})
