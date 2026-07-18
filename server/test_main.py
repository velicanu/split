import os
import tempfile

os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient

from main import app

client = TestClient(app, base_url="https://testserver")


def test_signup_login_flow():
    assert client.get("/api/me").status_code == 401

    r = client.post("/api/signup", json={"username": "alice", "password": "pw"})
    assert r.status_code == 200
    assert client.get("/api/me").json() == {"username": "alice"}

    assert (
        client.post(
            "/api/signup", json={"username": "alice", "password": "x"}
        ).status_code
        == 409
    )

    client.post("/api/logout", json={})
    assert client.get("/api/me").status_code == 401

    assert (
        client.post(
            "/api/login", json={"username": "alice", "password": "wrong"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/login", json={"username": "alice", "password": "pw"}
        ).status_code
        == 200
    )
    assert client.get("/api/me").json() == {"username": "alice"}


def test_signup_requires_fields():
    assert (
        client.post("/api/signup", json={"username": " ", "password": "pw"}).status_code
        == 400
    )
    assert (
        client.post("/api/signup", json={"username": "bob", "password": ""}).status_code
        == 400
    )


def signed_up(username):
    c = TestClient(app, base_url="https://testserver")
    c.post("/api/signup", json={"username": username, "password": "pw"})
    return c


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
    assert feed["events"][0]["payload"]["username"] == "carol"
    assert feed["version"] == feed["events"][-1]["id"]

    # dave is not a member until he joins by code
    assert dave.get(f"/api/groups/{gid}").status_code == 404
    dave.post("/api/groups/join", json={"code": group["code"]})
    feed = events_of(dave, gid)
    assert [e["payload"]["username"] for e in feed["events"]] == ["carol", "dave"]
    ids = {e["payload"]["username"]: e["payload"]["user_id"] for e in feed["events"]}
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


def test_legacy_data_is_backfilled_into_events():
    import main

    # Simulate a group created before the event log existed: members live only
    # in `memberships` and items only in the pre-ledger `expenses` table, with
    # no rows in `events` (exactly the state a PR-1 -> PR-2 migration leaves).
    a = signed_up("legacya")
    signed_up("legacyb")
    with main.db() as conn:
        ida = conn.execute(
            "SELECT id FROM users WHERE username = 'legacya'"
        ).fetchone()["id"]
        idb = conn.execute(
            "SELECT id FROM users WHERE username = 'legacyb'"
        ).fetchone()["id"]
        gid = conn.execute(
            "INSERT INTO groups (name, code, created_by) VALUES ('Legacy', 'legc', ?)",
            (ida,),
        ).lastrowid
        conn.execute("INSERT INTO memberships VALUES (?, ?)", (gid, ida))
        conn.execute("INSERT INTO memberships VALUES (?, ?)", (gid, idb))
        conn.execute(
            "CREATE TABLE IF NOT EXISTS expenses ("
            " id INTEGER PRIMARY KEY, group_id INTEGER, description TEXT,"
            " amount_cents INTEGER, paid_by INTEGER,"
            " created_at TEXT DEFAULT (datetime('now')))"
        )
        conn.execute(
            "INSERT INTO expenses (group_id, description, amount_cents, paid_by)"
            " VALUES (?, 'Dinner', 5000, ?)",
            (gid, ida),
        )
        conn.execute(
            "INSERT INTO expenses (group_id, description, amount_cents, paid_by)"
            " VALUES (?, 'Taxi', 2000, ?)",
            (gid, idb),
        )

    # nothing is visible until the backfill runs
    assert events_of(a, gid)["events"] == []

    main.init_db()  # idempotent startup backfill

    feed = events_of(a, gid)
    types = [e["type"] for e in feed["events"]]
    assert types.count("member.added") == 2
    assert types.count("expense.created") == 2
    descs = sorted(
        e["payload"]["description"]
        for e in feed["events"]
        if e["type"] == "expense.created"
    )
    assert descs == ["Dinner", "Taxi"]

    # running the backfill again must not duplicate anything
    main.init_db()
    assert len(events_of(a, gid)["events"]) == len(feed["events"])

    # and a brand-new member now folds the complete history
    c = signed_up("legacyc")
    c.post("/api/groups/join", json={"code": "legc"})
    ctypes = [e["type"] for e in events_of(c, gid)["events"]]
    assert ctypes.count("expense.created") == 2
    assert ctypes.count("member.added") == 3  # legacya, legacyb, legacyc
