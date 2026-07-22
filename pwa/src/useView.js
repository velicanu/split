// The current view, backed by browser history (nav.js): navigate pushes an
// entry and updates the view; a popstate reads it back out of the URL.

import { useCallback, useEffect, useState } from 'react'

import { readView, viewHash } from './nav'

// The current screen, backed by browser history so a refresh returns here and
// the Android back gesture (and desktop back button) walk the views the way
// they walk pages anywhere else. See nav.js.
//
// History is the source of truth, not React state: `navigate` pushes an entry
// and updates the view, and a back/forward — which is a popstate — reads the
// view back out of the URL. Pushing is what gives back somewhere to go;
// replaceState would leave the stack empty and back would exit the app, which
// is the bug this fixes.
export function useView(initial) {
  const [view, setView] = useState(initial)

  useEffect(() => {
    const onPop = () => setView(readView(window.location.hash))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next, { replace = false } = {}) => {
    const target = viewHash(next)
    const url = target || window.location.pathname
    // Don't stack a second entry for the view we are already on — a repeated
    // tap on "home" should not need two back gestures to undo.
    if (!replace && window.location.hash === target) {
      setView(next)
      return
    }
    window.history[replace ? 'replaceState' : 'pushState'](null, '', url)
    setView(next)
  }, [])

  return [view, navigate]
}
