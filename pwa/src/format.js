// Small pure helpers shared across the UI: money formatting, and working out
// which member the signed-in user is. No React, no side effects.

export const money = (cents) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`

// Text field <-> cents. A blank or unparseable field counts as nothing.
export const toCents = (text) => Math.round(parseFloat(text) * 100) || 0
export const dollars = (cents) => (cents ? (cents / 100).toFixed(2) : '')

export function memberIdFor(members, me) {
  // By id: display names are not unique, so matching on one could silently
  // attribute an expense to the wrong person.
  //
  // Returns nothing when you are not among them. Falling back to members[0] —
  // as this used to — meant that anyone whose member id had been merged away
  // or ghosted silently became whoever happened to be listed first, and their
  // next expense would be attributed to that person.
  return members.find((m) => m.id === me?.id)?.id ?? null
}
