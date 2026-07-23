import pathlib
import pytest_asyncio
import aiosqlite
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import search as search_router
import app.database as db_module

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await db.executescript(mig.read_text())


@pytest_asyncio.fixture
async def test_app(tmp_path):
    db_path = str(tmp_path / "test.db")
    conn = await aiosqlite.connect(db_path)
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    # Seed data
    await conn.execute(
        "INSERT INTO projects(name, description) VALUES (?,?)",
        ("Router Test Project", "for router tests"),
    )
    pid_cur = await conn.execute("SELECT last_insert_rowid()")
    pid_row = await pid_cur.fetchone()
    pid = pid_row[0]
    await conn.execute(
        "INSERT INTO tasks(title, description, project_id) VALUES (?,?,?)",
        ("Searchable router task", "router test description", pid),
    )
    await conn.commit()

    original_db = db_module._db
    db_module._db = conn

    app = FastAPI()
    app.include_router(search_router.router)
    client = TestClient(app, raise_server_exceptions=True)
    yield client

    db_module._db = original_db
    await conn.close()


def test_search_returns_200(test_app):
    resp = test_app.get("/api/v1/search?q=router")
    assert resp.status_code == 200
    body = resp.json()
    assert "results" in body
    assert "query" in body
    assert "total" in body
    assert isinstance(body["results"], list)


def test_missing_q_returns_422(test_app):
    resp = test_app.get("/api/v1/search")
    assert resp.status_code == 422


def test_unknown_types_returns_400(test_app):
    resp = test_app.get("/api/v1/search?q=test&types=invalid")
    assert resp.status_code == 400


def test_q_too_long_returns_422(test_app):
    resp = test_app.get(f"/api/v1/search?q={'x' * 501}")
    assert resp.status_code == 422


def test_limit_clamped(test_app):
    resp = test_app.get("/api/v1/search?q=test&limit=999")
    assert resp.status_code == 200


def test_short_query_returns_empty_results(test_app):
    resp = test_app.get("/api/v1/search?q=x")
    assert resp.status_code == 200
    assert resp.json()["results"] == []
