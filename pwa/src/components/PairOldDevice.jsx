// The signed-in device's side of pairing: read the pending device's keys (by
// typed code, or a code pre-filled from a scanned deep link), confirm the
// fingerprint matches the new device's screen, then approve — signing the new
// device in and sealing the group keys to it. See plan/17.

import { useEffect, useState } from 'react'

import { approvePairing, fetchPairing, parsePairCode } from '../pairing'

export function PairOldDevice({ code: initialCode, onClose }) {
  const [code, setCode] = useState(initialCode || '')
  const [pairing, setPairing] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function look(raw) {
    setError('')
    const c = parsePairCode(raw)
    if (!c) return setError('Enter the code shown on the new device')
    setBusy(true)
    try {
      setPairing(await fetchPairing(c))
    } catch {
      setError('That code isn’t valid — it may have expired')
    } finally {
      setBusy(false)
    }
  }

  // A scanned deep link (#pair=<code>) pre-fills the code: look it up at once.
  useEffect(() => {
    if (initialCode) look(initialCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode])

  async function approve() {
    setBusy(true)
    setError('')
    try {
      await approvePairing(pairing)
      setDone(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <section>
        <h3>Device added</h3>
        <p className="muted">
          The other device is now signed in and can see your groups.
        </p>
        <button onClick={onClose}>Done</button>
      </section>
    )
  }

  return (
    <section>
      <h3>Pair a new device</h3>
      {!pairing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            look(code)
          }}
        >
          <p className="muted">
            Enter the code shown on the new device, or scan its QR with your
            camera to open it here.
          </p>
          <input
            placeholder="pairing code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
          />
          <div className="row-actions">
            <button type="submit" disabled={busy}>
              {busy ? 'looking…' : 'Look up'}
            </button>
            <button type="button" className="link" onClick={onClose}>
              cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted">
            Confirm this picture matches the one on the new device — that&rsquo;s
            what proves it&rsquo;s really your device and not someone else&rsquo;s.
          </p>
          <p className="fingerprint">{pairing.fingerprint}</p>
          <div className="row-actions">
            <button onClick={approve} disabled={busy}>
              {busy ? 'adding…' : 'They match — add the device'}
            </button>
            <button className="link" onClick={() => setPairing(null)}>
              they don&rsquo;t match
            </button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
