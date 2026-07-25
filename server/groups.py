import json
import secrets

from fastapi import APIRouter, HTTPException, Request

from db import db
from auth import require_user
from models import EventIn, GhostIn, GroupCreate, GroupKeysIn, JoinGroup, ReadSharingIn

router = APIRouter()


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


READ_TOKEN_HEADER = "X-Read-Token"


def read_access(conn, group_id: int, request: Request):
    """Who may *read* a group's feed: a member, or anyone presenting the group's
    read token. Returns the user row for a member, or None for a token reader
    (who has no account). Raises if neither holds.

    The token is checked with a constant-time compare, and only against this
    group's own token — it is a per-group capability, not a master key."""
    token = request.headers.get(READ_TOKEN_HEADER)
    if token:
        row = conn.execute(
            "SELECT read_token FROM groups WHERE id = ?", (group_id,)
        ).fetchone()
        if (
            row
            and row["read_token"]
            and secrets.compare_digest(row["read_token"], token)
        ):
            return None
        raise HTTPException(403, "invalid or disabled read link")
    # No token: fall back to the ordinary member path.
    user = require_user(request)
    require_member(conn, group_id, user["id"])
    return user


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


@router.post("/api/groups")
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


@router.get("/api/groups")
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


@router.post("/api/groups/join")
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


@router.get("/api/groups/{group_id}")
def get_group(group_id: int, request: Request):
    with db() as conn:
        user = read_access(conn, group_id, request)
        group = conn.execute(
            "SELECT id, name, code FROM groups WHERE id = ?", (group_id,)
        ).fetchone()
    # A token reader gets the name only. The join code is the write capability;
    # it travels in the share link's fragment for account-holders, never handed
    # out by this endpoint to someone reading anonymously.
    if user is None:
        return {"id": group["id"], "name": group["name"], "read_only": True}
    return {"id": group["id"], "name": group["name"], "code": group["code"]}


@router.get("/api/groups/{group_id}/events")
def get_events(group_id: int, request: Request, since: int = 0):
    with db() as conn:
        user = read_access(conn, group_id, request)
        # A ghosted member is served the group frozen at the event that ghosted
        # them — never anything after. Capping here rather than deleting their
        # membership is what makes the cut deterministic: it is a position in
        # the log, not whenever they happened to sync. A token reader is not a
        # member and has no cut — they see the whole current feed.
        cut = None
        if user is not None:
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


@router.get("/api/groups/{group_id}/keys")
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
                "SELECT id FROM devices WHERE user_id = ?",
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


@router.post("/api/groups/{group_id}/keys")
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


@router.post("/api/groups/{group_id}/hide")
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


@router.get("/api/groups/{group_id}/read-sharing")
def get_read_sharing(group_id: int, request: Request):
    """The current read token, so a member can show or rebuild the share link.
    Members only — a token reader must not be able to read the token itself."""
    user = require_user(request)
    with db() as conn:
        require_writable_member(conn, group_id, user["id"])
        row = conn.execute(
            "SELECT read_token FROM groups WHERE id = ?", (group_id,)
        ).fetchone()
    return {"read_token": row["read_token"]}


@router.post("/api/groups/{group_id}/read-sharing")
def set_read_sharing(group_id: int, body: ReadSharingIn, request: Request):
    """Turn read-sharing on (minting a token if there is none, or rotating it)
    or off (clearing it). A ghosted member can't touch it — writable members
    only. Off is the default; this is the deliberate switch."""
    user = require_user(request)
    with db() as conn:
        require_writable_member(conn, group_id, user["id"])
        if not body.enabled:
            conn.execute(
                "UPDATE groups SET read_token = NULL WHERE id = ?", (group_id,)
            )
            return {"read_token": None}
        current = conn.execute(
            "SELECT read_token FROM groups WHERE id = ?", (group_id,)
        ).fetchone()["read_token"]
        token = current
        if token is None or body.rotate:
            token = secrets.token_urlsafe(16)
            conn.execute(
                "UPDATE groups SET read_token = ? WHERE id = ?", (token, group_id)
            )
    return {"read_token": token}


@router.post("/api/groups/{group_id}/ghost")
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


@router.post("/api/groups/{group_id}/events")
def post_event(group_id: int, body: EventIn, request: Request):
    user = require_user(request)
    if not body.event_id or not body.type:
        raise HTTPException(400, "event_id and type required")
    if body.type == "member.added":
        # The member list is server-owned routing state, logged by create and
        # join. A client able to forge it could write somebody into a group,
        # or claim a member id the server refused them.
        #
        # Only this one event. `member.ghost_added` and `member.left` are
        # ledger claims any member may make, sealed like everything else — a
        # prefix match here silently broke every ghost path. See plan/12.
        raise HTTPException(400, "member.added is written by the server")
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
