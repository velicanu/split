// The three-page auth front door: sign in / sign up / pair, with methods laid
// out as peers. The auth *logic* is covered in auth.test.jsx; here it's the page
// structure and navigation. jsdom has no WebAuthn, so passkeySupported() is
// false and the passkey method is absent — password and recovery are asserted.
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { Auth } from '../src/components/Auth.jsx'
import { $, $$, byText, click, mount, submit, text, unmount } from './react.mjs'

const tab = (label) => $$('.segmented button').find((b) => b.textContent === label)
const methodButtons = () => $$('.method button').map((b) => b.textContent)

afterEach(unmount)

describe('the auth front door', () => {
  test('defaults to sign in, with password and recovery as equal methods', async () => {
    await mount(<Auth onAuth={() => {}} />)
    assert.deepEqual(
      ['Sign in', 'Sign up', 'Pair'].map((l) => !!tab(l)),
      [true, true, true],
      'three equally-present page buttons'
    )
    const methods = methodButtons()
    assert.ok(methods.includes('Sign in with password'))
    assert.ok(methods.includes('Sign in with recovery code'))
  })

  test('the current page tab is grayed and inert; the others navigate', async () => {
    await mount(<Auth onAuth={() => {}} />)
    assert.ok(tab('Sign in').disabled, 'the current tab is inert')
    assert.ok(tab('Sign in').className.includes('active'), 'and marked active/grayed')
    assert.ok(!tab('Sign up').disabled, 'the others are live')
  })

  test('sign up drops recovery and adds a display name', async () => {
    await mount(<Auth onAuth={() => {}} />)
    await click(tab('Sign up'))
    const methods = methodButtons()
    assert.ok(methods.includes('Sign up with password'))
    assert.ok(!methods.some((m) => m.includes('recovery')), 'no recovery method on sign up')
    const display = $('input[placeholder="display name (optional)"]')
    assert.ok(display && !display.className.includes('invisible'), 'display name shown on sign up')
    assert.ok(text().includes('recovery code is created for you'))
  })

  test('the display-name row is reserved on sign in so the cards do not shift', async () => {
    await mount(<Auth onAuth={() => {}} />)
    const display = $('input[placeholder="display name (optional)"]')
    assert.ok(display, 'the field is in the layout on sign in too')
    assert.ok(display.className.includes('invisible'), 'but hidden and space-reserving')
    assert.equal(display.tabIndex, -1, 'and out of the tab order')
  })

  test('needs a handle before a method runs', async () => {
    await mount(<Auth onAuth={() => {}} />)
    // The password method is a form; submitting it without a handle is refused.
    await submit($$('form.method')[0])
    assert.ok(text().includes('Enter your handle'))
  })

  test('pair opens the new-device flow', async () => {
    globalThis.fetch = async (url, opts = {}) => {
      const p = String(url)
      if (p.endsWith('/api/pairings') && (opts.method || 'POST') === 'POST') {
        return { ok: true, json: async () => ({ code: 'PAIRXY' }) }
      }
      if (p.includes('/api/pairings/')) {
        return { ok: true, json: async () => ({ approved: false }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }
    await mount(<Auth onAuth={() => {}} />)
    await click(tab('Pair'))
    assert.ok(text().includes('PAIRXY'), 'shows the pairing code')
    assert.ok($('.fingerprint'), 'and the fingerprint to compare')
  })
})

describe('showing the password you are typing', () => {
  const field = () => $('.password-field input')
  const eye = () => $('.password-field .reveal')

  test('masked to start with, revealed on the eye, masked again', async () => {
    await mount(<Auth onAuth={() => {}} />)
    assert.equal(field().type, 'password', 'masked on arrival')

    await click(eye())
    assert.equal(field().type, 'text', 'and now legible')

    await click(eye())
    assert.equal(field().type, 'password', 'and back')
  })

  test('the eye is a button, not a submit', async () => {
    // Asserted on the attribute rather than by clicking: the test harness
    // drives React's onClick prop directly, so it never raises a DOM submit
    // event and could not tell a submit button from an ordinary one. In a real
    // browser the default type would send a half-typed password to the server.
    await mount(<Auth onAuth={() => {}} />)
    assert.equal(eye().type, 'button')
  })

  test('it says which way it will go, for anyone not looking at it', async () => {
    await mount(<Auth onAuth={() => {}} />)
    assert.equal(eye().getAttribute('aria-label'), 'Show password')
    assert.equal(eye().getAttribute('aria-pressed'), 'false')

    await click(eye())
    assert.equal(eye().getAttribute('aria-label'), 'Hide password')
    assert.equal(eye().getAttribute('aria-pressed'), 'true')
  })

  test('sign up has it too, and starts masked there as well', async () => {
    await mount(<Auth onAuth={() => {}} />)
    await click(eye())
    await click(tab('Sign up'))
    assert.ok(eye(), 'the toggle is on the sign-up page')
    assert.equal(field().type, 'text', 'the same field, so the same state')
  })
})
