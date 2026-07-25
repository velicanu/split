import base64
import sqlite3
import binascii
import secrets

from fastapi import APIRouter, HTTPException, Request, Response

from db import MAX_RECEIPT_BYTES, content_id, db
from auth import require_user
from models import BillClaimGhostIn, BillClaimsIn, BillCreate, BillJoinIn

router = APIRouter()


BILL_TOKEN_HEADER = "X-Bill-Token"


def bill_access(conn, bill_id: str, request: Request):
    """Anyone presenting the bill's token may read it and join it. Returns the
    bill row, or 404 — the same answer whether the bill is missing or the token
    is wrong, so the token stays opaque and a bill id is never confirmed to
    someone who cannot open it."""
    row = conn.execute(
        "SELECT id, token, snapshot FROM bills WHERE id = ?", (bill_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "bill not found")
    token = request.headers.get(BILL_TOKEN_HEADER)
    if not token or not secrets.compare_digest(row["token"], token):
        raise HTTPException(404, "bill not found")
    return row


@router.post("/api/bills")
def create_bill(body: BillCreate, request: Request):
    """Publish a bill. Authenticated: the creator scanned it in their logged-in
    view, and requiring a session keeps anonymous bill-spam off the table. The
    snapshot and every seeded name arrive already sealed under the bill key,
    which the server never sees."""
    user = require_user(request)
    if not body.snapshot:
        raise HTTPException(400, "bill snapshot required")
    receipts = []
    for r in body.receipts:
        try:
            raw = base64.b64decode(r.ciphertext, validate=True)
        except (ValueError, binascii.Error):
            raise HTTPException(400, "not valid base64") from None
        if not raw:
            raise HTTPException(400, "receipt is empty")
        if len(raw) > MAX_RECEIPT_BYTES:
            raise HTTPException(413, "receipt is too large")
        if r.receipt_id != content_id(raw):
            raise HTTPException(400, "receipt id is not the hash of the content")
        receipts.append((r.receipt_id, raw))

    bill_id = secrets.token_urlsafe(9)
    token = secrets.token_urlsafe(16)
    with db() as conn:
        conn.execute(
            "INSERT INTO bills (id, token, snapshot, created_by) VALUES (?, ?, ?, ?)",
            (bill_id, token, body.snapshot, user["id"]),
        )
        for p in body.participants:
            conn.execute(
                "INSERT INTO bill_participants (bill_id, participant_id, name)"
                " VALUES (?, ?, ?)",
                (bill_id, p.participant_id, p.name),
            )
        for rid, raw in receipts:
            conn.execute(
                "INSERT OR IGNORE INTO bill_receipts (bill_id, id, bytes)"
                " VALUES (?, ?, ?)",
                (bill_id, rid, raw),
            )
    return {"id": bill_id, "token": token}


@router.get("/api/bills/{bill_id}")
def get_bill(bill_id: str, request: Request):
    with db() as conn:
        bill = bill_access(conn, bill_id, request)
        rows = conn.execute(
            "SELECT participant_id, name, claims, secret FROM bill_participants"
            " WHERE bill_id = ? ORDER BY participant_id",
            (bill_id,),
        ).fetchall()
    return {
        "id": bill["id"],
        "snapshot": bill["snapshot"],
        "participants": [
            {
                "participant_id": r["participant_id"],
                "name": r["name"],
                "claims": r["claims"],
                # Whether a seeded ghost is still free to claim. The secret that
                # decides it never leaves the server.
                "claimed": r["secret"] is not None,
            }
            for r in rows
        ],
    }


@router.post("/api/bills/{bill_id}/participants")
def join_bill(bill_id: str, body: BillJoinIn, request: Request):
    """Add yourself to a bill. The secret you mint here owns your claims; the
    server stores it and checks it, never reads it."""
    with db() as conn:
        bill_access(conn, bill_id, request)
        try:
            conn.execute(
                "INSERT INTO bill_participants (bill_id, participant_id, name, secret)"
                " VALUES (?, ?, ?, ?)",
                (bill_id, body.participant_id, body.name, body.secret),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "that participant id is taken") from None
    return {"participant_id": body.participant_id}


@router.post("/api/bills/{bill_id}/participants/{pid}/claim")
def claim_bill_ghost(bill_id: str, pid: int, body: BillClaimGhostIn, request: Request):
    """Take over a seeded ghost. First bind wins: the `secret IS NULL` guard on
    the update is what makes claiming-once atomic even if two people race for
    the same name at the table."""
    with db() as conn:
        bill_access(conn, bill_id, request)
        cur = conn.execute(
            "UPDATE bill_participants SET secret = ?"
            " WHERE bill_id = ? AND participant_id = ? AND secret IS NULL",
            (body.secret, bill_id, pid),
        )
        if not cur.rowcount:
            exists = conn.execute(
                "SELECT 1 FROM bill_participants"
                " WHERE bill_id = ? AND participant_id = ?",
                (bill_id, pid),
            ).fetchone()
            raise HTTPException(
                409 if exists else 404,
                "that person has already been claimed"
                if exists
                else "no such person on this bill",
            )
    return {"participant_id": pid}


@router.put("/api/bills/{bill_id}/participants/{pid}/claims")
def set_bill_claims(bill_id: str, pid: int, body: BillClaimsIn, request: Request):
    """Edit my own claims. The secret proves the row is mine — nobody else with
    the link can rewrite what I claimed. An unclaimed ghost has no secret, so it
    cannot be written to until someone joins as it."""
    with db() as conn:
        bill_access(conn, bill_id, request)
        row = conn.execute(
            "SELECT secret FROM bill_participants"
            " WHERE bill_id = ? AND participant_id = ?",
            (bill_id, pid),
        ).fetchone()
        if not row or row["secret"] is None:
            raise HTTPException(404, "no such person on this bill")
        if not secrets.compare_digest(row["secret"], body.secret):
            raise HTTPException(403, "these are not your claims to change")
        conn.execute(
            "UPDATE bill_participants SET claims = ?"
            " WHERE bill_id = ? AND participant_id = ?",
            (body.claims, bill_id, pid),
        )
    return {"ok": True}


@router.get("/api/bills/{bill_id}/receipts/{receipt_id}")
def get_bill_receipt(bill_id: str, receipt_id: str, request: Request):
    with db() as conn:
        bill_access(conn, bill_id, request)
        row = conn.execute(
            "SELECT bytes FROM bill_receipts WHERE bill_id = ? AND id = ?",
            (bill_id, receipt_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "receipt not found")
    return Response(
        content=row["bytes"],
        media_type="application/octet-stream",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )
