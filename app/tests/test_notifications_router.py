"""Smoke tests for notifications router."""

import pathlib
import pytest
import pytest_asyncio
import aiosqlite
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import notifications as notifications_router
from app.services import notification_service
import app.database as db_module

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await db.executescript(mig.read_text())


@pytest_asyncio.fixture
async def test_app(tmp_path):
    conn = await aiosqlite.connect(str(tmp_path / "test.db"))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    notification_service._subscribers.clear()

    original_db = db_module._db
    db_module._db = conn

    app = FastAPI()
    app.include_router(notifications_router.router)
    client = TestClient(app, raise_server_exceptions=True)
    yield client

    db_module._db = original_db
    await conn.close()


def test_list_empty(test_app):
    resp = test_app.get("/api/v1/notifications")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_mark_single_read(test_app, tmp_path):
    db = db_module._db
    nid = await notification_service.emit(db, type="inbox_new", title="Test")

    resp = test_app.post(f"/api/v1/notifications/{nid}/read")
    assert resp.status_code == 200
    data = resp.json()
    assert data["read_at"] is not None


@pytest.mark.asyncio
async def test_mark_read_404(test_app):
    resp = test_app.post("/api/v1/notifications/999/read")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_mark_all_read(test_app):
    db = db_module._db
    for i in range(3):
        await notification_service.emit(db, type="inbox_new", title=f"Item {i}")

    resp = test_app.post("/api/v1/notifications/read-all")
    assert resp.status_code == 200
    assert resp.json()["updated"] == 3

    unread_resp = test_app.get("/api/v1/notifications?unread=true")
    assert unread_resp.json() == []


@pytest.mark.asyncio
async def test_delete_notification(test_app):
    db = db_module._db
    nid = await notification_service.emit(db, type="inbox_new", title="Delete me")

    resp = test_app.delete(f"/api/v1/notifications/{nid}")
    assert resp.status_code == 200

    list_resp = test_app.get("/api/v1/notifications")
    ids = [n["id"] for n in list_resp.json()]
    assert nid not in ids


def test_delete_notification_404(test_app):
    resp = test_app.delete("/api/v1/notifications/999")
    assert resp.status_code == 404


def test_stream_endpoint_exists(test_app):
    # The SSE body never ends, so issuing a request blocks the test runner —
    # .get(timeout=) and .stream() both hang because the endpoint only flushes
    # once an event arrives. Assert the route is registered instead of opening
    # the stream.
    paths = test_app.app.openapi()["paths"]
    assert "/api/v1/notifications/stream" in paths
