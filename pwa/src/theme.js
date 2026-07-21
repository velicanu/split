// Light, dark, or follow the system — a device preference, not account data, so
// it lives in localStorage rather than the ledger. The initial value is applied
// by a tiny inline script in index.html before first paint, so there is no flash
// of the wrong theme; this module is what the settings toggle uses to change it
// live, and is the single source of the three-value contract.
//
// system (the default) sets no attribute and lets `prefers-color-scheme` decide;
// light and dark set data-theme on <html>, which the stylesheet honours over the
// system preference. See style.css.

const KEY = 'split.theme'
export const THEMES = ['system', 'light', 'dark']

/** The stored preference, or 'system' if none/garbage. */
export function loadTheme() {
  const t = localStorage.getItem(KEY)
  return THEMES.includes(t) ? t : 'system'
}

/** Reflect a theme onto the document without persisting it. */
export function applyTheme(theme) {
  const root = document.documentElement
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme)
  else root.removeAttribute('data-theme') // system → hand back to the media query
}

/** Persist and apply. 'system' is stored as absence, so a later change to the
 *  system setting is followed rather than frozen. Returns the theme applied. */
export function setTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'system'
  if (t === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, t)
  applyTheme(t)
  return t
}
