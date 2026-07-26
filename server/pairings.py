import secrets
import time

from fastapi import APIRouter, HTTPException, Request

from db import db
from auth import require_user
from models import PairingIn

router = APIRouter()

# Long enough that guessing one within its window is hopeless, short enough to
# type off a screen when the QR isn't scanned.
PAIRING_TTL_SECONDS = 600


def sweep(conn):
    conn.execute("DELETE FROM pairings WHERE expires_at < ?", (time.time(),))


@router.post("/api/pairings")
def create_pairing(body: PairingIn):
    """A new device (no account, no session) advertises its public keys and gets
    a short code back. The row holds nothing secret — only public keys and a
    flag — so this is deliberately unauthenticated: there is nothing to
    authenticate with yet."""
    code = secrets.token_urlsafe(6)
    with db() as conn:
        sweep(conn)
        conn.execute(
            "INSERT INTO pairings"
            " (code, new_pubkey, new_box_pubkey, label, expires_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                code,
                body.new_pubkey,
                body.new_box_pubkey,
                body.label,
                time.time() + PAIRING_TTL_SECONDS,
            ),
        )
    return {"code": code}


@router.get("/api/pairings/{code}")
def get_pairing(code: str):
    """The pending device's public keys and approval status. Unauthenticated on
    purpose: the old device reads the keys to show the fingerprint, and the new
    device polls the flag — both before either holds a session for this account.
    Public keys only; the fingerprint the two devices compare is what secures it,
    not this endpoint (plan/17)."""
    with db() as conn:
        sweep(conn)
        row = conn.execute(
            "SELECT new_pubkey, new_box_pubkey, label, approved FROM pairings"
            " WHERE code = ?",
            (code,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "no such pairing")
    return {
        "new_pubkey": row["new_pubkey"],
        "new_box_pubkey": row["new_box_pubkey"],
        "label": row["label"],
        "approved": bool(row["approved"]),
    }


@router.post("/api/pairings/{code}/approve")
def approve_pairing(code: str, request: Request):
    """Flip the flag the new device is polling — but only once the signed
    enrolment has actually happened. Requiring that a device with this pairing's
    key already exists under the approving user ties approval to a real
    `add_device` signature and to the right account. The flag is just the
    signal; the security-bearing step is that signature (plan/17)."""
    user = require_user(request)
    with db() as conn:
        sweep(conn)
        pairing = conn.execute(
            "SELECT new_pubkey FROM pairings WHERE code = ?", (code,)
        ).fetchone()
        if not pairing:
            raise HTTPException(404, "no such pairing")
        enrolled = conn.execute(
            "SELECT 1 FROM devices WHERE pubkey = ? AND user_id = ?",
            (pairing["new_pubkey"], user["id"]),
        ).fetchone()
        if not enrolled:
            raise HTTPException(400, "enrol the device before approving it")
        conn.execute("UPDATE pairings SET approved = 1 WHERE code = ?", (code,))
    return {"ok": True}
