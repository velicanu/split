// Rendering and querying helpers.
//
// Interaction goes through React's own prop handlers rather than dispatched
// DOM events: fireEvent/user-event don't reliably drive React 19 controlled
// text inputs under jsdom, and silently doing nothing makes for tests that
// pass while testing nothing.
import { act } from 'react'
import { createRoot } from 'react-dom/client'

// Unmounts whatever was mounted before, so effect cleanups actually run —
// a component holding an interval would otherwise keep the process alive.
let current = null

// Effects now await IndexedDB and libsodium, which resolve on macrotasks —
// act() alone returns before those settle, leaving the component mid-load.
// Every interaction helper ends with this so assertions see a settled UI.
export const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })

export async function mount(element) {
  await unmount()
  document.body.innerHTML = ''
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  await settle()
  current = root
  return root
}

export async function unmount() {
  if (current) {
    const root = current
    current = null
    await act(async () => root.unmount())
  }
}

export function props(el) {
  if (!el) throw new Error('no element to interact with')
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
  if (!key) throw new Error('element has no React props attached')
  return el[key]
}

const drive = async (fn) => {
  await act(async () => fn())
  await settle()
}

export const change = (el, value) =>
  drive(() => props(el).onChange({ target: { value } }))

export const click = (el) => drive(() => props(el).onClick({}))

export const upload = (el, file) =>
  drive(() => props(el).onChange({ target: { files: [file], value: '' } }))

export const submit = (form) =>
  drive(() => props(form).onSubmit({ preventDefault() {} }))

export const $ = (sel) => document.querySelector(sel)
export const $$ = (sel) => [...document.querySelectorAll(sel)]
export const values = (sel) => $$(sel).map((el) => el.value)
export const byText = (sel, needle) =>
  $$(sel).find((el) => el.textContent.includes(needle))
export const text = () => document.body.textContent
