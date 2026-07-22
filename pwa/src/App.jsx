import { Component, useEffect, useState } from 'react'

import { resume } from './auth'
import { parseViewLink } from './viewlink'
import { Auth } from './components/Auth'
import { Home } from './components/Home'
import { ReadOnlyGroup } from './components/ReadOnlyGroup'

// A crash must never leave a blank screen — show a reload prompt instead.
// (Most likely cause: the app updated and a stale tab is running old code
// against a newer API.)
class ErrorBoundary extends Component {
  state = { crashed: false }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  render() {
    if (this.state.crashed) {
      return (
        <main>
          <h1>Something went wrong</h1>
          <p className="muted">The app may have updated — reload to continue.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </main>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Split />
    </ErrorBoundary>
  )
}

function Split() {
  const [user, setUser] = useState(null)
  const [checking, setChecking] = useState(true)
  // A read-only share link is handled before the auth gate: the whole point is
  // that someone with no account can still see the group. Captured once.
  const viewLink = useState(() => parseViewLink(window.location.hash))[0]

  useEffect(() => {
    // If this device already holds a key there is nothing to type — it signs
    // the server's challenge and we're in.
    resume()
      .then(setUser)
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  if (checking) return null
  if (viewLink) {
    return (
      <ReadOnlyGroup
        link={viewLink}
        user={user}
        onExit={() => {
          // Drop the view link and reload into the ordinary app.
          window.location.href = window.location.pathname
          window.location.reload()
        }}
      />
    )
  }
  if (!user) return <Auth onAuth={setUser} />
  return <Home user={user} onLogout={() => setUser(null)} />
}
