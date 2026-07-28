// A bottom sheet: a frosted panel that springs up from the bottom over a scrim,
// with a grab handle. Used for the add-expense form and the pairing approval —
// anywhere the mockup slides content up rather than replacing the screen. Closes
// on scrim tap or Escape; the panel swallows clicks so they don't reach the
// scrim. See plan/18.

import { useEffect } from 'react'

export function Sheet({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grab" aria-hidden="true" />
        {title && <h3 className="sheet-title">{title}</h3>}
        {children}
      </div>
    </div>
  )
}
