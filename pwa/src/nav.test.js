import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { currentView, readView, viewHash } from './nav.js'

describe('reading a view from the fragment', () => {
  test('no fragment is the list', () => {
    assert.deepEqual(readView(''), { view: 'list' })
    assert.deepEqual(readView('#'), { view: 'list' })
  })

  test('settings and a group each name themselves', () => {
    assert.deepEqual(readView('#settings'), { view: 'settings' })
    assert.deepEqual(readView('#group/7'), { view: 'group', id: 7 })
  })

  test('the id comes back a number, since member ids are numbers', () => {
    assert.equal(readView('#group/7').id, 7)
    assert.equal(typeof readView('#group/7').id, 'number')
  })

  test('a negative group id survives — revived groups can have them', () => {
    assert.deepEqual(readView('#group/-42'), { view: 'group', id: -42 })
  })

  test('an invite fragment is not mistaken for a view', () => {
    // It carries `join=`; readView only matches the two shapes it writes, so an
    // invite falls through to the list and the invite handler takes it instead.
    assert.deepEqual(readView('#join=abc&gk=xyz&as=-5'), { view: 'list' })
  })

  test('anything unrecognised is the list, not an error', () => {
    assert.deepEqual(readView('#group/'), { view: 'list' })
    assert.deepEqual(readView('#group/notanumber'), { view: 'list' })
    assert.deepEqual(readView('#whatever'), { view: 'list' })
  })
})

describe('writing a view to a fragment', () => {
  test('round-trips every view', () => {
    for (const v of [
      { view: 'list' },
      { view: 'settings' },
      { view: 'group', id: 7 },
      { view: 'group', id: -42 },
    ]) {
      assert.deepEqual(readView(viewHash(v)), v)
    }
  })

  test('the list has no fragment, so its URL stays clean', () => {
    assert.equal(viewHash({ view: 'list' }), '')
  })
})

describe('the view implied by navigation state', () => {
  test('settings wins, then a group, else the list', () => {
    assert.deepEqual(currentView({ showSettings: true, groupId: 7 }), {
      view: 'settings',
    })
    assert.deepEqual(currentView({ showSettings: false, groupId: 7 }), {
      view: 'group',
      id: 7,
    })
    assert.deepEqual(currentView({ showSettings: false, groupId: null }), {
      view: 'list',
    })
  })

  test('group id zero is still a group, not the list', () => {
    // Defensive: `groupId != null` is the test, not `!groupId`. No real group
    // has id 0 today, but reading it as "no group" would be a lurking bug.
    assert.deepEqual(currentView({ showSettings: false, groupId: 0 }), {
      view: 'group',
      id: 0,
    })
  })
})
