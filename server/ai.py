from fastapi import APIRouter, HTTPException, Request

from db import db
from auth import require_user
from models import DEFAULT_MODELS, ActiveIn, GroupKeysIn, ProviderIn

router = APIRouter()


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


@router.get("/api/ai/settings")
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


@router.post("/api/ai/providers/{provider}/keys")
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


@router.get("/api/ai/providers/{provider}/keys")
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


@router.put("/api/ai/providers/{provider}")
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


@router.post("/api/ai/active")
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


@router.delete("/api/ai/providers/{provider}")
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
