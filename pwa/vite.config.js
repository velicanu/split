import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // We are not using offline yet, and a precaching SW makes every deploy
      // that changes the API serve a stale bundle against the new backend,
      // which white-screens the app. selfDestroying ships a SW that unregisters
      // any previously-installed one and clears its caches, so clients always
      // load fresh from the network. Re-enable real caching when we build the
      // offline story (see plan/04, plan/08).
      selfDestroying: true,
      registerType: 'autoUpdate',
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
    }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:8000' },
  },
})
