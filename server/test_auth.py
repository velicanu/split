"""Challenge-signed device auth. See plan/11-identity-and-devices.md.

These use real Ed25519 keys rather than stubs — the whole point of the model is
that a signature is the credential, so faking it would test nothing.
"""

import base64
import os
import tempfile

os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(), "test.db"))

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from main import DB_PATH, app

b64 = lambda raw: base64.b64encode(raw).decode()  # noqa: E731


def keypair():
    priv = Ed25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return priv, b64(pub)


def client():
    return TestClient(app, base_url="https://testserver")


def enrolled(handle, display=None):
    """A signed-up user: returns (client, account priv/pub, device priv/pub)."""
    c = client()
    acct_priv, acct_pub = keypair()
    dev_priv, dev_pub = keypair()
    r = c.post(
        "/api/signup",
        json={
            "login_handle": handle,
            "display_name": display or handle,
            "account_pubkey": acct_pub,
            "account_box_pubkey": b64(b"acct-box-" + handle.encode()),
            "device_pubkey": dev_pub,
            "box_pubkey": b64(b"box-" + handle.encode()),
            "label": "first device",
            "wraps": [{"method": "password", "params": "{}", "ciphertext": "sealed"}],
        },
    )
    assert r.status_code == 200, r.text
    return c, (acct_priv, acct_pub), (dev_priv, dev_pub)


def sign_in(c, dev_priv, dev_pub):
    nonce = c.post("/api/auth/challenge", json={"device_pubkey": dev_pub}).json()[
        "nonce"
    ]
    return c.post(
        "/api/auth/verify",
        json={
            "device_pubkey": dev_pub,
            "nonce": nonce,
            "signature": b64(dev_priv.sign(nonce.encode())),
        },
    )


def test_signup_then_sign_in_by_signature():
    c, _, (dev_priv, dev_pub) = enrolled("sig-user", "Sig User")
    assert c.get("/api/me").json()["display_name"] == "Sig User"

    c.post("/api/logout", json={})
    assert c.get("/api/me").status_code == 401

    assert sign_in(c, dev_priv, dev_pub).status_code == 200
    assert c.get("/api/me").json()["login_handle"] == "sig-user"


def test_signup_never_stores_password_material():
    enrolled("no-secrets")
    import sqlite3

    conn = sqlite3.connect(DB_PATH)
    columns = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
    assert "pw_hash" not in columns
    assert "salt" not in columns


def test_a_bad_signature_is_rejected():
    c, _, (_, dev_pub) = enrolled("bad-sig")
    c.post("/api/logout", json={})
    other_priv, _ = keypair()

    nonce = c.post("/api/auth/challenge", json={"device_pubkey": dev_pub}).json()[
        "nonce"
    ]
    # Right nonce, right device, wrong key.
    r = c.post(
        "/api/auth/verify",
        json={
            "device_pubkey": dev_pub,
            "nonce": nonce,
            "signature": b64(other_priv.sign(nonce.encode())),
        },
    )
    assert r.status_code == 401
    assert c.get("/api/me").status_code == 401


def test_garbage_signature_does_not_crash():
    c, _, (_, dev_pub) = enrolled("garbage-sig")
    c.post("/api/logout", json={})
    nonce = c.post("/api/auth/challenge", json={"device_pubkey": dev_pub}).json()[
        "nonce"
    ]
    for sig in ["", "!!!not base64!!!", b64(b"short")]:
        r = c.post(
            "/api/auth/verify",
            json={"device_pubkey": dev_pub, "nonce": nonce, "signature": sig},
        )
        assert r.status_code == 401


def test_a_challenge_is_single_use():
    c, _, (dev_priv, dev_pub) = enrolled("replay")
    c.post("/api/logout", json={})
    nonce = c.post("/api/auth/challenge", json={"device_pubkey": dev_pub}).json()[
        "nonce"
    ]
    sig = b64(dev_priv.sign(nonce.encode()))
    body = {"device_pubkey": dev_pub, "nonce": nonce, "signature": sig}

    assert c.post("/api/auth/verify", json=body).status_code == 200
    c.post("/api/logout", json={})
    # Replaying the captured pair must not work.
    assert c.post("/api/auth/verify", json=body).status_code == 401


def test_a_challenge_is_bound_to_its_device():
    c, _, (dev_priv, dev_pub) = enrolled("bound")
    c.post("/api/logout", json={})
    other_priv, other_pub = keypair()
    # Challenge issued for someone else's key, answered with ours.
    nonce = c.post("/api/auth/challenge", json={"device_pubkey": other_pub}).json()[
        "nonce"
    ]
    r = c.post(
        "/api/auth/verify",
        json={
            "device_pubkey": dev_pub,
            "nonce": nonce,
            "signature": b64(dev_priv.sign(nonce.encode())),
        },
    )
    assert r.status_code == 401


def test_unknown_device_cannot_sign_in():
    enrolled("known-user")
    stranger_priv, stranger_pub = keypair()
    c = client()
    # A challenge is issued for any key — that must not imply the key is known.
    assert (
        c.post("/api/auth/challenge", json={"device_pubkey": stranger_pub}).status_code
        == 200
    )
    assert sign_in(c, stranger_priv, stranger_pub).status_code == 401


def test_login_handle_must_be_unique_display_name_need_not_be():
    enrolled("taken-handle", "Dave")
    c = client()
    _, acct_pub = keypair()
    _, dev_pub = keypair()
    r = c.post(
        "/api/signup",
        json={
            "login_handle": "taken-handle",
            "display_name": "Someone",
            "account_pubkey": acct_pub,
            "account_box_pubkey": "abox",
            "device_pubkey": dev_pub,
            "box_pubkey": "box",
        },
    )
    assert r.status_code == 409

    # A second Dave is fine — display names are not identities.
    other, _, _ = enrolled("dave-two", "Dave")
    assert other.get("/api/me").json()["display_name"] == "Dave"


def test_signup_validation():
    c = client()
    _, pub = keypair()
    base = {
        "login_handle": "x",
        "display_name": "x",
        "account_pubkey": pub,
        "account_box_pubkey": "abox",
        "device_pubkey": pub,
        "box_pubkey": "box",
    }
    assert c.post("/api/signup", json={**base, "login_handle": " "}).status_code == 400
    assert c.post("/api/signup", json={**base, "account_pubkey": ""}).status_code == 400
    assert c.post("/api/signup", json={**base, "box_pubkey": ""}).status_code == 400
    assert (
        c.post("/api/signup", json={**base, "account_box_pubkey": ""}).status_code
        == 400
    )


def test_wraps_are_public_but_useless_and_do_not_leak_which_handles_exist():
    enrolled("wrap-user")
    anon = client()

    found = anon.get("/api/wraps?login_handle=wrap-user").json()
    assert found["wraps"][0]["ciphertext"] == "sealed"

    missing = anon.get("/api/wraps?login_handle=no-such-user").json()
    assert missing == {"account_pubkey": None, "wraps": []}


def test_adding_a_device_needs_a_real_authorisation():
    c, (acct_priv, acct_pub), (dev_priv, dev_pub) = enrolled("adder")
    new_priv, new_pub = keypair()

    def add(**over):
        body = {
            "pubkey": new_pub,
            "box_pubkey": "box2",
            "label": "second",
            "signed_by": "device",
            "signer_pubkey": dev_pub,
            "signature": b64(dev_priv.sign(new_pub.encode())),
        }
        return c.post("/api/devices", json={**body, **over})

    # An unsigned or wrongly-signed enrolment is refused.
    assert add(signature=b64(new_priv.sign(new_pub.encode()))).status_code == 401
    assert add(signed_by="nonsense").status_code == 400
    # Signing something other than the new device's key doesn't transfer.
    assert add(signature=b64(dev_priv.sign(b"different"))).status_code == 401

    assert add().status_code == 200
    # The new device can now sign in on its own.
    fresh = client()
    assert sign_in(fresh, new_priv, new_pub).status_code == 200
    assert fresh.get("/api/me").json()["login_handle"] == "adder"

    # The account key is the other route in — the no-live-device path.
    third_priv, third_pub = keypair()
    r = c.post(
        "/api/devices",
        json={
            "pubkey": third_pub,
            "box_pubkey": "box3",
            "signed_by": "account",
            "signer_pubkey": acct_pub,
            "signature": b64(acct_priv.sign(third_pub.encode())),
        },
    )
    assert r.status_code == 200
    third = client()
    assert sign_in(third, third_priv, third_pub).status_code == 200


def test_a_device_cannot_be_enrolled_onto_someone_elses_account():
    _, (_, victim_acct), _ = enrolled("victim")
    attacker_c, _, (att_priv, att_pub) = enrolled("attacker")
    new_priv, new_pub = keypair()

    # Claiming the victim's account key while signing with our own.
    r = attacker_c.post(
        "/api/devices",
        json={
            "pubkey": new_pub,
            "box_pubkey": "b",
            "signed_by": "account",
            "signer_pubkey": victim_acct,
            "signature": b64(att_priv.sign(new_pub.encode())),
        },
    )
    assert r.status_code == 401
    assert att_pub  # (the attacker's own device is irrelevant to the check)


def test_revoking_a_device_cuts_it_off_and_it_cannot_come_back():
    owner, _, (own_priv, own_pub) = enrolled("revoker")
    second_priv, second_pub = keypair()
    owner.post(
        "/api/devices",
        json={
            "pubkey": second_pub,
            "box_pubkey": "b2",
            "label": "phone",
            "signed_by": "device",
            "signer_pubkey": own_pub,
            "signature": b64(own_priv.sign(second_pub.encode())),
        },
    )
    phone = client()
    assert sign_in(phone, second_priv, second_pub).status_code == 200
    assert phone.get("/api/me").status_code == 200

    listed = owner.get("/api/devices").json()["devices"]
    assert {d["label"] for d in listed} == {"first device", "phone"}
    target = next(d for d in listed if d["label"] == "phone")
    assert owner.get("/api/devices").json()["devices"][0]["current"] is True

    assert owner.delete(f"/api/devices/{target['id']}").status_code == 200

    # Its existing session stops resolving immediately...
    assert phone.get("/api/me").status_code == 401
    # ...it cannot sign in again...
    assert sign_in(phone, second_priv, second_pub).status_code == 401
    # ...and crucially it cannot enrol a replacement for itself.
    replacement_priv, replacement_pub = keypair()
    r = phone.post(
        "/api/devices",
        json={
            "pubkey": replacement_pub,
            "box_pubkey": "b3",
            "signed_by": "device",
            "signer_pubkey": second_pub,
            "signature": b64(second_priv.sign(replacement_pub.encode())),
        },
    )
    assert r.status_code == 401
    assert replacement_priv  # unused beyond the signature above

    # The revoking device is unaffected.
    assert owner.get("/api/me").status_code == 200


def test_a_surviving_session_on_a_revoked_device_is_still_refused():
    """Revoking deletes the device's sessions, so the belt-and-braces check in
    current_user is normally unreachable. Reach it directly: mark the device
    revoked while leaving its session row behind, which is what a partial
    failure or a future code path that forgets to clean up would look like."""
    import sqlite3

    c, _, (_, dev_pub) = enrolled("belt-and-braces")
    assert c.get("/api/me").status_code == 200

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE devices SET revoked_at = datetime('now') WHERE pubkey = ?",
        (dev_pub,),
    )
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] > 0

    assert c.get("/api/me").status_code == 401
    assert c.get("/api/groups").status_code == 401


def test_you_cannot_revoke_someone_elses_device():
    _, _, _ = enrolled("mine")
    victim, _, (v_priv, v_pub) = enrolled("theirs")
    victim_device = victim.get("/api/devices").json()["devices"][0]["id"]

    attacker, _, _ = enrolled("nosy")
    assert attacker.delete(f"/api/devices/{victim_device}").status_code == 404
    # The victim is still fine.
    assert victim.get("/api/me").status_code == 200
    assert sign_in(client(), v_priv, v_pub).status_code == 200


def test_replacing_wraps_requires_a_session():
    c, _, _ = enrolled("rewrapper")
    body = {"wraps": [{"method": "password", "params": "{}", "ciphertext": "new"}]}
    assert c.put("/api/wraps", json=body).status_code == 200
    assert (
        client()
        .get("/api/wraps?login_handle=rewrapper")
        .json()["wraps"][0]["ciphertext"]
        == "new"
    )
    assert c.put("/api/wraps", json={"wraps": []}).status_code == 400
    assert client().put("/api/wraps", json=body).status_code == 401


def test_a_stale_database_is_wiped_rather_than_half_migrated():
    """`CREATE TABLE IF NOT EXISTS` does nothing to an older table, so without
    an explicit reset a deployed database keeps its old columns and the first
    INSERT fails at runtime. That is what shipped with PR A."""
    import sqlite3
    import tempfile as tf

    from main import SCHEMA_VERSION, init_db, reset_if_stale

    path = os.path.join(tf.mkdtemp(), "old.db")
    conn = sqlite3.connect(path)
    # The pre-PR-A users table, as deployed.
    conn.execute(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE"
        " NOT NULL, salt BLOB NOT NULL, pw_hash BLOB NOT NULL)"
    )
    conn.execute(
        "INSERT INTO users (username, salt, pw_hash) VALUES ('v', x'00', x'00')"
    )
    conn.commit()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0

    reset_if_stale(conn)
    conn.commit()

    assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
    remaining = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    assert remaining == [], "the stale schema must be gone, not patched"

    # And a second run is a no-op: matching version, nothing dropped.
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)")
    conn.execute("INSERT INTO users (id) VALUES (1)")
    conn.commit()
    reset_if_stale(conn)
    assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1

    assert init_db and SCHEMA_VERSION >= 2


def test_index_html_is_never_cached_but_hashed_assets_are():
    """A cached index.html names old hashed bundles, so an old client ends up
    talking to a new API — which is how PR A produced a wall of 422s."""
    import pathlib
    import tempfile as tf

    from main import AppStatics

    root = pathlib.Path(tf.mkdtemp())
    (root / "assets").mkdir()
    (root / "index.html").write_text("<html></html>")
    (root / "assets" / "index-abc123.js").write_text("// bundle")

    from starlette.applications import Starlette
    from starlette.testclient import TestClient as STestClient

    site = Starlette()
    site.mount("/", AppStatics(directory=str(root), html=True))
    c = STestClient(site)

    assert c.get("/index.html").headers["cache-control"] == "no-cache"
    assert c.get("/").headers["cache-control"] == "no-cache"
    assert (
        c.get("/assets/index-abc123.js").headers["cache-control"]
        == "public, max-age=31536000, immutable"
    )


def test_init_db_actually_rebuilds_a_stale_database():
    """The reset only matters if init_db calls it. PR A shipped a schema the
    deployed database could not satisfy precisely because nothing wired the two
    together, so this drives the whole path rather than the helper alone."""
    import sqlite3
    import tempfile as tf

    import main

    path = os.path.join(tf.mkdtemp(), "deployed.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE"
        " NOT NULL, salt BLOB NOT NULL, pw_hash BLOB NOT NULL)"
    )
    conn.execute(
        "INSERT INTO users (username, salt, pw_hash) VALUES ('v', x'00', x'00')"
    )
    conn.commit()
    conn.close()

    original = main.DB_PATH
    try:
        main.DB_PATH = path
        main.init_db()
    finally:
        main.DB_PATH = original

    conn = sqlite3.connect(path)
    columns = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
    assert "login_handle" in columns, "init_db must rebuild, not leave the old table"
    assert "pw_hash" not in columns
    assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    # And the tables PR A added are actually there to insert into.
    tables = {
        r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    assert {"devices", "key_wraps", "challenges"} <= tables


def test_group_keys_reach_only_their_recipient():
    owner, _, _ = enrolled("gk-owner")
    gid = owner.post("/api/groups", json={"name": "Trip"}).json()["id"]
    me = owner.get("/api/me").json()

    r = owner.post(
        f"/api/groups/{gid}/keys",
        json={
            "keys": [
                {
                    "recipient_kind": "device",
                    "recipient_id": me["device_id"],
                    "ciphertext": "sealed-to-device",
                },
                {
                    "recipient_kind": "account",
                    "recipient_id": str(me["id"]),
                    "ciphertext": "sealed-to-account",
                },
            ]
        },
    )
    assert r.status_code == 200

    got = owner.get(f"/api/groups/{gid}/keys").json()["keys"]
    assert {k["ciphertext"] for k in got} == {"sealed-to-device", "sealed-to-account"}

    # A second member of the same group sees none of them: the rows are
    # addressed to the owner's keys, and handing them over would be pointless
    # anyway (they are sealed) but would leak who holds what.
    other = signed_up_in_group(owner, gid, "gk-other")
    assert other.get(f"/api/groups/{gid}/keys").json()["keys"] == []

    # A non-member cannot even ask.
    stranger, _, _ = enrolled("gk-stranger")
    assert stranger.get(f"/api/groups/{gid}/keys").status_code == 404


def signed_up_in_group(owner, gid, handle):
    code = owner.get(f"/api/groups/{gid}").json()["code"]
    c, _, _ = enrolled(handle)
    c.post("/api/groups/join", json={"code": code})
    return c


def test_you_can_only_store_group_keys_for_yourself():
    owner, _, _ = enrolled("gk-mine")
    gid = owner.post("/api/groups", json={"name": "Flat"}).json()["id"]
    other = signed_up_in_group(owner, gid, "gk-theirs")
    victim = other.get("/api/me").json()

    # Planting a key row aimed at another member is refused, even though we are
    # both in the group.
    r = owner.post(
        f"/api/groups/{gid}/keys",
        json={
            "keys": [
                {
                    "recipient_kind": "device",
                    "recipient_id": victim["device_id"],
                    "ciphertext": "planted",
                }
            ]
        },
    )
    assert r.status_code == 403
    assert other.get(f"/api/groups/{gid}/keys").json()["keys"] == []

    # Nor aimed at another account.
    r = owner.post(
        f"/api/groups/{gid}/keys",
        json={
            "keys": [
                {
                    "recipient_kind": "account",
                    "recipient_id": str(victim["id"]),
                    "ciphertext": "planted",
                }
            ]
        },
    )
    assert r.status_code == 403


def test_group_key_validation_and_access():
    owner, _, _ = enrolled("gk-valid")
    gid = owner.post("/api/groups", json={"name": "V"}).json()["id"]
    me = owner.get("/api/me").json()

    def post(key):
        return owner.post(f"/api/groups/{gid}/keys", json={"keys": [key]}).status_code

    good = {
        "recipient_kind": "device",
        "recipient_id": me["device_id"],
        "ciphertext": "x",
    }
    assert post({**good, "recipient_kind": "nonsense"}) == 400
    assert post({**good, "ciphertext": ""}) == 400

    stranger, _, _ = enrolled("gk-outsider")
    assert (
        stranger.post(f"/api/groups/{gid}/keys", json={"keys": [good]}).status_code
        == 404
    )

    anon = client()
    assert anon.get(f"/api/groups/{gid}/keys").status_code == 401
    assert anon.get("/api/account/box").status_code == 401


def test_the_account_box_key_comes_back_for_re_sealing():
    c, _, _ = enrolled("boxy")
    assert c.get("/api/account/box").json()["account_box_pubkey"].startswith("YWNjdC1")


def test_a_revoked_device_stops_receiving_group_keys():
    owner, _, (own_priv, own_pub) = enrolled("gk-revoke")
    gid = owner.post("/api/groups", json={"name": "R"}).json()["id"]
    me = owner.get("/api/me").json()
    owner.post(
        f"/api/groups/{gid}/keys",
        json={
            "keys": [
                {
                    "recipient_kind": "device",
                    "recipient_id": me["device_id"],
                    "ciphertext": "sealed",
                }
            ]
        },
    )

    second_priv, second_pub = keypair()
    owner.post(
        "/api/devices",
        json={
            "pubkey": second_pub,
            "box_pubkey": "b2",
            "label": "phone",
            "signed_by": "device",
            "signer_pubkey": own_pub,
            "signature": b64(own_priv.sign(second_pub.encode())),
        },
    )
    phone = client()
    sign_in(phone, second_priv, second_pub)
    phone_id = phone.get("/api/me").json()["device_id"]
    phone.post(
        f"/api/groups/{gid}/keys",
        json={
            "keys": [
                {
                    "recipient_kind": "device",
                    "recipient_id": phone_id,
                    "ciphertext": "sealed-to-phone",
                }
            ]
        },
    )
    assert len(owner.get(f"/api/groups/{gid}/keys").json()["keys"]) == 2

    owner.delete(f"/api/devices/{phone_id}")
    remaining = owner.get(f"/api/groups/{gid}/keys").json()["keys"]
    assert [k["ciphertext"] for k in remaining] == ["sealed"]
