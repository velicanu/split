import base64
import os
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient

from main import app

client = TestClient(app, base_url="https://testserver")


def signed_up(username):
    """A user with one enrolled device, signed in. Auth itself is covered in
    test_auth.py; here it is only a way to get an authenticated client."""
    from test_auth import enrolled

    return enrolled(username)[0]


def test_split_equally_distributes_remainder():
    from main import split_equally

    # 1000 / 3 -> 334, 333, 333; remainder cent goes to the lowest id
    assert split_equally(1000, [3, 1, 2]) == {1: 334, 2: 333, 3: 333}
    assert sum(split_equally(1000, [3, 1, 2]).values()) == 1000


def events_of(client, group_id, since=0):
    return client.get(f"/api/groups/{group_id}/events?since={since}").json()


def test_group_ledger_flow():
    carol = signed_up("carol")
    dave = signed_up("dave")

    group = carol.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]

    # creating a group logs a member.added event; meta is readable
    assert carol.get(f"/api/groups/{gid}").json()["name"] == "Trip"
    feed = events_of(carol, gid)
    assert [e["type"] for e in feed["events"]] == ["member.added"]
    assert feed["events"][0]["payload"]["display_name"] == "carol"
    assert feed["version"] == feed["events"][-1]["id"]

    # dave is not a member until he joins by code
    assert dave.get(f"/api/groups/{gid}").status_code == 404
    dave.post("/api/groups/join", json={"code": group["code"]})
    feed = events_of(dave, gid)
    assert [e["payload"]["display_name"] for e in feed["events"]] == [
        "carol",
        "dave",
    ]
    ids = {
        e["payload"]["display_name"]: e["payload"]["user_id"] for e in feed["events"]
    }
    before = feed["version"]

    # carol appends an expense.created event she paid for
    r = carol.post(
        f"/api/groups/{gid}/events",
        json={
            "event_id": "evt-1",
            "type": "expense.created",
            "payload": {
                "description": "Dinner",
                "amount_cents": 5000,
                "paid_by": ids["carol"],
            },
        },
    )
    assert r.status_code == 200

    # dave pulls only what's new (since the version he already had)
    delta = events_of(dave, gid, before)
    assert [e["type"] for e in delta["events"]] == ["expense.created"]
    assert delta["events"][0]["payload"]["amount_cents"] == 5000
    assert delta["version"] > before

    # re-pushing the same event_id is an idempotent no-op
    dup = carol.post(
        f"/api/groups/{gid}/events",
        json={"event_id": "evt-1", "type": "expense.created", "payload": {}},
    ).json()
    assert dup["duplicate"] is True
    assert len(events_of(carol, gid, before)["events"]) == 1


def test_membership_not_forgeable_via_event_log():
    owner = signed_up("heidi")
    group = owner.post("/api/groups", json={"name": "Flat"}).json()
    r = owner.post(
        f"/api/groups/{group['id']}/events",
        json={"event_id": "x", "type": "member.added", "payload": {}},
    )
    assert r.status_code == 400


def test_group_access_control():
    owner = signed_up("frank")
    group = owner.post("/api/groups", json={"name": "Flat2"}).json()
    gid = group["id"]

    # bad invite code
    assert owner.post("/api/groups/join", json={"code": "nope"}).status_code == 404

    # non-member cannot read meta, pull events, or append events
    stranger = signed_up("grace")
    assert stranger.get(f"/api/groups/{gid}").status_code == 404
    assert stranger.get(f"/api/groups/{gid}/events").status_code == 404
    assert (
        stranger.post(
            f"/api/groups/{gid}/events",
            json={"event_id": "e", "type": "expense.created", "payload": {}},
        ).status_code
        == 404
    )

    # validation
    assert owner.post("/api/groups", json={"name": "  "}).status_code == 400
    assert (
        owner.post(
            f"/api/groups/{gid}/events", json={"event_id": "", "type": ""}
        ).status_code
        == 400
    )


def test_requires_auth():
    anon = TestClient(app, base_url="https://testserver")
    assert anon.get("/api/groups").status_code == 401
    assert anon.post("/api/groups", json={"name": "x"}).status_code == 401
    assert anon.get("/api/ai/settings").status_code == 401


def sealed(payload=b"pretend ciphertext"):
    """A blob and the id it must be stored under."""
    import hashlib

    return base64.b64encode(payload).decode(), hashlib.blake2b(
        payload, digest_size=32
    ).hexdigest()


def test_receipt_upload_and_fetch():
    owner = signed_up("rcpt-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    ciphertext, rid = sealed()

    r = owner.post(
        f"/api/groups/{gid}/receipts",
        json={"receipt_id": rid, "ciphertext": ciphertext},
    )
    assert r.status_code == 200
    assert r.json()["receipt_id"] == rid

    got = owner.get(f"/api/groups/{gid}/receipts/{rid}")
    assert got.status_code == 200
    # Opaque bytes: the server has no idea this is an image, and must not
    # invite a browser to guess either.
    assert got.headers["content-type"] == "application/octet-stream"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert got.content == base64.b64decode(ciphertext)

    # every member of the group can fetch it
    other = signed_up("rcpt-member")
    other.post("/api/groups/join", json={"code": group["code"]})
    assert other.get(f"/api/groups/{gid}/receipts/{rid}").status_code == 200


def test_a_receipt_id_must_be_the_hash_of_its_content():
    """Content addressing is only worth anything if the server checks it —
    otherwise an id says nothing about what you will get back."""
    u = signed_up("rcpt-hash")
    gid = u.post("/api/groups", json={"name": "H"}).json()["id"]
    ciphertext, rid = sealed()

    wrong = u.post(
        f"/api/groups/{gid}/receipts",
        json={"receipt_id": "0" * 64, "ciphertext": ciphertext},
    )
    assert wrong.status_code == 400
    assert u.get(f"/api/groups/{gid}/receipts/" + "0" * 64).status_code == 404

    # And the id cannot be borrowed for different content.
    other_ciphertext, _ = sealed(b"different bytes entirely")
    assert (
        u.post(
            f"/api/groups/{gid}/receipts",
            json={"receipt_id": rid, "ciphertext": other_ciphertext},
        ).status_code
        == 400
    )


def test_uploading_the_same_receipt_twice_is_a_no_op():
    u = signed_up("rcpt-dup")
    gid = u.post("/api/groups", json={"name": "D"}).json()["id"]
    ciphertext, rid = sealed()
    body = {"receipt_id": rid, "ciphertext": ciphertext}

    assert u.post(f"/api/groups/{gid}/receipts", json=body).status_code == 200
    assert u.post(f"/api/groups/{gid}/receipts", json=body).status_code == 200
    assert u.get(f"/api/groups/{gid}/receipts/{rid}").content == base64.b64decode(
        ciphertext
    )


def test_two_groups_can_hold_identical_bytes_independently():
    """An id says what a blob *is*, not who may read it. Keyed on content
    alone, the second group's upload would collapse into the first group's row
    and its members would be locked out of their own receipt."""
    ciphertext, rid = sealed(b"byte-for-byte identical")

    a = signed_up("rcpt-group-a")
    gid_a = a.post("/api/groups", json={"name": "A"}).json()["id"]
    b = signed_up("rcpt-group-b")
    gid_b = b.post("/api/groups", json={"name": "B"}).json()["id"]

    body = {"receipt_id": rid, "ciphertext": ciphertext}
    assert a.post(f"/api/groups/{gid_a}/receipts", json=body).status_code == 200
    assert b.post(f"/api/groups/{gid_b}/receipts", json=body).status_code == 200

    assert a.get(f"/api/groups/{gid_a}/receipts/{rid}").status_code == 200
    assert b.get(f"/api/groups/{gid_b}/receipts/{rid}").status_code == 200
    # And neither can reach into the other's group by knowing the address.
    assert a.get(f"/api/groups/{gid_b}/receipts/{rid}").status_code == 404
    assert b.get(f"/api/groups/{gid_a}/receipts/{rid}").status_code == 404


def test_receipts_are_private_to_the_group():
    owner = signed_up("rcpt-private")
    gid = owner.post("/api/groups", json={"name": "Flat"}).json()["id"]
    ciphertext, rid = sealed()
    owner.post(
        f"/api/groups/{gid}/receipts",
        json={"receipt_id": rid, "ciphertext": ciphertext},
    )

    stranger = signed_up("rcpt-stranger")
    assert stranger.get(f"/api/groups/{gid}/receipts/{rid}").status_code == 404
    assert (
        stranger.post(
            f"/api/groups/{gid}/receipts",
            json={"receipt_id": rid, "ciphertext": ciphertext},
        ).status_code
        == 404
    )

    anon = TestClient(app, base_url="https://testserver")
    assert anon.get(f"/api/groups/{gid}/receipts/{rid}").status_code == 401
    assert (
        anon.post(
            f"/api/groups/{gid}/receipts",
            json={"receipt_id": rid, "ciphertext": ciphertext},
        ).status_code
        == 401
    )


def test_receipt_upload_validation():
    u = signed_up("rcpt-validate")
    gid = u.post("/api/groups", json={"name": "V"}).json()["id"]

    def post(receipt_id, ciphertext):
        return u.post(
            f"/api/groups/{gid}/receipts",
            json={"receipt_id": receipt_id, "ciphertext": ciphertext},
        ).status_code

    assert post("x", "not valid base64!!") == 400
    assert post("x", "") == 400

    import hashlib

    oversized = b"x" * (8 * 1024 * 1024 + 1)
    assert (
        post(
            hashlib.blake2b(oversized, digest_size=32).hexdigest(),
            base64.b64encode(oversized).decode(),
        )
        == 413
    )

    assert u.get(f"/api/groups/{gid}/receipts/nope").status_code == 404


def test_ai_provider_settings():
    u = signed_up("aiuser")

    # No keys -> no provider at all, so the feature is unavailable
    s = u.get("/api/ai/settings").json()
    assert s == {"active": None, "providers": {}}

    # Adding a key makes that provider active, defaulting to the cheapest model
    assert (
        u.put("/api/ai/providers/anthropic", json={"api_key": "sk-ant-1"}).status_code
        == 200
    )
    s = u.get("/api/ai/settings").json()
    assert s["active"] == "anthropic"
    assert s["providers"]["anthropic"] == {
        "api_key": "sk-ant-1",
        "model": "claude-haiku-4-5",
    }

    # Adding a second key makes the newly added provider active
    u.put("/api/ai/providers/openai", json={"api_key": "sk-oai-1"})
    s = u.get("/api/ai/settings").json()
    assert s["active"] == "openai"
    assert s["providers"]["openai"]["model"] == "gpt-5.4-nano"
    assert set(s["providers"]) == {"anthropic", "openai"}

    # An explicit switch persists
    assert u.post("/api/ai/active", json={"provider": "anthropic"}).status_code == 200
    assert u.get("/api/ai/settings").json()["active"] == "anthropic"

    # Model choice persists per provider and doesn't change the active provider
    u.put("/api/ai/providers/openai", json={"model": "gpt-5.4-mini"})
    s = u.get("/api/ai/settings").json()
    assert s["providers"]["openai"]["model"] == "gpt-5.4-mini"
    assert s["active"] == "anthropic"

    # Replacing a key keeps the chosen model but re-activates that provider
    u.put("/api/ai/providers/openai", json={"api_key": "sk-oai-2"})
    s = u.get("/api/ai/settings").json()
    assert s["providers"]["openai"] == {"api_key": "sk-oai-2", "model": "gpt-5.4-mini"}
    assert s["active"] == "openai"

    # Deleting the active provider hands active to the remaining key
    assert u.delete("/api/ai/providers/openai").status_code == 200
    s = u.get("/api/ai/settings").json()
    assert s["active"] == "anthropic"
    assert set(s["providers"]) == {"anthropic"}

    # Deleting the last key leaves no provider
    u.delete("/api/ai/providers/anthropic")
    assert u.get("/api/ai/settings").json() == {"active": None, "providers": {}}


def test_ai_provider_validation():
    u = signed_up("aiuser2")
    assert u.put("/api/ai/providers/bogus", json={"api_key": "x"}).status_code == 404
    assert u.post("/api/ai/active", json={"provider": "bogus"}).status_code == 404
    # selecting or setting a model for a provider with no key
    assert u.post("/api/ai/active", json={"provider": "openai"}).status_code == 404
    assert (
        u.put("/api/ai/providers/openai", json={"model": "gpt-5.4-mini"}).status_code
        == 404
    )
    assert u.put("/api/ai/providers/openai", json={}).status_code == 400
    assert u.put("/api/ai/providers/openai", json={"api_key": "  "}).status_code == 400

    # keys are scoped per user
    other = signed_up("aiuser3")
    u.put("/api/ai/providers/anthropic", json={"api_key": "mine"})
    assert other.get("/api/ai/settings").json()["providers"] == {}
