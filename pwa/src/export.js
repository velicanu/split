// Turning the ledger into a file you can keep.
//
// The log is the whole design: every balance in the app is derived from it, so
// being able to read it — and walk away with it — is what makes the derivation
// checkable rather than something to take on faith.
//
// Serialising is kept separate from downloading so the format can be tested
// without a browser.

export const LEDGER_FORMAT = 'split.ledger.v1'

/** The log as a portable document. Events are already decrypted here; what
 *  lands on disk is plaintext, which is the point of an export and also worth
 *  telling the user before they save it. */
export function exportLedger({ group, version, events, unreadable = 0, now }) {
  return JSON.stringify(
    {
      format: LEDGER_FORMAT,
      exported_at: (now ?? new Date()).toISOString(),
      group: { id: group?.id ?? null, name: group?.name ?? null },
      // The server's sequence number at export time: two exports with the same
      // version describe the same ledger.
      version,
      event_count: events.length,
      // Anything this device could not decrypt is absent from `events`. Say so
      // in the file rather than letting a partial export look complete.
      unreadable_count: unreadable,
      events,
    },
    null,
    2
  )
}

export function ledgerFilename(group, now) {
  const stamp = (now ?? new Date()).toISOString().slice(0, 10)
  const name = (group?.name ?? 'split')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${name || 'split'}-ledger-${stamp}.json`
}

/** Browser-only: hand the file to the user. */
export function downloadJson(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
