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


def hash_pw(password: str, salt: bytes) -> bytes:
    return scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)


class Credentials(BaseModel):
    username: str
    password: str


app = FastAPI()
init_db()


def start_session(response: Response, user_id: int) -> None:
    token = secrets.token_hex(32)
    with db() as conn:
        conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
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
    if not user or not hmac.compare_digest(user["pw_hash"], hash_pw(creds.password, user["salt"])):
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


if os.path.isdir("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="static")
