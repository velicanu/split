import base64
import os
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient

from main import DB_PATH, app

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


# Every event type the client writes through the generic endpoint. The guard
# above once matched the whole `member.` prefix, which silently rejected the
# two membership events the ghost feature is built from — so adding a ghost,
# inviting (which mints one), and leaving all 400'd in production while both
# test suites stayed green.
#
# Add to this list when the client learns to write a new event type. It is the
# one place that says what the server has agreed to accept.
CLIENT_WRITTEN_EVENTS = [
    "expense.created",
    "expense.updated",
    "settlement.created",
    "settlement.updated",
    "comment.created",
    "comment.updated",
    "member.ghost_added",
    "member.left",
    "group.revived_from",
]


def test_the_server_accepts_every_event_the_client_writes():
    owner = signed_up("ghost-writer")
    group = owner.post("/api/groups", json={"name": "Flat"}).json()
    gid = group["id"]

    for i, type_ in enumerate(CLIENT_WRITTEN_EVENTS):
        r = owner.post(
            f"/api/groups/{gid}/events",
            json={"event_id": f"e{i}", "type": type_, "payload": {"enc": "sealed"}},
        )
        assert r.status_code == 200, f"{type_} was refused: {r.json()}"

    stored = {e["type"] for e in events_of(owner, gid)["events"]}
    assert stored >= set(CLIENT_WRITTEN_EVENTS)


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


def seal(text):
    """Stand-in for a sealed blob. The server never opens these, so a real
    seal would prove nothing here — what matters is that it stores and
    relays exactly what it was given."""
    return f"sealed:{text}"


def put_key(client, provider, ciphertext, me=None):
    me = me or client.get("/api/me").json()
    return client.post(
        f"/api/ai/providers/{provider}/keys",
        json={
            "keys": [
                {
                    "recipient_kind": "device",
                    "recipient_id": me["device_id"],
                    "ciphertext": ciphertext,
                },
                {
                    "recipient_kind": "account",
                    "recipient_id": str(me["id"]),
                    "ciphertext": seal("account-copy"),
                },
            ]
        },
    )


def test_the_server_never_holds_a_readable_api_key():
    """The whole point of this change: a live billable credential must be as
    opaque to the server as an expense is."""
    import sqlite3

    u = signed_up("ai-opaque")
    assert put_key(u, "openai", seal("sk-secret-value")).status_code == 200

    conn = sqlite3.connect(DB_PATH)
    columns = {r[1] for r in conn.execute("PRAGMA table_info(ai_providers)")}
    assert "api_key" not in columns, "no plaintext column may survive"

    # The server stores precisely the bytes it was handed and never decodes
    # them. That it is *unreadable* depends on the client sealing properly,
    # which real crypto proves in aikeys.test.js — a stand-in seal here could
    # only ever prove that a string round-trips.
    stored = [
        r[0]
        for r in conn.execute(
            "SELECT ciphertext FROM ai_keys WHERE recipient_kind = 'device'"
        )
    ]
    assert stored == [seal("sk-secret-value")]


def test_ai_settings_returns_only_this_devices_copy():
    u = signed_up("ai-mine")
    me = u.get("/api/me").json()
    put_key(u, "openai", seal("for-my-device"), me)

    s = u.get("/api/ai/settings").json()
    assert s["active"] == "openai"
    assert s["providers"]["openai"]["sealed_key"] == seal("for-my-device")
    assert s["providers"]["openai"]["model"] == "gpt-5.4-nano"
    # The plaintext key is not a field the API even has any more.
    assert "api_key" not in s["providers"]["openai"]


def test_a_device_with_no_sealed_copy_is_told_so_rather_than_shown_nothing():
    owner, (_, _), (own_priv, own_pub) = __import__("test_auth").enrolled("ai-2dev")
    from test_auth import b64, keypair, sign_in

    me = owner.get("/api/me").json()
    put_key(owner, "openai", seal("first-device-copy"), me)

    # A second device enrolled after the key was saved.
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
    phone = TestClient(app, base_url="https://testserver")
    sign_in(phone, second_priv, second_pub)

    s = phone.get("/api/ai/settings").json()
    # The provider is known, but this device holds no copy it can open.
    assert s["providers"]["openai"]["sealed_key"] is None
    assert s["providers"]["openai"]["model"] == "gpt-5.4-nano"

    # Every copy is still fetchable for the enrolment path, including the
    # account one the new device can actually open.
    keys = phone.get("/api/ai/providers/openai/keys").json()["keys"]
    assert {k["recipient_kind"] for k in keys} == {"device", "account"}


def test_you_can_only_seal_an_api_key_to_yourself():
    victim = signed_up("ai-victim")
    victim_me = victim.get("/api/me").json()
    attacker = signed_up("ai-attacker")

    for kind, rid in (
        ("device", victim_me["device_id"]),
        ("account", str(victim_me["id"])),
    ):
        r = attacker.post(
            "/api/ai/providers/openai/keys",
            json={
                "keys": [
                    {
                        "recipient_kind": kind,
                        "recipient_id": rid,
                        "ciphertext": seal("planted"),
                    }
                ]
            },
        )
        assert r.status_code == 403, kind
    assert victim.get("/api/ai/settings").json() == {"active": None, "providers": {}}


def test_ai_key_endpoints_need_auth_and_a_real_provider():
    u = signed_up("ai-guard")
    assert put_key(u, "bogus", seal("x")).status_code == 404
    assert (
        u.post(
            "/api/ai/providers/openai/keys",
            json={
                "keys": [
                    {
                        "recipient_kind": "nonsense",
                        "recipient_id": "1",
                        "ciphertext": "x",
                    }
                ]
            },
        ).status_code
        == 400
    )
    anon = TestClient(app, base_url="https://testserver")
    assert anon.get("/api/ai/providers/openai/keys").status_code == 401
    assert (
        anon.post("/api/ai/providers/openai/keys", json={"keys": []}).status_code == 401
    )


def test_removing_a_provider_removes_every_sealed_copy():
    u = signed_up("ai-remove")
    put_key(u, "openai", seal("gone-soon"))
    assert u.get("/api/ai/providers/openai/keys").json()["keys"]

    assert u.delete("/api/ai/providers/openai").status_code == 200
    # Otherwise the key stays readable on the devices it was sealed to.
    assert u.get("/api/ai/providers/openai/keys").json()["keys"] == []
    assert u.get("/api/ai/settings").json() == {"active": None, "providers": {}}


def test_ai_provider_settings():
    u = signed_up("aiuser")

    # No keys -> no provider at all, so the feature is unavailable
    s = u.get("/api/ai/settings").json()
    assert s == {"active": None, "providers": {}}

    # Adding a key makes that provider active, defaulting to the cheapest model
    assert put_key(u, "anthropic", seal("sk-ant-1")).status_code == 200
    s = u.get("/api/ai/settings").json()
    assert s["active"] == "anthropic"
    assert s["providers"]["anthropic"] == {
        "sealed_key": seal("sk-ant-1"),
        "model": "claude-haiku-4-5",
    }

    # Adding a second key makes the newly added provider active
    put_key(u, "openai", seal("sk-oai-1"))
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
    put_key(u, "openai", seal("sk-oai-2"))
    s = u.get("/api/ai/settings").json()
    assert s["providers"]["openai"] == {
        "sealed_key": seal("sk-oai-2"),
        "model": "gpt-5.4-mini",
    }
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
    assert u.put("/api/ai/providers/bogus", json={"model": "x"}).status_code == 404
    assert u.post("/api/ai/active", json={"provider": "bogus"}).status_code == 404
    # selecting or setting a model for a provider with no key
    assert u.post("/api/ai/active", json={"provider": "openai"}).status_code == 404
    assert (
        u.put("/api/ai/providers/openai", json={"model": "gpt-5.4-mini"}).status_code
        == 404
    )
    assert u.put("/api/ai/providers/openai", json={}).status_code == 400
    assert u.put("/api/ai/providers/openai", json={"model": "  "}).status_code == 400
    # A plaintext key is not silently accepted — the field no longer exists,
    # so this is just a model-less request.
    assert (
        u.put("/api/ai/providers/openai", json={"api_key": "sk-x"}).status_code == 400
    )

    # keys are scoped per user
    other = signed_up("aiuser3")
    put_key(u, "anthropic", seal("mine"))
    assert other.get("/api/ai/settings").json()["providers"] == {}


def ghost(client, gid, member_id, at_event_id):
    return client.post(
        f"/api/groups/{gid}/ghost",
        json={"member_id": member_id, "at_event_id": at_event_id},
    )


def test_a_ghosted_member_keeps_the_group_frozen_at_that_point():
    """The cut is a position in the log, not a moment in time — so it does not
    matter whether they sync a second later or a year later."""
    owner = signed_up("ghost-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    other = signed_up("ghost-other")
    other.post("/api/groups/join", json={"code": group["code"]})
    other_id = other.get("/api/me").json()["id"]

    owner.post(
        f"/api/groups/{gid}/events",
        json={"event_id": "before", "type": "expense.created", "payload": {"enc": "a"}},
    )
    cut = events_of(owner, gid)["version"]

    assert ghost(owner, gid, other_id, cut).json() == {"ok": True, "deleted": False}

    owner.post(
        f"/api/groups/{gid}/events",
        json={"event_id": "after", "type": "expense.created", "payload": {"enc": "b"}},
    )

    # The group carries on for the owner...
    assert events_of(owner, gid)["version"] > cut
    assert {e["event_id"] for e in events_of(owner, gid)["events"]} >= {
        "before",
        "after",
    }

    # ...and is frozen for the ghosted member, however long they wait.
    frozen = events_of(other, gid)
    assert frozen["version"] == cut
    ids = {e["event_id"] for e in frozen["events"]}
    assert "before" in ids
    assert "after" not in ids, "nothing after the cut, ever"
    assert events_of(other, gid)["version"] == cut, "and it stays that way"


def test_a_ghosted_member_can_read_but_not_write():
    owner = signed_up("gw-owner")
    group = owner.post("/api/groups", json={"name": "W"}).json()
    gid = group["id"]
    other = signed_up("gw-other")
    other.post("/api/groups/join", json={"code": group["code"]})
    other_id = other.get("/api/me").json()["id"]
    ghost(owner, gid, other_id, events_of(owner, gid)["version"])

    # Reading their frozen copy still works.
    assert other.get(f"/api/groups/{gid}/events").status_code == 200
    assert other.get(f"/api/groups/{gid}").status_code == 200

    # Writing does not: a one-way conversation into a ledger they have left.
    assert (
        other.post(
            f"/api/groups/{gid}/events",
            json={"event_id": "x", "type": "expense.created", "payload": {"enc": "c"}},
        ).status_code
        == 403
    )
    ciphertext, rid = sealed(b"after leaving")
    assert (
        other.post(
            f"/api/groups/{gid}/receipts",
            json={"receipt_id": rid, "ciphertext": ciphertext},
        ).status_code
        == 403
    )


def test_ghosting_the_last_member_deletes_the_group():
    import sqlite3

    owner = signed_up("last-one")
    group = owner.post("/api/groups", json={"name": "Solo"}).json()
    gid = group["id"]
    owner.post(
        f"/api/groups/{gid}/events",
        json={"event_id": "solo-1", "type": "expense.created", "payload": {"enc": "a"}},
    )
    ciphertext, rid = sealed(b"solo receipt")
    owner.post(
        f"/api/groups/{gid}/receipts",
        json={"receipt_id": rid, "ciphertext": ciphertext},
    )

    res = ghost(owner, gid, owner.get("/api/me").json()["id"], 999)
    assert res.json() == {"ok": True, "deleted": True}

    # Truly gone, not merely hidden.
    conn = sqlite3.connect(DB_PATH)
    for table in ("events", "receipts", "group_keys", "memberships"):
        left = conn.execute(
            f"SELECT COUNT(*) FROM {table} WHERE group_id = ?", (gid,)
        ).fetchone()[0]
        assert left == 0, table
    assert (
        conn.execute("SELECT COUNT(*) FROM groups WHERE id = ?", (gid,)).fetchone()[0]
        == 0
    )
    assert owner.get(f"/api/groups/{gid}").status_code == 404


def test_ghosting_needs_membership_and_is_not_undone_by_repeating_it():
    owner = signed_up("gm-owner")
    group = owner.post("/api/groups", json={"name": "M"}).json()
    gid = group["id"]
    other = signed_up("gm-other")
    other.post("/api/groups/join", json={"code": group["code"]})
    other_id = other.get("/api/me").json()["id"]

    stranger = signed_up("gm-stranger")
    assert ghost(stranger, gid, other_id, 1).status_code == 404

    cut = events_of(owner, gid)["version"]
    ghost(owner, gid, other_id, cut)
    owner.post(
        f"/api/groups/{gid}/events",
        json={"event_id": "later", "type": "expense.created", "payload": {"enc": "z"}},
    )
    # Ghosting again must not move the cut forward and hand them more.
    ghost(owner, gid, other_id, events_of(owner, gid)["version"])
    assert events_of(other, gid)["version"] == cut


def test_a_join_can_claim_a_member_and_the_claim_is_in_the_clear():
    """The claim rides on member.added, which is the one event the server
    writes. That is what lets it be enforced rather than merely agreed —
    everything else in a group is sealed and the server cannot read it."""
    owner = signed_up("cl-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]

    joiner = signed_up("cl-joiner")
    res = joiner.post("/api/groups/join", json={"code": group["code"], "claims": -100})
    assert res.status_code == 200

    joined = [
        e for e in events_of(owner, gid)["events"] if e["type"] == "member.added"
    ][-1]
    assert joined["payload"]["claims"] == -100
    assert joined["payload"]["user_id"] == joiner.get("/api/me").json()["id"]


def test_an_ordinary_join_claims_nothing():
    owner = signed_up("nc-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    joiner = signed_up("nc-joiner")
    joiner.post("/api/groups/join", json={"code": group["code"]})

    added = [
        e
        for e in events_of(owner, group["id"])["events"]
        if e["type"] == "member.added"
    ]
    assert all("claims" not in e["payload"] for e in added)


def test_a_member_can_only_be_claimed_once():
    """An invite link names who to become. Used twice, the second person would
    otherwise displace the first, who would be left with no history and no
    sign of what happened."""
    owner = signed_up("once-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]

    first = signed_up("once-first")
    assert (
        first.post(
            "/api/groups/join", json={"code": group["code"], "claims": -100}
        ).status_code
        == 200
    )

    second = signed_up("once-second")
    res = second.post("/api/groups/join", json={"code": group["code"], "claims": -100})
    assert res.status_code == 409

    # And the refusal is total: they did not quietly join without the claim.
    added = [e for e in events_of(owner, gid)["events"] if e["type"] == "member.added"]
    assert len(added) == 2, "only the owner and the first claimant"


def test_claiming_a_different_member_is_still_allowed():
    """Claiming-once is per member id, not per group — otherwise one recovery
    would block every later one."""
    owner = signed_up("many-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()

    for i, name in enumerate(["many-a", "many-b"]):
        joiner = signed_up(name)
        res = joiner.post(
            "/api/groups/join", json={"code": group["code"], "claims": -100 - i}
        )
        assert res.status_code == 200


def test_you_cannot_claim_yourself():
    owner = signed_up("self-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    joiner = signed_up("self-joiner")
    mine = joiner.get("/api/me").json()["id"]

    res = joiner.post("/api/groups/join", json={"code": group["code"], "claims": mine})
    assert res.status_code == 400


def test_hiding_a_group_removes_it_from_the_list_but_keeps_the_membership():
    """What revive does to the group it leaves behind. The row stays, so the
    frozen prefix and any receipts remain reachable — the decision about what
    receipts should do is still open. See plan/12."""
    owner = signed_up("hide-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    other = signed_up("hide-other")
    other.post("/api/groups/join", json={"code": group["code"]})

    assert gid in [g["id"] for g in other.get("/api/groups").json()]

    assert other.post(f"/api/groups/{gid}/hide").json()["hidden"] is True
    assert gid not in [g["id"] for g in other.get("/api/groups").json()]

    # Still a member: the log is still served.
    assert other.get(f"/api/groups/{gid}/events?since=0").status_code == 200
    # And only for them — hiding is per person.
    assert gid in [g["id"] for g in owner.get("/api/groups").json()]


def test_hiding_is_reversible():
    owner = signed_up("unhide-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    owner.post(f"/api/groups/{gid}/hide")
    assert gid not in [g["id"] for g in owner.get("/api/groups").json()]

    owner.post(f"/api/groups/{gid}/hide?hidden=false")
    assert gid in [g["id"] for g in owner.get("/api/groups").json()]


def test_hiding_needs_membership():
    owner = signed_up("hm-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    stranger = signed_up("hm-stranger")
    assert stranger.post(f"/api/groups/{group['id']}/hide").status_code == 404


def _anon():
    """A client with no session — a stranger with only a share link."""
    from fastapi.testclient import TestClient
    from main import app

    return TestClient(app, base_url="https://testserver")


def _enable_read_sharing(owner, gid, rotate=False):
    return owner.post(
        f"/api/groups/{gid}/read-sharing", json={"enabled": True, "rotate": rotate}
    ).json()["read_token"]


def test_read_token_lets_a_stranger_read_but_gives_no_account():
    """The point of the feature: someone with the share link, no account, can
    fetch the encrypted feed and the group name — and nothing else."""
    owner = signed_up("rt-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    owner.post(
        f"/api/groups/{gid}/events",
        json={
            "event_id": "rt-read-e1",
            "type": "expense.created",
            "payload": {"enc": "x"},
        },
    )
    token = _enable_read_sharing(owner, gid)
    assert token

    anon = _anon()
    h = {"X-Read-Token": token}
    feed = anon.get(f"/api/groups/{gid}/events", headers=h)
    assert feed.status_code == 200
    types = [e["type"] for e in feed.json()["events"]]
    assert "member.added" in types and "expense.created" in types

    meta = anon.get(f"/api/groups/{gid}", headers=h).json()
    assert meta["name"] == "Trip"
    assert meta.get("read_only") is True
    # The join code is the write capability; it is never handed to a reader.
    assert "code" not in meta


def test_no_token_and_no_session_cannot_read():
    owner = signed_up("rt-closed")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    # Sharing not enabled, and no session: 401 (not logged in).
    assert _anon().get(f"/api/groups/{gid}/events").status_code == 401


def test_a_wrong_or_revoked_token_is_refused():
    owner = signed_up("rt-revoke")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    token = _enable_read_sharing(owner, gid)
    anon = _anon()

    assert (
        anon.get(
            f"/api/groups/{gid}/events", headers={"X-Read-Token": "nope"}
        ).status_code
        == 403
    )

    # Disabling revokes the live link.
    owner.post(f"/api/groups/{gid}/read-sharing", json={"enabled": False})
    assert (
        anon.get(
            f"/api/groups/{gid}/events", headers={"X-Read-Token": token}
        ).status_code
        == 403
    )


def test_rotating_mints_a_new_token_and_kills_the_old():
    owner = signed_up("rt-rotate")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    old = _enable_read_sharing(owner, gid)
    new = _enable_read_sharing(owner, gid, rotate=True)
    assert new and new != old

    anon = _anon()
    assert (
        anon.get(f"/api/groups/{gid}/events", headers={"X-Read-Token": old}).status_code
        == 403
    )
    assert (
        anon.get(f"/api/groups/{gid}/events", headers={"X-Read-Token": new}).status_code
        == 200
    )


def test_a_reader_cannot_write_or_manage_sharing():
    owner = signed_up("rt-ro")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    token = _enable_read_sharing(owner, gid)
    anon = _anon()
    h = {"X-Read-Token": token}

    # No session, so writing and managing both fail on auth — the token only reads.
    assert (
        anon.post(
            f"/api/groups/{gid}/events",
            headers=h,
            json={
                "event_id": "rt-ro-z",
                "type": "expense.created",
                "payload": {"enc": "x"},
            },
        ).status_code
        == 401
    )
    assert anon.get(f"/api/groups/{gid}/read-sharing", headers=h).status_code == 401
    assert (
        anon.post(
            f"/api/groups/{gid}/read-sharing", headers=h, json={"enabled": False}
        ).status_code
        == 401
    )


def test_only_a_writable_member_manages_sharing():
    owner = signed_up("rts-owner")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    stranger = signed_up("rts-stranger")
    assert (
        stranger.post(
            f"/api/groups/{gid}/read-sharing", json={"enabled": True}
        ).status_code
        == 404
    )


def test_members_still_read_without_a_token():
    # Regression: adding the token path must not disturb the member path.
    owner = signed_up("rt-member")
    group = owner.post("/api/groups", json={"name": "Trip"}).json()
    gid = group["id"]
    assert owner.get(f"/api/groups/{gid}/events").status_code == 200
    assert owner.get(f"/api/groups/{gid}").json()["code"] == group["code"]
