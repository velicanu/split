import base64
import binascii

from fastapi import APIRouter, HTTPException, Request, Response

from db import MAX_RECEIPT_BYTES, content_id, db
from auth import require_user
from groups import read_access, require_writable_member
from models import ReceiptIn

router = APIRouter()


@router.post("/api/groups/{group_id}/receipts")
def upload_receipt(group_id: int, body: ReceiptIn, request: Request):
    """Store an encrypted receipt under its content hash.

    The bytes are ciphertext; there is nothing here to validate about the image
    because the server cannot see one. What it *can* check is that the id is
    genuinely the hash of what was sent, which is what makes the address
    trustworthy for everyone who later fetches it."""
    user = require_user(request)
    try:
        raw = base64.b64decode(body.ciphertext, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(400, "not valid base64") from None
    if not raw:
        raise HTTPException(400, "receipt is empty")
    if len(raw) > MAX_RECEIPT_BYTES:
        raise HTTPException(413, "receipt is too large")
    if body.receipt_id != content_id(raw):
        raise HTTPException(400, "receipt id is not the hash of the content")

    with db() as conn:
        require_writable_member(conn, group_id, user["id"])
        # Content-addressed, so re-uploading the same blob is a no-op rather
        # than a conflict.
        conn.execute(
            "INSERT OR IGNORE INTO receipts (group_id, id, uploader, bytes)"
            " VALUES (?, ?, ?, ?)",
            (group_id, body.receipt_id, user["id"], raw),
        )
    return {"receipt_id": body.receipt_id}


@router.get("/api/groups/{group_id}/receipts/{receipt_id}")
def get_receipt(group_id: int, receipt_id: str, request: Request):
    with db() as conn:
        # A member, or a read-token viewer — same read capability as the feed.
        # The blob is opaque and content-addressed either way; whether it exists
        # is only revealed once you can already read the group.
        read_access(conn, group_id, request)
        row = conn.execute(
            "SELECT bytes FROM receipts WHERE group_id = ? AND id = ?",
            (group_id, receipt_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "receipt not found")
    return Response(
        content=row["bytes"],
        # Opaque bytes, never rendered by the browser: the client decrypts and
        # decides how to display. That also retires the stored-XSS worry that
        # came with serving user content under an image type.
        media_type="application/octet-stream",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )
