import hmac
import json
import os
import secrets
import sqlite3
from hashlib import scrypt

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DB_PATH = os.environ.get("DB_PATH", "split.db")
COOKIE = "split_session"


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS users ("
            " id INTEGER PRIMARY KEY,"
            " username TEXT UNIQUE NOT NULL,"
            " salt BLOB NOT NULL,"
            " pw_hash BLOB NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions ("
            " token TEXT PRIMARY KEY,"
            " user_id INTEGER NOT NULL REFERENCES users(id))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS groups ("
            " id INTEGER PRIMARY KEY,"
            " name TEXT NOT NULL,"
            " code TEXT UNIQUE NOT NULL,"
            " created_by INTEGER NOT NULL REFERENCES users(id))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS memberships ("
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " user_id INTEGER NOT NULL REFERENCES users(id),"
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
        backfill_legacy(conn)


def _table_exists(conn, name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
        ).fetchone()
        is not None
    )


def backfill_legacy(conn):
    """Synthesize events for data created before the event log existed — groups,
    memberships, and rows in the pre-ledger `expenses` table — so every client
    can fold a complete history. Idempotent: safe to run on every startup."""
    # A member.added event for each membership that lacks one.
    for g in conn.execute("SELECT DISTINCT group_id FROM memberships").fetchall():
        gid = g["group_id"]
        have = {
            json.loads(r["payload"])["user_id"]
            for r in conn.execute(
                "SELECT payload FROM events"
                " WHERE group_id = ? AND type = 'member.added'",
                (gid,),
            ).fetchall()
        }
        members = conn.execute(
            "SELECT u.id, u.username FROM memberships m"
            " JOIN users u ON u.id = m.user_id"
            " WHERE m.group_id = ? ORDER BY u.id",
            (gid,),
        ).fetchall()
        for u in members:
            if u["id"] in have:
                continue
            append_event(
                conn,
                gid,
                f"legacy-member-{gid}-{u['id']}",
                "member.added",
                {"user_id": u["id"], "username": u["username"]},
                u["id"],
                ignore_dupe=True,
            )
    # An expense.created event for each row in the surviving pre-ledger table.
    if _table_exists(conn, "expenses"):
        for e in conn.execute(
            "SELECT id, group_id, description, amount_cents, paid_by"
            " FROM expenses ORDER BY id"
        ).fetchall():
            append_event(
                conn,
                e["group_id"],
                f"legacy-expense-{e['id']}",
                "expense.created",
                {
                    "description": e["description"],
                    "amount_cents": e["amount_cents"],
                    "paid_by": e["paid_by"],
                },
                e["paid_by"],
                ignore_dupe=True,
            )


def hash_pw(password: str, salt: bytes) -> bytes:
    return scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


class Credentials(BaseModel):
    username: str
    password: str


class GroupCreate(BaseModel):
    name: str


class JoinGroup(BaseModel):
    code: str


class EventIn(BaseModel):
    event_id: str
    type: str
    payload: dict = {}


app = FastAPI()


def start_session(response: Response, user_id: int) -> None:
    token = secrets.token_hex(32)
    with db() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id)
        )
    response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=True)


def current_user(request: Request):
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    with db() as conn:
        return conn.execute(
            "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token = ?",
            (token,),
        ).fetchone()


@app.post("/api/signup")
def signup(creds: Credentials, response: Response):
    username = creds.username.strip()
    if not username or not creds.password:
        raise HTTPException(400, "username and password required")
    salt = secrets.token_bytes(16)
    try:
        with db() as conn:
            cur = conn.execute(
                "INSERT INTO users (username, salt, pw_hash) VALUES (?, ?, ?)",
                (username, salt, hash_pw(creds.password, salt)),
            )
            user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(409, "username already taken")
    start_session(response, user_id)
    return {"username": username}


@app.post("/api/login")
def login(creds: Credentials, response: Response):
    with db() as conn:
        user = conn.execute(
            "SELECT id, username, salt, pw_hash FROM users WHERE username = ?",
            (creds.username.strip(),),
        ).fetchone()
    if not user or not hmac.compare_digest(
        user["pw_hash"], hash_pw(creds.password, user["salt"])
    ):
        raise HTTPException(401, "invalid username or password")
    start_session(response, user["id"])
    return {"username": user["username"]}


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
    return {"username": user["username"]}


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


def append_event(
    conn, group_id, event_id, type_, payload, author, ignore_dupe=False
) -> int:
    verb = "INSERT OR IGNORE INTO" if ignore_dupe else "INSERT INTO"
    cur = conn.execute(
        f"{verb} events (group_id, event_id, type, payload, author)"
        " VALUES (?, ?, ?, ?, ?)",
        (group_id, event_id, type_, json.dumps(payload), author),
    )
    return cur.lastrowid


def add_member(conn, group_id, user):
    """Record a membership and log a member.added event so clients folding the
    ledger see the member set. Returns True if newly added."""
    cur = conn.execute(
        "INSERT OR IGNORE INTO memberships (group_id, user_id) VALUES (?, ?)",
        (group_id, user["id"]),
    )
    if not cur.rowcount:
        return False
    append_event(
        conn,
        group_id,
        secrets.token_hex(16),
        "member.added",
        {"user_id": user["id"], "username": user["username"]},
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
            " FROM groups g JOIN memberships m ON m.group_id = g.id"
            " WHERE m.user_id = ? ORDER BY g.id DESC",
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
        add_member(conn, group["id"], user)
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
        rows = conn.execute(
            "SELECT id, event_id, type, payload, author, created_at FROM events"
            " WHERE group_id = ? AND id > ? ORDER BY id",
            (group_id, since),
        ).fetchall()
        version = group_version(conn, group_id)
    events = []
    for r in rows:
        e = dict(r)
        e["payload"] = json.loads(e["payload"])
        events.append(e)
    return {"version": version, "events": events}


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
        require_member(conn, group_id, user["id"])
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


# Runs after all helpers are defined; also performs the idempotent legacy
# backfill (see backfill_legacy).
init_db()


if os.path.isdir("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
