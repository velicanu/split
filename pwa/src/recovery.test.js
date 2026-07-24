import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { decodeRecoveryCode, generateRecoveryCode } from './recovery.js'

describe('recovery codes', () => {
  test('round-trip the entropy through the printed code', () => {
    const { code, entropy } = generateRecoveryCode()
    assert.deepEqual([...decodeRecoveryCode(code)], [...entropy])
  })

  test('are 128 bits of entropy, grouped and readable', () => {
    const { code, entropy } = generateRecoveryCode()
    assert.equal(entropy.length, 16)
    assert.match(code, /^[0-9A-Z-]+$/)
    assert.ok(code.includes('-'), 'grouped for transcription')
  })

  test('two codes differ', () => {
    assert.notEqual(generateRecoveryCode().code, generateRecoveryCode().code)
  })

  test('tolerate case, spacing, and the Crockford look-alikes', () => {
    const { code, entropy } = generateRecoveryCode()
    // Lower-cased, dashes swapped for spaces — still the same entropy.
    const messy = code.toLowerCase().replace(/-/g, ' ')
    assert.deepEqual([...decodeRecoveryCode(messy)], [...entropy])
  })

  test('a single-character typo is caught by the checksum', () => {
    const { code } = generateRecoveryCode()
    // Flip the first data symbol to a different one.
    const swapped = (code[0] === '0' ? '1' : '0') + code.slice(1)
    assert.throws(() => decodeRecoveryCode(swapped), /typo|wrong length/i)
  })

  test('the wrong length is rejected', () => {
    assert.throws(() => decodeRecoveryCode('ABCDE'), /wrong length/i)
  })
})
