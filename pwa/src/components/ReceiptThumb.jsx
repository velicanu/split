// A single receipt thumbnail: fetch (with optional read-link access), verify,
// decrypt, and show it, linking to the full image.

import { useEffect, useState } from 'react'

import { receiptUrl } from '../receipts'

// Receipts are ciphertext on the server, so a plain <img src> would render
// nothing. Fetch, verify against the content hash, decrypt, then show.
export function ReceiptThumb({ groupId, receiptId, access }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    receiptUrl(groupId, receiptId, access)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [groupId, receiptId, access])

  if (failed) {
    return <span className="receipt-thumb muted">unreadable</span>
  }
  if (!url) return <span className="receipt-thumb" />
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img className="receipt-thumb" src={url} alt="receipt" />
    </a>
  )
}
