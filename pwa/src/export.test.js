import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { LEDGER_FORMAT, exportLedger, ledgerFilename } from './export.js'

const NOW = new Date('2026-07-19T10:30:00.000Z')
const GROUP = { id: 7, name: 'Trip to Lisbon' }
const EVENTS = [
  { id: 1, type: 'member.added', payload: { user_id: 1, display_name: 'v' } },
  {
    id: 2,
    type: 'expense.created',
    author: 1,
    created_at: '2026-07-18 19:04:11',
    payload: { expense_id: 'e1', description: 'Dinner', amount_cents: 4350 },
  },
]

const parsed = (over = {}) =>
  JSON.parse(
    exportLedger({ group: GROUP, version: 42, events: EVENTS, now: NOW, ...over })
  )

describe('the exported ledger', () => {
  test('carries the events verbatim and in order', () => {
    // The file has to be the log, not a rendering of it — anyone should be
    // able to re-fold it and get the same balances.
    assert.deepEqual(parsed().events, EVENTS)
  })

  test('says what it is, and when', () => {
    const doc = parsed()
    assert.equal(doc.format, LEDGER_FORMAT)
    assert.equal(doc.exported_at, '2026-07-19T10:30:00.000Z')
    assert.deepEqual(doc.group, { id: 7, name: 'Trip to Lisbon' })
    assert.equal(doc.version, 42)
    assert.equal(doc.event_count, 2)
  })

  test('admits when entries are missing', () => {
    // A partial export must not read as a complete one.
    assert.equal(parsed({ unreadable: 3 }).unreadable_count, 3)
    assert.equal(parsed().unreadable_count, 0)
  })

  test('is readable rather than minified', () => {
    // Someone opening this in a text editor is the point.
    assert.ok(exportLedger({ group: GROUP, version: 1, events: EVENTS, now: NOW }).includes('\n  '))
  })

  test('survives an empty group', () => {
    const doc = parsed({ events: [] })
    assert.deepEqual(doc.events, [])
    assert.equal(doc.event_count, 0)
  })

  test('does not fall over without group metadata', () => {
    const doc = JSON.parse(
      exportLedger({ group: null, version: 0, events: [], now: NOW })
    )
    assert.deepEqual(doc.group, { id: null, name: null })
  })
})

describe('the filename', () => {
  test('is dated and derived from the group name', () => {
    assert.equal(ledgerFilename(GROUP, NOW), 'trip-to-lisbon-ledger-2026-07-19.json')
  })

  test('copes with names that are not filename-shaped', () => {
    assert.equal(ledgerFilename({ name: 'Ski / Chalet 2026!' }, NOW),
      'ski-chalet-2026-ledger-2026-07-19.json')
    assert.equal(ledgerFilename({ name: '???' }, NOW), 'split-ledger-2026-07-19.json')
    assert.equal(ledgerFilename(null, NOW), 'split-ledger-2026-07-19.json')
  })
})
