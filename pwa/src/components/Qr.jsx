// A QR image for a string. The encoder is dynamically imported so it only loads
// when someone actually pairs a device, not in the main bundle.

import { useEffect, useState } from 'react'

export function Qr({ text, size = 200 }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    let live = true
    import('qrcode')
      .then((m) => m.toDataURL(text, { width: size, margin: 1 }))
      .then((url) => live && setSrc(url))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [text, size])
  if (!src) return null
  return (
    <img className="qr" src={src} alt="pairing QR code" width={size} height={size} />
  )
}
