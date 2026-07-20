// Service-worker and manifest options, kept out of vite.config.js so the parts
// that carry a rule can be asserted without spinning up a build. See plan/08.

export const pwaOptions = {
  // Precache the app shell so the app can *open* with no network — without it
  // there is nothing to render the offline ledger with, and launching offline
  // is a blank page.
  //
  // This was previously selfDestroying, because a precaching worker serves a
  // stale bundle against a changed backend and white-screens the app. Two
  // things now defuse that:
  //
  //   * autoUpdate reloads to fresh code the moment a new deploy is seen, so
  //     the stale window closes on its own; and api.js already tells the user
  //     to reload if a request is rejected as an old version in the meantime.
  //   * offline-first (plan/04) means a reload loses nothing — writes live in
  //     the IndexedDB outbox, not in page state — so auto-reloading mid-session
  //     is safe, which is exactly what made it unsafe before.
  registerType: 'autoUpdate',
  workbox: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
    // A cold offline load of any path serves the shell: the app is a single
    // page with no server-side routes, everything is client-rendered.
    navigateFallback: '/index.html',
    // The API is end-to-end encrypted and read through IndexedDB, never the
    // HTTP cache. Keep /api entirely out of the worker: a sealed response must
    // never be served stale, and an offline API call has to *fail* — sync.js
    // catches that and falls back to the local ledger — rather than resolve to
    // the fallback HTML.
    navigateFallbackDenylist: [/^\/api/],
  },
  manifest: {
    name: 'Split',
    short_name: 'Split',
    display: 'standalone',
    theme_color: '#16a34a',
    background_color: '#ffffff',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  },
}
