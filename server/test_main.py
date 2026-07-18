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


def test_group_expense_flow():
    carol = signed_up("carol")
    dave = signed_up("dave")

    group = carol.post("/api/groups", json={"name": "Trip"}).json()
    assert group["name"] == "Trip" and group["code"]

    # creator sees the group; dave is not a member yet
    assert any(g["id"] == group["id"] for g in carol.get("/api/groups").json())
    assert dave.get(f"/api/groups/{group['id']}").status_code == 404

    # dave joins by code and now sees it
    assert (
        dave.post("/api/groups/join", json={"code": group["code"]}).status_code == 200
    )
    assert any(g["id"] == group["id"] for g in dave.get("/api/groups").json())

    # carol pays for dinner, split between the two members
    assert (
        carol.post(
            f"/api/groups/{group['id']}/expenses",
            json={"description": "Dinner", "amount_cents": 5000},
        ).status_code
        == 200
    )

    detail = dave.get(f"/api/groups/{group['id']}").json()
    assert [e["description"] for e in detail["expenses"]] == ["Dinner"]
    assert detail["expenses"][0]["paid_by_name"] == "carol"
    net = {b["username"]: b["net_cents"] for b in detail["balances"]}
    assert net == {"carol": 2500, "dave": -2500}


def test_group_access_control():
    owner = signed_up("frank")
    group = owner.post("/api/groups", json={"name": "Flat"}).json()

    # bad invite code
    assert owner.post("/api/groups/join", json={"code": "nope"}).status_code == 404

    # non-member cannot read or write the group
    stranger = signed_up("grace")
    assert stranger.get(f"/api/groups/{group['id']}").status_code == 404
    assert (
        stranger.post(
            f"/api/groups/{group['id']}/expenses",
            json={"description": "x", "amount_cents": 100},
        ).status_code
        == 404
    )

    # validation
    assert owner.post("/api/groups", json={"name": "  "}).status_code == 400
    assert (
        owner.post(
            f"/api/groups/{group['id']}/expenses",
            json={"description": "x", "amount_cents": 0},
        ).status_code
        == 400
    )


def test_requires_auth():
    anon = TestClient(app, base_url="https://testserver")
    assert anon.get("/api/groups").status_code == 401
    assert anon.post("/api/groups", json={"name": "x"}).status_code == 401
