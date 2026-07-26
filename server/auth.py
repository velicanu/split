import base64
import binascii
import sqlite3
import secrets
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import APIRouter, HTTPException, Request, Response

from db import db
from models import ChallengeIn, DeviceIn, SignupIn, VerifyIn, WrapIn

COOKIE = "split_session"
# A challenge is single-use; this only bounds how long an unused one lingers.
CHALLENGE_TTL_SECONDS = 300

router = APIRouter()


def verify_sig(pubkey_b64: str, message: bytes, sig_b64: str) -> bool:
    """Ed25519 detached verification. Any malformed input is just a failure —
    this sits on unauthenticated endpoints, so it must not raise."""
    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(pubkey_b64))
        key.verify(base64.b64decode(sig_b64), message)
        return True
    except (InvalidSignature, ValueError, binascii.Error):
        return False


def start_session(response: Response, user_id: int, device_id: str) -> None:
    token = secrets.token_hex(32)
    with db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, device_id) VALUES (?, ?, ?)",
            (token, user_id, device_id),
        )
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=True)


def current_user(request: Request):
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    with db() as conn:
        # Joining devices is what makes revocation bite: revoke the device and
        # every session it holds stops resolving, immediately.
        return conn.execute(
            "SELECT u.id, u.login_handle, u.display_name, s.device_id"
            " FROM sessions s"
            " JOIN users u ON u.id = s.user_id"
            " JOIN devices d ON d.id = s.device_id"
            " WHERE s.token = ?",
            (token,),
        ).fetchone()


def new_challenge(conn, pubkey: str) -> str:
    nonce = secrets.token_urlsafe(32)
    conn.execute("DELETE FROM challenges WHERE expires_at < ?", (time.time(),))
    conn.execute(
        "INSERT INTO challenges (nonce, pubkey, expires_at) VALUES (?, ?, ?)",
        (nonce, pubkey, time.time() + CHALLENGE_TTL_SECONDS),
    )
    return nonce


def take_challenge(conn, nonce: str, pubkey: str) -> bool:
    """Single use: consumed whether or not it turns out to be valid."""
    row = conn.execute(
        "SELECT pubkey, expires_at FROM challenges WHERE nonce = ?", (nonce,)
    ).fetchone()
    if not row:
        return False
    conn.execute("DELETE FROM challenges WHERE nonce = ?", (nonce,))
    return row["pubkey"] == pubkey and row["expires_at"] >= time.time()


def require_user(request: Request):
    user = current_user(request)
    if not user:
        raise HTTPException(401, "not logged in")
    return user


@router.post("/api/auth/challenge")
def auth_challenge(body: ChallengeIn):
    with db() as conn:
        # Issued for any key: replying that a key is unknown would leak which
        # devices exist. An unknown key simply fails at /verify instead.
        return {"nonce": new_challenge(conn, body.device_pubkey)}


@router.post("/api/auth/verify")
def auth_verify(body: VerifyIn, response: Response):
    with db() as conn:
        fresh = take_challenge(conn, body.nonce, body.device_pubkey)
        device = conn.execute(
            "SELECT id, user_id FROM devices WHERE pubkey = ?",
            (body.device_pubkey,),
        ).fetchone()
    if not fresh or not device:
        raise HTTPException(401, "authentication failed")
    if not verify_sig(body.device_pubkey, body.nonce.encode(), body.signature):
        raise HTTPException(401, "authentication failed")
    start_session(response, device["user_id"], device["id"])
    return {"ok": True}


@router.post("/api/signup")
def signup(body: SignupIn, response: Response):
    handle = body.login_handle.strip()
    display = body.display_name.strip() or handle
    if not handle:
        raise HTTPException(400, "login handle required")
    if not all(
        [
            body.account_pubkey,
            body.account_box_pubkey,
            body.device_pubkey,
            body.box_pubkey,
        ]
    ):
        raise HTTPException(400, "keys required")
    try:
        with db() as conn:
            cur = conn.execute(
                "INSERT INTO users (login_handle, display_name, account_pubkey,"
                " account_box_pubkey) VALUES (?, ?, ?, ?)",
                (handle, display, body.account_pubkey, body.account_box_pubkey),
            )
            user_id = cur.lastrowid
            device_id = secrets.token_urlsafe(12)
            conn.execute(
                "INSERT INTO devices (id, user_id, pubkey, box_pubkey, label)"
                " VALUES (?, ?, ?, ?, ?)",
                (device_id, user_id, body.device_pubkey, body.box_pubkey, body.label),
            )
            for w in body.wraps:
                conn.execute(
                    "INSERT INTO key_wraps (user_id, id, method, params, ciphertext)"
                    " VALUES (?, ?, ?, ?, ?)",
                    (user_id, w.id, w.method, w.params, w.ciphertext),
                )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "login handle already taken") from None
    start_session(response, user_id, device_id)
    return {"display_name": display, "login_handle": handle}


@router.get("/api/wraps")
def get_wraps(login_handle: str):
    """Hands the encrypted account key to a device that has no keys yet.

    Deliberately unauthenticated — there is nothing to authenticate *with* at
    this point. The blob is useless without the password, and Argon2id is what
    stands between a leaked blob and the data. See plan/11."""
    with db() as conn:
        user = conn.execute(
            "SELECT id, account_pubkey FROM users WHERE login_handle = ?",
            (login_handle.strip(),),
        ).fetchone()
        if not user:
            # Same shape as a real answer with no wraps, so this doesn't become
            # an oracle for which handles exist.
            return {"account_pubkey": None, "wraps": []}
        rows = conn.execute(
            "SELECT id, method, params, ciphertext FROM key_wraps WHERE user_id = ?",
            (user["id"],),
        ).fetchall()
    return {
        "account_pubkey": user["account_pubkey"],
        "wraps": [dict(r) for r in rows],
    }


@router.get("/api/devices")
def list_devices(request: Request):
    user = require_user(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, label, box_pubkey, created_at FROM devices"
            " WHERE user_id = ? ORDER BY created_at",
            (user["id"],),
        ).fetchall()
    return {
        "devices": [{**dict(r), "current": r["id"] == user["device_id"]} for r in rows]
    }


@router.post("/api/devices")
def add_device(body: DeviceIn, request: Request, response: Response):
    """Enrol a device. Authority comes from a signature, not from a session:
    either a device that is already trusted, or the account key (the no-live-
    device path). Signing the new device's own public key binds the two."""
    if body.signed_by not in ("device", "account"):
        raise HTTPException(400, "signed_by must be 'device' or 'account'")

    with db() as conn:
        if body.signed_by == "account":
            signer = conn.execute(
                "SELECT id AS user_id FROM users WHERE account_pubkey = ?",
                (body.signer_pubkey,),
            ).fetchone()
        else:
            # A revoked device must not be able to enrol a replacement — that is
            # the whole point of revoking it.
            signer = conn.execute(
                "SELECT user_id FROM devices WHERE pubkey = ?",
                (body.signer_pubkey,),
            ).fetchone()
        if not signer or not verify_sig(
            body.signer_pubkey, body.pubkey.encode(), body.signature
        ):
            raise HTTPException(401, "invalid authorisation")
        user_id = signer["user_id"]

        device_id = secrets.token_urlsafe(12)
        try:
            conn.execute(
                "INSERT INTO devices (id, user_id, pubkey, box_pubkey, label)"
                " VALUES (?, ?, ?, ?, ?)",
                (device_id, user_id, body.pubkey, body.box_pubkey, body.label),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "device already enrolled") from None
    return {"device_id": device_id}


@router.delete("/api/devices/{device_id}")
def revoke_device(device_id: str, request: Request):
    user = require_user(request)
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM devices WHERE id = ? AND user_id = ?",
            (device_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(404, "device not found")
        # Sessions first, then the device: sessions reference devices, so with
        # foreign keys enforced the child has to go before the parent. Dropping
        # the sessions also makes revocation bite on the next request rather than
        # whenever the cookie happens to expire.
        #
        # Deleted, not tombstoned: a device that is gone fails every check a
        # revoked one would have, and nobody wants to scroll a list of browsers
        # they no longer use.
        conn.execute("DELETE FROM sessions WHERE device_id = ?", (device_id,))
        conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
    return {"ok": True}


@router.post("/api/logout")
def logout(request: Request, response: Response):
    """Log out, which means un-enrolling this device.

    A device key alone can sign the challenge, so a browser that keeps its key
    after logging out is a browser anyone can walk up to and sign back in on.
    Logging out therefore deletes the device outright: getting back in needs
    the password, the same as anywhere else.

    The row is deleted rather than marked revoked. Nobody wants a list of every
    browser they have ever signed out of, and a device that is gone fails every
    check a revoked one would have."""
    token = request.cookies.get(COOKIE)
    if token:
        with db() as conn:
            row = conn.execute(
                "SELECT device_id FROM sessions WHERE token = ?", (token,)
            ).fetchone()
            if row:
                # Sessions before the device — sessions reference devices, and
                # foreign keys are enforced.
                conn.execute(
                    "DELETE FROM sessions WHERE device_id = ?", (row["device_id"],)
                )
                conn.execute("DELETE FROM devices WHERE id = ?", (row["device_id"],))
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/api/me")
def me(request: Request):
    user = current_user(request)
    if not user:
        raise HTTPException(401, "not logged in")
    return {
        # id, because display names are not unique — a client must not try to
        # work out which member it is by matching on a name.
        "id": user["id"],
        "login_handle": user["login_handle"],
        "display_name": user["display_name"],
        "device_id": user["device_id"],
    }


@router.post("/api/wraps")
def put_wrap(body: WrapIn, request: Request):
    """Add or replace one wrap of the account key — a new passkey, a rotated
    recovery code, a changed password (same id, new blob). The server verifies
    nothing about it: it has never seen the unlock secret and holds no plaintext
    to check against. A client that stores garbage only locks itself out of that
    one method.

    Adding a wrap requires an existing session — you are on a device that has
    already unlocked the account to produce this blob. See plan/16."""
    user = require_user(request)
    with db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO key_wraps (user_id, id, method, params, ciphertext)"
            " VALUES (?, ?, ?, ?, ?)",
            (user["id"], body.id, body.method, body.params, body.ciphertext),
        )
    return {"ok": True}


@router.delete("/api/wraps/{wrap_id}")
def delete_wrap(wrap_id: str, request: Request):
    """Drop one unlock method — e.g. remove the password once a passkey and a
    recovery code exist, so a weak password can't undermine the strong ones.

    The last wrap can never be deleted: with none, a lost device would be an
    unrecoverable account, and the server holds nothing it could reset."""
    user = require_user(request)
    with db() as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM key_wraps WHERE user_id = ?", (user["id"],)
        ).fetchone()[0]
        if total <= 1:
            raise HTTPException(400, "cannot remove your only way back in")
        cur = conn.execute(
            "DELETE FROM key_wraps WHERE user_id = ? AND id = ?",
            (user["id"], wrap_id),
        )
        if not cur.rowcount:
            raise HTTPException(404, "no such wrap")
    return {"ok": True}


@router.get("/api/account/box")
def my_box_key(request: Request):
    """This account's X25519 public key, so a freshly enrolled device can seal
    group keys back to the account it just unlocked."""
    user = require_user(request)
    with db() as conn:
        row = conn.execute(
            "SELECT account_box_pubkey FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
    return {"account_box_pubkey": row["account_box_pubkey"]}
