// The toggle is a thin wire between the select and theme.js; theme.js itself is
// unit-tested. This just confirms the wire: picking dark drives the document.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { ThemeToggle } from '../src/components/Settings.jsx'
import { $, change, mount, unmount } from './react.mjs'

afterEach(async () => {
  await unmount()
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('the theme toggle', () => {
  test('starts on the saved preference', async () => {
    localStorage.setItem('split.theme', 'dark')
    await mount(<ThemeToggle />)
    assert.equal($('select').value, 'dark')
  })

  test('picking dark themes the document and remembers it', async () => {
    await mount(<ThemeToggle />)
    await change($('select'), 'dark')
    assert.equal(document.documentElement.getAttribute('data-theme'), 'dark')
    assert.equal(localStorage.getItem('split.theme'), 'dark')
  })

  test('back to system clears the attribute', async () => {
    await mount(<ThemeToggle />)
    await change($('select'), 'dark')
    await change($('select'), 'system')
    assert.equal(document.documentElement.getAttribute('data-theme'), null)
  })
})
