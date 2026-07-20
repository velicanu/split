import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './style.css'

// Ask the browser not to evict the offline ledger. Best-effort: it may decline,
// and IndexedDB stays evictable either way, so this lowers the odds rather than
// promising anything — the server plus key recovery remain the durable copy.
// See plan/04.
navigator.storage?.persist?.().catch(() => {})

createRoot(document.getElementById('root')).render(<App />)
