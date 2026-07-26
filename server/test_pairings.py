"""Device pairing rendezvous. See plan/17. The security (the fingerprint) is a
client concern; here we cover the server's job: carry the new device's public
keys, gate approval on a real enrolment, and expire."""

from test_auth import b64, client, enrolled, keypair, sign_in


def register(new_pub, box="cGstYm94"):
    """A fresh device (no session) advertises its public keys."""
    r = client().post(
        "/api/pairings",
        json={"new_pubkey": new_pub, "new_box_pubkey": box, "label": "the new phone"},
    )
    assert r.status_code == 200, r.text
    return r.json()["code"]


def enrol_from(old, old_priv, old_pub, new_pub, box="cGstYm94"):
    """The old device signs the new device's key — the security-bearing step."""
    return old.post(
        "/api/devices",
        json={
            "pubkey": new_pub,
            "box_pubkey": box,
            "label": "the new phone",
            "signed_by": "device",
            "signer_pubkey": old_pub,
            "signature": b64(old_priv.sign(new_pub.encode())),
        },
    )


def test_pairing_round_trip():
    old, _, (old_priv, old_pub) = enrolled("pair-old")
    new_priv, new_pub = keypair()

    code = register(new_pub)
    # Anyone with the code sees the pending public keys and that it's unapproved.
    got = client().get(f"/api/pairings/{code}").json()
    assert got["new_pubkey"] == new_pub
    assert got["approved"] is False

    # The old device enrols the new one, then approves.
    assert enrol_from(old, old_priv, old_pub, new_pub).status_code == 200
    assert old.post(f"/api/pairings/{code}/approve").status_code == 200
    assert client().get(f"/api/pairings/{code}").json()["approved"] is True

    # And the new device can now sign in with its own key.
    assert sign_in(client(), new_priv, new_pub).status_code == 200


def test_approve_needs_the_device_actually_enrolled():
    old, _, _ = enrolled("pair-noenrol")
    _, new_pub = keypair()
    code = register(new_pub)
    # Approving without the signed add_device first is refused, so the flag can't
    # run ahead of the real enrolment.
    r = old.post(f"/api/pairings/{code}/approve")
    assert r.status_code == 400
    assert client().get(f"/api/pairings/{code}").json()["approved"] is False


def test_approve_needs_a_session():
    enrolled("pair-anon")
    _, new_pub = keypair()
    code = register(new_pub)
    assert client().post(f"/api/pairings/{code}/approve").status_code == 401


def test_a_stranger_cannot_approve_into_their_own_account():
    # The device is enrolled under `old`; a different account approving the same
    # code has no such device, so it is refused.
    old, _, (old_priv, old_pub) = enrolled("pair-owner")
    stranger, _, _ = enrolled("pair-stranger")
    _, new_pub = keypair()
    code = register(new_pub)
    enrol_from(old, old_priv, old_pub, new_pub)
    assert stranger.post(f"/api/pairings/{code}/approve").status_code == 400


def test_unknown_and_expired_codes():
    enrolled("pair-gc")
    assert client().get("/api/pairings/nope").status_code == 404

    # Expired rows are swept: force one past its TTL and confirm it's gone.
    import time

    import db as dbmod

    _, new_pub = keypair()
    code = register(new_pub)
    with dbmod.db() as conn:
        conn.execute(
            "UPDATE pairings SET expires_at = ? WHERE code = ?",
            (time.time() - 1, code),
        )
    assert client().get(f"/api/pairings/{code}").status_code == 404
