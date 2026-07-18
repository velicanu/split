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
