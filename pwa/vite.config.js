import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

import { pwaOptions } from './src/pwa.js'

export default defineConfig({
  plugins: [react(), VitePWA(pwaOptions)],
  server: {
    proxy: { '/api': 'http://localhost:8000' },
  },
})
