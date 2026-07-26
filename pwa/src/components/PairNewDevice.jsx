// The new device's side of pairing: advertise this device's keys, show the code
// + QR + fingerprint, and finish once the other device approves. See plan/17.

import { useEffect, useRef, useState } from 'react'

import { completePairing, pairLink, pairingApproved, startPairing } from '../pairing'
import { Qr } from './Qr'

export function PairNewDevice({ onPaired, onCancel }) {
  const [pending, setPending] = useState(null)
  const [error, setError] = useState('')
  const done = useRef(false)

  useEffect(() => {
    let live = true
    startPairing()
      .then((p) => live && setPending(p))
      .catch((e) => live && setError(e.message))
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    let live = true
    const id = setInterval(async () => {
      try {
        if ((await pairingApproved(pending.code)) && !done.current) {
          done.current = true
          clearInterval(id)
          onPaired(await completePairing(pending.device))
        }
      } catch (e) {
        if (live) setError(e.message)
      }
    }, 2000)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [pending, onPaired])

  if (error) {
    return (
      <main>
        <h1>Split</h1>
        <p className="error">{error}</p>
        <button className="link" onClick={onCancel}>
          back
        </button>
      </main>
    )
  }
  if (!pending) return null

  return (
    <main>
      <h1>Add this device</h1>
      <p className="muted">
        On a device you&rsquo;re already signed in on, open{' '}
        <strong>Settings → Pair a new device</strong>, then scan this or type the
        code.
      </p>
      <Qr text={pairLink(window.location.origin, pending.code)} />
      <p>
        <strong className="pair-code">{pending.code}</strong>
      </p>
      <h3>Check it&rsquo;s really you</h3>
      <p className="muted">
        Both devices should show the same picture. Confirm they match before you
        approve on the other device.
      </p>
      <p className="fingerprint">{pending.fingerprint}</p>
      <p className="muted">Waiting for approval…</p>
      <button className="link" onClick={onCancel}>
        cancel
      </button>
    </main>
  )
}
