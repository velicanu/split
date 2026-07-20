import base64
import binascii
import hashlib
import json
import os
import secrets
import sqlite3
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DB_PATH = os.environ.get("DB_PATH", "split.db")
COOKIE = "split_session"
# A challenge is single-use; this only bounds how long an unused one lingers.
CHALLENGE_TTL_SECONDS = 300


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# Bump whenever the schema changes shape. See reset_if_stale below: while we
# are still in development this triggers a wipe, not a migration.
SCHEMA_VERSION = 7


def reset_if_stale(conn):
    """Drop everything when the schema version moves.

    No migrations until development is finished — WIP data is disposable. The
    catch is that `CREATE TABLE IF NOT EXISTS` silently does nothing against an
    older table, so without this a deployed database keeps its old columns and
    the first INSERT fails at runtime. That is exactly what happened when
    PR A shipped: the release notes said the data was dropped, but nothing
    dropped it.

    DESTRUCTIVE, and deliberately so. Remove this before there is data anyone
    cares about, and write real migrations instead.
    """
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version != SCHEMA_VERSION:
        tables = conn.execute(
            "SELECT name FROM sqlite_master"
            " WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        for (name,) in tables:
            conn.execute(f'DROP TABLE IF EXISTS "{name}"')
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def init_db():
    with db() as conn:
        reset_if_stale(conn)
        # No password material here at all. The server authenticates a signature
        # from a registered device key, so it holds nothing that could be used
        # to impersonate a user or decrypt their data.
        #
        # login_handle is unique only so a device with no keys yet can find its
        # wrapped account key. display_name is what people actually see and is
        # deliberately NOT unique.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS users ("
            " id INTEGER PRIMARY KEY,"
            " login_handle TEXT UNIQUE NOT NULL,"
            " display_name TEXT NOT NULL,"
            " account_pubkey TEXT NOT NULL,"
            # X25519, so group keys can be sealed to the account for the
            # no-live-device enrolment path. Distinct from account_pubkey,
            # which is Ed25519 and only ever signs.
            " account_box_pubkey TEXT NOT NULL)"
        )
        # The account private key, encrypted client-side. Opaque here.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS key_wraps ("
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " method TEXT NOT NULL,"
            " params TEXT NOT NULL,"
            " ciphertext TEXT NOT NULL,"
            " PRIMARY KEY (user_id, method))"
        )
        # One row per device. Revoking sets revoked_at: the device can no longer
        # authenticate, and — because it only ever held its own key — cannot
        # enrol a replacement either.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS devices ("
            " id TEXT PRIMARY KEY,"
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " pubkey TEXT UNIQUE NOT NULL,"
            " box_pubkey TEXT NOT NULL,"
            " label TEXT NOT NULL,"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')),"
            " revoked_at TEXT)"
        )
        # A group's symmetric key, sealed to one recipient. The server relays
        # these without being able to open any of them: sealing is anonymous
        # X25519, so only the holder of the matching secret key can read one.
        # Rows are always self-authored — you seal the key you already have to
        # your own account and devices. Nobody wraps a key for anyone else,
        # because an invite link carries it in the URL fragment instead.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS group_keys ("
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " recipient_kind TEXT NOT NULL,"
            " recipient_id TEXT NOT NULL,"
            " ciphertext TEXT NOT NULL,"
            " PRIMARY KEY (group_id, recipient_kind, recipient_id))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS challenges ("
            " nonce TEXT PRIMARY KEY,"
            " pubkey TEXT NOT NULL,"
            " expires_at REAL NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions ("
            " token TEXT PRIMARY KEY,"
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " device_id TEXT NOT NULL REFERENCES devices(id))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS groups ("
            " id INTEGER PRIMARY KEY,"
            " name TEXT NOT NULL,"
            " code TEXT UNIQUE NOT NULL,"
            " created_by INTEGER NOT NULL REFERENCES users(id))"
        )
        # `until_event_id` is what makes ghosting a fork rather than a race.
        # A ghosted member keeps their membership and keeps being served the
        # group — capped at the event that ghosted them. The cut is a position
        # in the log, so it does not matter whether they sync a second later or
        # a year later: they see exactly the prefix, deterministically.
        #
        # `hidden` is set when someone revives out of a group: the row stays,
        # so their receipts and the frozen prefix remain reachable, but the
        # group stops appearing in their list. A view preference rather than a
        # secret — the server already knows who is in what.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS memberships ("
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " until_event_id INTEGER,"
            " hidden INTEGER NOT NULL DEFAULT 0,"
            " PRIMARY KEY (group_id, user_id))"
        )
        # Append-only per-group event log. `id` is a global monotonic sequence
        # that doubles as the sync cursor / group version. The server stores
        # payloads opaquely and never computes on them — clients fold the log.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            " id INTEGER PRIMARY KEY,"
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " event_id TEXT UNIQUE NOT NULL,"
            " type TEXT NOT NULL,"
            " payload TEXT NOT NULL,"
            " author INTEGER NOT NULL REFERENCES users(id),"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')))"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS events_group_id ON events (group_id, id)"
        )
        # Per-user AI provider credentials. There is no built-in default
        # provider: with no rows the feature is simply unavailable. Adding a key
        # or explicitly switching sets active=1 (and clears the others), so the
        # latest add-or-select wins. Keys are stored in the clear for now.
        # Receipt images, encrypted client-side under the group key. The server
        # stores ciphertext and has no idea what any of it depicts — there is no
        # content type here because it cannot know one.
        #
        # `id` is the BLAKE2b-256 hash of the ciphertext, so storage is
        # content-addressed: the server cannot substitute one blob for another
        # without the client noticing, and a repeated upload is a no-op.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS receipts ("
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " id TEXT NOT NULL,"
            " uploader INTEGER NOT NULL REFERENCES users(id),"
            " bytes BLOB NOT NULL,"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')),"
            # Keyed by group as well as content: an id says what a blob *is*,
            # not who may read it. Two groups uploading identical bytes must
            # not end up sharing one row whose access is decided by whichever
            # got there first.
            " PRIMARY KEY (group_id, id))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ai_providers ("
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " provider TEXT NOT NULL,"
            " model TEXT NOT NULL,"
            " active INTEGER NOT NULL DEFAULT 0,"
            " PRIMARY KEY (user_id, provider))"
        )
        # The API key itself, sealed to one recipient. Same shape and same
        # reasoning as group_keys: the server relays copies it cannot open, and
        # accepts only rows you address to yourself.
        #
        # This is a live billable credential — the most immediately expensive
        # thing in the database — so it gets the same treatment as everything
        # else rather than being the one plaintext exception.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ai_keys ("
            " user_id INTEGER NOT NULL REFERENCES users(id),"
            " provider TEXT NOT NULL,"
            " recipient_kind TEXT NOT NULL,"
            " recipient_id TEXT NOT NULL,"
            " ciphertext TEXT NOT NULL,"
            " PRIMARY KEY (user_id, provider, recipient_kind, recipient_id))"
        )


def verify_sig(pubkey_b64: str, message: bytes, sig_b64: str) -> bool:
    """Ed25519 detached verification. Any malformed input is just a failure —
    this sits on unauthenticated endpoints, so it must not raise."""
    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(pubkey_b64))
        key.verify(base64.b64decode(sig_b64), message)
        return True
    except (InvalidSignature, ValueError, binascii.Error):
        return False


class WrapIn(BaseModel):
    method: str
    params: str
    ciphertext: str


class SignupIn(BaseModel):
    login_handle: str
    display_name: str
    account_pubkey: str
    account_box_pubkey: str
    device_pubkey: str
    box_pubkey: str
    label: str = "this device"
    wraps: list[WrapIn] = []


class ChallengeIn(BaseModel):
    device_pubkey: str


class VerifyIn(BaseModel):
    device_pubkey: str
    nonce: str
    signature: str


class DeviceIn(BaseModel):
    pubkey: str
    box_pubkey: str
    label: str = "new device"
    # Who authorised this enrolment: a device that is already trusted, or the
    # account key (the no-live-device path). The signature is over the new
    # device's own public key, which binds the authorisation to this device.
    signed_by: str  # 'device' | 'account'
    signer_pubkey: str
    signature: str


class WrapsReplace(BaseModel):
    wraps: list[WrapIn]


class GroupCreate(BaseModel):
    name: str


class JoinGroup(BaseModel):
    code: str
    # The member id from the invite's `as=`, if it named one.
    claims: int | None = None


class EventIn(BaseModel):
    event_id: str
    type: str
    payload: dict = {}


# Cheapest vision-capable model per provider — the default when a key is added.
DEFAULT_MODELS = {"anthropic": "claude-haiku-4-5", "openai": "gpt-5.4-nano"}


class ReceiptIn(BaseModel):
    receipt_id: str
    ciphertext: str


class ProviderIn(BaseModel):
    # No api_key field: a plaintext key sent here would be silently ignored,
    # which is worse than refusing it. Keys arrive sealed, via /keys.
    model: str | None = None


class ActiveIn(BaseModel):
    provider: str


app = FastAPI()
init_db()


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
            " WHERE s.token = ? AND d.revoked_at IS NULL",
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


@app.post("/api/auth/challenge")
def auth_challenge(body: ChallengeIn):
    with db() as conn:
        # Issued for any key: replying that a key is unknown would leak which
        # devices exist. An unknown key simply fails at /verify instead.
        return {"nonce": new_challenge(conn, body.device_pubkey)}


@app.post("/api/auth/verify")
def auth_verify(body: VerifyIn, response: Response):
    with db() as conn:
        fresh = take_challenge(conn, body.nonce, body.device_pubkey)
        device = conn.execute(
            "SELECT id, user_id FROM devices WHERE pubkey = ? AND revoked_at IS NULL",
            (body.device_pubkey,),
        ).fetchone()
    if not fresh or not device:
        raise HTTPException(401, "authentication failed")
    if not verify_sig(body.device_pubkey, body.nonce.encode(), body.signature):
        raise HTTPException(401, "authentication failed")
    start_session(response, device["user_id"], device["id"])
    return {"ok": True}


@app.post("/api/signup")
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
                    "INSERT INTO key_wraps (user_id, method, params, ciphertext)"
                    " VALUES (?, ?, ?, ?)",
                    (user_id, w.method, w.params, w.ciphertext),
                )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "login handle already taken") from None
    start_session(response, user_id, device_id)
    return {"display_name": display, "login_handle": handle}


@app.get("/api/wraps")
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
            "SELECT method, params, ciphertext FROM key_wraps WHERE user_id = ?",
            (user["id"],),
        ).fetchall()
    return {
        "account_pubkey": user["account_pubkey"],
        "wraps": [dict(r) for r in rows],
    }


@app.get("/api/devices")
def list_devices(request: Request):
    user = require_user(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT id, label, box_pubkey, created_at, revoked_at FROM devices"
            " WHERE user_id = ? ORDER BY created_at",
            (user["id"],),
        ).fetchall()
    return {
        "devices": [{**dict(r), "current": r["id"] == user["device_id"]} for r in rows]
    }


@app.post("/api/devices")
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
                "SELECT user_id FROM devices WHERE pubkey = ? AND revoked_at IS NULL",
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


@app.delete("/api/devices/{device_id}")
def revoke_device(device_id: str, request: Request):
    user = require_user(request)
    with db() as conn:
        row = conn.execute(
            "SELECT id FROM devices WHERE id = ? AND user_id = ?",
            (device_id, user["id"]),
        ).fetchone()
        if not row:
            raise HTTPException(404, "device not found")
        conn.execute(
            "UPDATE devices SET revoked_at = datetime('now')"
            " WHERE id = ? AND revoked_at IS NULL",
            (device_id,),
        )
        # Drop its sessions too, so revocation takes effect on the next request
        # rather than whenever its cookie happens to expire.
        conn.execute("DELETE FROM sessions WHERE device_id = ?", (device_id,))
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/api/me")
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


@app.put("/api/wraps")
def replace_wraps(body: WrapsReplace, request: Request):
    """Changing your password is re-wrapping the account key on the client and
    replacing the blob. The server verifies nothing about it — it cannot: it
    has never seen the old password and will never see the new one, and it
    holds no plaintext to check the result against."""
    user = require_user(request)
    if not body.wraps:
        raise HTTPException(400, "at least one wrap required")
    with db() as conn:
        conn.execute("DELETE FROM key_wraps WHERE user_id = ?", (user["id"],))
        for w in body.wraps:
            conn.execute(
                "INSERT INTO key_wraps (user_id, method, params, ciphertext)"
                " VALUES (?, ?, ?, ?)",
                (user["id"], w.method, w.params, w.ciphertext),
            )
    return {"ok": True}


def require_user(request: Request):
    user = current_user(request)
    if not user:
        raise HTTPException(401, "not logged in")
    return user


def require_member(conn, group_id: int, user_id: int):
    row = conn.execute(
        "SELECT 1 FROM memberships WHERE group_id = ? AND user_id = ?",
        (group_id, user_id),
    ).fetchone()
    if not row:
        # 404 rather than 403 so we don't leak which group ids exist
        raise HTTPException(404, "group not found")


def require_writable_member(conn, group_id: int, user_id: int):
    """A ghosted member may still read their frozen prefix, but must not write.
    Otherwise they could keep appending events the group sees and they never
    will — a one-way conversation into a ledger they have left."""
    require_member(conn, group_id, user_id)
    row = conn.execute(
        "SELECT until_event_id FROM memberships WHERE group_id = ? AND user_id = ?",
        (group_id, user_id),
    ).fetchone()
    if row["until_event_id"] is not None:
        raise HTTPException(403, "you are no longer part of this group")


def split_equally(amount_cents: int, member_ids: list[int]) -> dict[int, int]:
    """Reference split: whole cents, remainder distributed to the lowest member
    ids deterministically so shares always sum to the total. The client mirrors
    this exactly (pwa/src/ledger.js) — they must agree, so this stays the
    canonical spec covered by golden vectors even though the server, being a
    blind relay, does not compute balances itself."""
    n = len(member_ids)
    base, remainder = divmod(amount_cents, n)
    return {
        uid: base + (1 if i < remainder else 0)
        for i, uid in enumerate(sorted(member_ids))
    }


def group_version(conn, group_id: int) -> int:
    return conn.execute(
        "SELECT COALESCE(MAX(id), 0) FROM events WHERE group_id = ?", (group_id,)
    ).fetchone()[0]


def append_event(conn, group_id, event_id, type_, payload, author) -> int:
    cur = conn.execute(
        "INSERT INTO events (group_id, event_id, type, payload, author)"
        " VALUES (?, ?, ?, ?, ?)",
        (group_id, event_id, type_, json.dumps(payload), author),
    )
    return cur.lastrowid


def add_member(conn, group_id, user, claims=None):
    """Record a membership and log a member.added event so clients folding the
    ledger see the member set. Returns True if newly added.

    `claims` is the member id the invite named — the ghost this account is
    taking over. It rides on member.added rather than being an event of its
    own so that claiming can only ever happen at the instant of joining: there
    is no event an already-joined member can write to become somebody else.
    See plan/12."""
    cur = conn.execute(
        "INSERT OR IGNORE INTO memberships (group_id, user_id) VALUES (?, ?)",
        (group_id, user["id"]),
    )
    if not cur.rowcount:
        return False
    payload = {"user_id": user["id"], "display_name": user["display_name"]}
    if claims is not None:
        payload["claims"] = claims
    append_event(
        conn,
        group_id,
        secrets.token_hex(16),
        "member.added",
        payload,
        user["id"],
    )
    return True


@app.post("/api/groups")
def create_group(body: GroupCreate, request: Request):
    user = require_user(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "group name required")
    code = secrets.token_hex(4)
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO groups (name, code, created_by) VALUES (?, ?, ?)",
            (name, code, user["id"]),
        )
        group_id = cur.lastrowid
        add_member(conn, group_id, user)
    return {"id": group_id, "name": name, "code": code}


@app.get("/api/groups")
def list_groups(request: Request):
    user = require_user(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT g.id, g.name, g.code,"
            " (SELECT COUNT(*) FROM memberships m2 WHERE m2.group_id = g.id)"
            "   AS members,"
            " (SELECT COALESCE(MAX(e.id), 0) FROM events e WHERE e.group_id = g.id)"
            "   AS version"
            " , m.until_event_id AS until_event_id"
            " FROM groups g JOIN memberships m ON m.group_id = g.id"
            " WHERE m.user_id = ? AND m.hidden = 0 ORDER BY g.id DESC",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/groups/join")
def join_group(body: JoinGroup, request: Request):
    user = require_user(request)
    with db() as conn:
        group = conn.execute(
            "SELECT id, name, code FROM groups WHERE code = ?", (body.code.strip(),)
        ).fetchone()
        if not group:
            raise HTTPException(404, "no group with that code")
        if body.claims is not None:
            if body.claims == user["id"]:
                raise HTTPException(400, "cannot claim yourself")
            # Claimed at most once, enforced here rather than trusted to the
            # fold. member.added is the one event the server writes, and in the
            # clear, which is what makes this checkable at all — under the old
            # encrypted merge event a modified client could simply skip it.
            #
            # What the server cannot check is that the id is a real ghost:
            # member.ghost_added is encrypted, so it has no idea who exists.
            taken = conn.execute(
                "SELECT 1 FROM events WHERE group_id = ? AND type = 'member.added'"
                " AND json_extract(payload, '$.claims') = ?",
                (group["id"], body.claims),
            ).fetchone()
            if taken:
                raise HTTPException(409, "that member has already been claimed")
        add_member(conn, group["id"], user, claims=body.claims)
    return {"id": group["id"], "name": group["name"], "code": group["code"]}


@app.get("/api/groups/{group_id}")
def get_group(group_id: int, request: Request):
    user = require_user(request)
    with db() as conn:
        require_member(conn, group_id, user["id"])
        group = conn.execute(
            "SELECT id, name, code FROM groups WHERE id = ?", (group_id,)
        ).fetchone()
    return {"id": group["id"], "name": group["name"], "code": group["code"]}


@app.get("/api/groups/{group_id}/events")
def get_events(group_id: int, request: Request, since: int = 0):
    user = require_user(request)
    with db() as conn:
        require_member(conn, group_id, user["id"])
        # A ghosted member is served the group frozen at the event that ghosted
        # them — never anything after. Capping here rather than deleting their
        # membership is what makes the cut deterministic: it is a position in
        # the log, not whenever they happened to sync.
        cut = conn.execute(
            "SELECT until_event_id FROM memberships WHERE group_id = ? AND user_id = ?",
            (group_id, user["id"]),
        ).fetchone()["until_event_id"]
        rows = conn.execute(
            "SELECT id, event_id, type, payload, author, created_at FROM events"
            " WHERE group_id = ? AND id > ? AND (? IS NULL OR id <= ?)"
            " ORDER BY id",
            (group_id, since, cut, cut),
        ).fetchall()
        version = cut if cut is not None else group_version(conn, group_id)
    events = []
    for r in rows:
        e = dict(r)
        e["payload"] = json.loads(e["payload"])
        events.append(e)
    return {"version": version, "events": events}


class GhostIn(BaseModel):
    # The member being ghosted, and the event that records it. The event is
    # appended by the client (it is encrypted, so the server cannot write it);
    # this call is what freezes their feed at that point.
    member_id: int
    at_event_id: int


class GroupKeysIn(BaseModel):
    keys: list[dict]


@app.get("/api/groups/{group_id}/keys")
def get_group_keys(group_id: int, request: Request):
    """The group key, sealed to me. Several rows: one per device, plus one to
    the account for the enrol-with-no-device path."""
    user = require_user(request)
    with db() as conn:
        require_member(conn, group_id, user["id"])
        mine = [str(user["id"])]
        devices = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL",
                (user["id"],),
            ).fetchall()
        ]
        rows = conn.execute(
            "SELECT recipient_kind, recipient_id, ciphertext FROM group_keys"
            " WHERE group_id = ?",
            (group_id,),
        ).fetchall()
    keep = [
        dict(r)
        for r in rows
        if (r["recipient_kind"] == "account" and r["recipient_id"] in mine)
        or (r["recipient_kind"] == "device" and r["recipient_id"] in devices)
    ]
    return {"keys": keep}


@app.post("/api/groups/{group_id}/keys")
def put_group_keys(group_id: int, body: GroupKeysIn, request: Request):
    """Store the group key sealed to my own account or devices.

    You may only address yourself. Nobody wraps a key for anyone else — an
    invite link carries it in the URL fragment instead — so accepting a row
    aimed at another user would be handing them a key they never asked for,
    and a way to plant one."""
    user = require_user(request)
    with db() as conn:
        require_member(conn, group_id, user["id"])
        my_devices = {
            r["id"]
            for r in conn.execute(
                "SELECT id FROM devices WHERE user_id = ?", (user["id"],)
            ).fetchall()
        }
        for k in body.keys:
            kind = k.get("recipient_kind")
            rid = str(k.get("recipient_id", ""))
            ciphertext = k.get("ciphertext")
            if not ciphertext or kind not in ("account", "device"):
                raise HTTPException(400, "malformed key")
            mine = rid == str(user["id"]) if kind == "account" else rid in my_devices
            if not mine:
                raise HTTPException(403, "you can only store keys for yourself")
            conn.execute(
                "INSERT OR REPLACE INTO group_keys"
                " (group_id, recipient_kind, recipient_id, ciphertext)"
                " VALUES (?, ?, ?, ?)",
                (group_id, kind, rid, ciphertext),
            )
    return {"ok": True}


@app.post("/api/groups/{group_id}/hide")
def hide_group(group_id: int, request: Request, hidden: bool = True):
    """Stop showing a group in this user's list, without leaving it.

    Set when someone revives out of a group. The membership row stays, so the
    frozen prefix and their receipts remain reachable and the decision about
    what receipts should do stays open. Reversible on purpose."""
    user = require_user(request)
    with db() as conn:
        require_member(conn, group_id, user["id"])
        conn.execute(
            "UPDATE memberships SET hidden = ? WHERE group_id = ? AND user_id = ?",
            (1 if hidden else 0, group_id, user["id"]),
        )
    return {"ok": True, "hidden": hidden}


@app.post("/api/groups/{group_id}/ghost")
def ghost_member(group_id: int, body: GhostIn, request: Request):
    """Freeze a member's view of the group at a given event.

    Any member may do this to any member, including themselves — leaving is
    just ghosting yourself. The person keeps their membership row and keeps
    being served the group, capped at `at_event_id`, so what they already had
    is never taken away; they simply stop receiving what comes next.

    When nobody is left reading the group, it is deleted outright."""
    user = require_user(request)
    with db() as conn:
        require_member(conn, group_id, user["id"])
        target = conn.execute(
            "SELECT until_event_id FROM memberships WHERE group_id = ? AND user_id = ?",
            (group_id, body.member_id),
        ).fetchone()
        if not target:
            # A ghost id, or somebody who was never here. The ledger event is
            # what matters for those; there is no feed to freeze.
            return {"ok": True, "deleted": False}
        if target["until_event_id"] is None:
            conn.execute(
                "UPDATE memberships SET until_event_id = ?"
                " WHERE group_id = ? AND user_id = ?",
                (body.at_event_id, group_id, body.member_id),
            )

        live = conn.execute(
            "SELECT COUNT(*) FROM memberships"
            " WHERE group_id = ? AND until_event_id IS NULL",
            (group_id,),
        ).fetchone()[0]
        if live:
            return {"ok": True, "deleted": False}

        # Nobody is reading it any more. Membership reaching zero is one of the
        # few things the server can decide without reading a payload.
        for table in ("events", "receipts", "group_keys", "memberships"):
            conn.execute(f"DELETE FROM {table} WHERE group_id = ?", (group_id,))
        conn.execute("DELETE FROM groups WHERE id = ?", (group_id,))
    return {"ok": True, "deleted": True}


@app.get("/api/account/box")
def my_box_key(request: Request):
    """This account's X25519 public key, so a freshly enrolled device can seal
    group keys back to the account it just unlocked."""
    user = require_user(request)
    with db() as conn:
        row = conn.execute(
            "SELECT account_box_pubkey FROM users WHERE id = ?", (user["id"],)
        ).fetchone()
    return {"account_box_pubkey": row["account_box_pubkey"]}


MAX_RECEIPT_BYTES = 8 * 1024 * 1024


def content_id(raw: bytes) -> str:
    """BLAKE2b-256, matching libsodium's crypto_generichash at 32 bytes so the
    client and server agree on what a blob is called."""
    return hashlib.blake2b(raw, digest_size=32).hexdigest()


@app.post("/api/groups/{group_id}/receipts")
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


@app.get("/api/groups/{group_id}/receipts/{receipt_id}")
def get_receipt(group_id: int, receipt_id: str, request: Request):
    user = require_user(request)
    with db() as conn:
        # Membership first: whether a given blob exists is itself information.
        require_member(conn, group_id, user["id"])
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


@app.post("/api/groups/{group_id}/events")
def post_event(group_id: int, body: EventIn, request: Request):
    user = require_user(request)
    if not body.event_id or not body.type:
        raise HTTPException(400, "event_id and type required")
    if body.type.startswith("member."):
        # membership is server-owned routing state; it is logged by
        # create/join, not forgeable through the generic event endpoint
        raise HTTPException(400, "membership changes are not appended directly")
    with db() as conn:
        require_writable_member(conn, group_id, user["id"])
        existing = conn.execute(
            "SELECT id FROM events WHERE event_id = ?", (body.event_id,)
        ).fetchone()
        if existing:
            # idempotent: a retried push of the same event is a no-op
            return {"id": existing["id"], "duplicate": True}
        new_id = append_event(
            conn, group_id, body.event_id, body.type, body.payload, user["id"]
        )
    return {"id": new_id}


def require_provider(provider: str) -> str:
    if provider not in DEFAULT_MODELS:
        raise HTTPException(404, "unknown provider")
    return provider


def make_active(conn, user_id: int, provider: str) -> None:
    conn.execute("UPDATE ai_providers SET active = 0 WHERE user_id = ?", (user_id,))
    conn.execute(
        "UPDATE ai_providers SET active = 1 WHERE user_id = ? AND provider = ?",
        (user_id, provider),
    )


@app.get("/api/ai/settings")
def ai_settings(request: Request):
    """Model choice and which provider is in use, plus the API key sealed to
    *this* device. The key is ciphertext; the client opens it locally and the
    server has no copy it can read."""
    user = require_user(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT provider, model, active FROM ai_providers"
            " WHERE user_id = ? ORDER BY provider",
            (user["id"],),
        ).fetchall()
        sealed = conn.execute(
            "SELECT provider, ciphertext FROM ai_keys"
            " WHERE user_id = ? AND recipient_kind = 'device' AND recipient_id = ?",
            (user["id"], user["device_id"]),
        ).fetchall()
    mine = {r["provider"]: r["ciphertext"] for r in sealed}
    active = next((r["provider"] for r in rows if r["active"]), None)
    return {
        "active": active,
        "providers": {
            r["provider"]: {
                "model": r["model"],
                # None means: a key exists for this account but not sealed to
                # this device yet. The UI can say so rather than pretending
                # there is no key at all.
                "sealed_key": mine.get(r["provider"]),
            }
            for r in rows
        },
    }


@app.post("/api/ai/providers/{provider}/keys")
def put_ai_keys(provider: str, body: GroupKeysIn, request: Request):
    """Store the API key sealed to my own devices and account.

    Same rule as group keys: you may only address yourself. Accepting a row
    aimed at someone else would let a user plant a credential on another
    account, and the recipient could not tell it was not their own."""
    user = require_user(request)
    require_provider(provider)
    with db() as conn:
        my_devices = {
            r["id"]
            for r in conn.execute(
                "SELECT id FROM devices WHERE user_id = ?", (user["id"],)
            ).fetchall()
        }
        for k in body.keys:
            kind = k.get("recipient_kind")
            rid = str(k.get("recipient_id", ""))
            ciphertext = k.get("ciphertext")
            if not ciphertext or kind not in ("account", "device"):
                raise HTTPException(400, "malformed key")
            mine = rid == str(user["id"]) if kind == "account" else rid in my_devices
            if not mine:
                raise HTTPException(403, "you can only store keys for yourself")
            conn.execute(
                "INSERT OR REPLACE INTO ai_keys"
                " (user_id, provider, recipient_kind, recipient_id, ciphertext)"
                " VALUES (?, ?, ?, ?, ?)",
                (user["id"], provider, kind, rid, ciphertext),
            )
        # Storing a key is what makes a provider usable, so it becomes active.
        conn.execute(
            "INSERT INTO ai_providers (user_id, provider, model) VALUES (?, ?, ?)"
            " ON CONFLICT(user_id, provider) DO NOTHING",
            (user["id"], provider, DEFAULT_MODELS[provider]),
        )
        make_active(conn, user["id"], provider)
    return {"ok": True}


@app.get("/api/ai/providers/{provider}/keys")
def get_ai_keys(provider: str, request: Request):
    """Every sealed copy of my key for this provider — used during enrolment,
    where the account copy is the only one a brand-new device can open."""
    user = require_user(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT recipient_kind, recipient_id, ciphertext FROM ai_keys"
            " WHERE user_id = ? AND provider = ?",
            (user["id"], provider),
        ).fetchall()
    return {"keys": [dict(r) for r in rows]}


@app.put("/api/ai/providers/{provider}")
def put_provider(provider: str, body: ProviderIn, request: Request):
    user = require_user(request)
    require_provider(provider)
    # Only the model is settable here now; the key arrives sealed, via
    # /keys, and never passes through the server in the clear.
    if body.model is None:
        raise HTTPException(400, "model required")
    model = body.model.strip()
    if not model:
        raise HTTPException(400, "model required")
    with db() as conn:
        existing = conn.execute(
            "SELECT model FROM ai_providers WHERE user_id = ? AND provider = ?",
            (user["id"], provider),
        ).fetchone()
        if not existing:
            raise HTTPException(404, "no key for that provider")
        conn.execute(
            "UPDATE ai_providers SET model = ? WHERE user_id = ? AND provider = ?",
            (model, user["id"], provider),
        )
    return {"ok": True}


@app.post("/api/ai/active")
def set_active(body: ActiveIn, request: Request):
    user = require_user(request)
    require_provider(body.provider)
    with db() as conn:
        row = conn.execute(
            "SELECT 1 FROM ai_providers WHERE user_id = ? AND provider = ?",
            (user["id"], body.provider),
        ).fetchone()
        if not row:
            raise HTTPException(404, "no key for that provider")
        make_active(conn, user["id"], body.provider)
    return {"ok": True}


@app.delete("/api/ai/providers/{provider}")
def delete_provider(provider: str, request: Request):
    user = require_user(request)
    require_provider(provider)
    with db() as conn:
        was_active = conn.execute(
            "SELECT active FROM ai_providers WHERE user_id = ? AND provider = ?",
            (user["id"], provider),
        ).fetchone()
        conn.execute(
            "DELETE FROM ai_providers WHERE user_id = ? AND provider = ?",
            (user["id"], provider),
        )
        # Every sealed copy goes too, or removing a key would leave it readable
        # on the devices it was already sealed to.
        conn.execute(
            "DELETE FROM ai_keys WHERE user_id = ? AND provider = ?",
            (user["id"], provider),
        )
        # Removing the active provider hands active to whatever key is left.
        if was_active and was_active["active"]:
            other = conn.execute(
                "SELECT provider FROM ai_providers WHERE user_id = ? ORDER BY provider",
                (user["id"],),
            ).fetchone()
            if other:
                make_active(conn, user["id"], other["provider"])
    return {"ok": True}


class AppStatics(StaticFiles):
    """Serve the built PWA with cache headers that can't strand an old bundle.

    Starlette sends no Cache-Control, so browsers fall back to heuristic
    freshness and may reuse index.html for hours. Since index.html names the
    content-hashed bundles, a stale copy runs old JavaScript against a new API —
    which is what produced a wall of validation errors after PR A shipped.

    The hashed assets are immutable by construction and can be cached forever;
    everything that *points* at them must revalidate every time.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        name = os.path.basename(str(full_path))
        immutable = "/assets/" in str(full_path).replace(os.sep, "/")
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable"
            if immutable and name != "index.html"
            else "no-cache"
        )
        return response


if os.path.isdir("static"):
    app.mount("/", AppStatics(directory="static", html=True), name="static")
