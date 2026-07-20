// Test bootstrap: teaches Node to load the app's source the way Vite does,
// then puts enough of a browser in place for React to render into.
//
// Loaded via `node --import ./test/setup.mjs`, so all of this runs before any
// test file (and therefore before React) is imported.
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

import { transformSync } from 'esbuild'
import { JSDOM } from 'jsdom'

registerHooks({
  resolve(specifier, context, nextResolve) {
    // Vite resolves extensionless relative imports ('./ledger'); Node won't.
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.js', '.jsx']) {
        const candidate = new URL(specifier + ext, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true }
        }
      }
    }
    return nextResolve(specifier, context)
  },

  load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context)
    // Match vite.config.js: the automatic runtime, so no React import needed.
    const { code } = transformSync(readFileSync(fileURLToPath(url), 'utf8'), {
      loader: 'jsx',
      jsx: 'automatic',
      format: 'esm',
    })
    return { format: 'module', source: code, shortCircuit: true }
  },
})

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://localhost/',
  pretendToBeVisual: true,
})
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'Node',
  'Event',
  'getComputedStyle',
  // Signing out has to survive a refresh, so it is recorded here rather than
  // in memory. See auth.js.
  'localStorage',
]) {
  globalThis[key] = dom.window[key]
}
// Lets React flush effects synchronously inside act().
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no IndexedDB, and device keys live there. Using a real
// implementation rather than a stub means the key-storage path is genuinely
// exercised — a device key that fails to persist is an account that vanishes.
const { default: fakeIndexedDB } = await import('fake-indexeddb')
const { default: FDBKeyRange } = await import('fake-indexeddb/lib/FDBKeyRange')
globalThis.indexedDB = fakeIndexedDB
globalThis.IDBKeyRange = FDBKeyRange

// jsdom ships no canvas and no image decoding. prepareImage() only needs them
// to turn a File into *some* data URL, so a stub is enough — the image bytes
// never matter to a test, since the model response is always mocked.
globalThis.createImageBitmap = async () => ({ width: 800, height: 1600 })
const createElement = document.createElement.bind(document)
document.createElement = (tag, ...rest) =>
  tag === 'canvas'
    ? {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toDataURL: () => 'data:image/jpeg;base64,QUFB',
      }
    : createElement(tag, ...rest)
