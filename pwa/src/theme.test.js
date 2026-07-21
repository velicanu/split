import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { applyTheme, loadTheme, setTheme } from './theme.js'

const attr = () => document.documentElement.getAttribute('data-theme')

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('the theme preference', () => {
  test('defaults to following the system', () => {
    assert.equal(loadTheme(), 'system')
  })

  test('choosing light or dark sets the attribute the CSS reads', () => {
    setTheme('dark')
    assert.equal(attr(), 'dark')
    setTheme('light')
    assert.equal(attr(), 'light')
  })

  test('choosing system hands back to the media query — no attribute', () => {
    setTheme('dark')
    setTheme('system')
    assert.equal(attr(), null, 'prefers-color-scheme governs again')
  })

  test('the choice survives a reload', () => {
    setTheme('dark')
    // A reload re-reads from storage; loadTheme is that read.
    assert.equal(loadTheme(), 'dark')
  })

  test('system is stored as absence, so a later OS change is still followed', () => {
    setTheme('dark')
    setTheme('system')
    assert.equal(localStorage.getItem('split.theme'), null)
    assert.equal(loadTheme(), 'system')
  })

  test('garbage in storage reads as system rather than breaking', () => {
    localStorage.setItem('split.theme', 'chartreuse')
    assert.equal(loadTheme(), 'system')
  })

  test('applyTheme reflects without persisting', () => {
    applyTheme('dark')
    assert.equal(attr(), 'dark')
    assert.equal(localStorage.getItem('split.theme'), null, 'not saved')
  })
})
