import hmac
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
        conn.execute(
            "CREATE TABLE IF NOT EXISTS expenses ("
            " id INTEGER PRIMARY KEY,"
            " group_id INTEGER NOT NULL REFERENCES groups(id),"
            " description TEXT NOT NULL,"
            " amount_cents INTEGER NOT NULL,"
            " paid_by INTEGER NOT NULL REFERENCES users(id),"
            " created_at TEXT NOT NULL DEFAULT (datetime('now')))"
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


class ExpenseCreate(BaseModel):
    description: str
    amount_cents: int
    paid_by: int | None = None


app = FastAPI()
init_db()


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
    """Split an amount into whole cents, distributing the remainder cents to the
    lowest member ids deterministically so shares always sum to the total."""
    n = len(member_ids)
    base, remainder = divmod(amount_cents, n)
    return {
        uid: base + (1 if i < remainder else 0)
        for i, uid in enumerate(sorted(member_ids))
    }


def compute_balances(members, expenses):
    # Simple v1: every expense is split equally among the group's *current*
    # members. Per-expense split modes and membership snapshots are deferred.
    member_ids = [m["id"] for m in members]
    paid = {uid: 0 for uid in member_ids}
    owed = {uid: 0 for uid in member_ids}
    for e in expenses:
        for uid, share in split_equally(e["amount_cents"], member_ids).items():
            owed[uid] += share
        if e["paid_by"] in paid:
            paid[e["paid_by"]] += e["amount_cents"]
    return [
        {
            "user_id": m["id"],
            "username": m["username"],
            "paid_cents": paid[m["id"]],
            "owed_cents": owed[m["id"]],
            "net_cents": paid[m["id"]] - owed[m["id"]],
        }
        for m in members
    ]


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
        conn.execute(
            "INSERT INTO memberships (group_id, user_id) VALUES (?, ?)",
            (group_id, user["id"]),
        )
    return {"id": group_id, "name": name, "code": code}


@app.get("/api/groups")
def list_groups(request: Request):
    user = require_user(request)
    with db() as conn:
        rows = conn.execute(
            "SELECT g.id, g.name, g.code,"
            " (SELECT COUNT(*) FROM memberships m2 WHERE m2.group_id = g.id) AS members"
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
        conn.execute(
            "INSERT OR IGNORE INTO memberships (group_id, user_id) VALUES (?, ?)",
            (group["id"], user["id"]),
        )
    return {"id": group["id"], "name": group["name"], "code": group["code"]}


@app.get("/api/groups/{group_id}")
def get_group(group_id: int, request: Request):
    user = require_user(request)
    with db() as conn:
        require_member(conn, group_id, user["id"])
        group = conn.execute(
            "SELECT id, name, code FROM groups WHERE id = ?", (group_id,)
        ).fetchone()
        members = conn.execute(
            "SELECT u.id, u.username FROM memberships m"
            " JOIN users u ON u.id = m.user_id"
            " WHERE m.group_id = ? ORDER BY u.id",
            (group_id,),
        ).fetchall()
        expenses = conn.execute(
            "SELECT e.id, e.description, e.amount_cents, e.paid_by,"
            " u.username AS paid_by_name, e.created_at"
            " FROM expenses e JOIN users u ON u.id = e.paid_by"
            " WHERE e.group_id = ? ORDER BY e.id DESC",
            (group_id,),
        ).fetchall()
    return {
        "id": group["id"],
        "name": group["name"],
        "code": group["code"],
        "members": [dict(m) for m in members],
        "expenses": [dict(e) for e in expenses],
        "balances": compute_balances(members, expenses),
    }


@app.post("/api/groups/{group_id}/expenses")
def add_expense(group_id: int, body: ExpenseCreate, request: Request):
    user = require_user(request)
    description = body.description.strip()
    if not description:
        raise HTTPException(400, "description required")
    if body.amount_cents <= 0:
        raise HTTPException(400, "amount must be positive")
    with db() as conn:
        require_member(conn, group_id, user["id"])
        paid_by = body.paid_by or user["id"]
        if not conn.execute(
            "SELECT 1 FROM memberships WHERE group_id = ? AND user_id = ?",
            (group_id, paid_by),
        ).fetchone():
            raise HTTPException(400, "payer must be a group member")
        cur = conn.execute(
            "INSERT INTO expenses (group_id, description, amount_cents, paid_by)"
            " VALUES (?, ?, ?, ?)",
            (group_id, description, body.amount_cents, paid_by),
        )
    return {"id": cur.lastrowid}


if os.path.isdir("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
