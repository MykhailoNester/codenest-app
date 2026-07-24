"""Tests for notification_service."""

import pathlib

import aiosqlite
import pytest
import pytest_asyncio

from app.services import notification_service

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        text = mig.read_text()
        await db.executescript(text)


@pytest_asyncio.fixture
async def db(tmp_path):
    db_path = tmp_path / "test.db"
    conn = await aiosqlite.connect(str(db_path))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    # Clear global subscribers between tests
    notification_service._subscribers.clear()
    yield conn
    await conn.close()


@pytest.mark.asyncio
async def test_emit_writes_row(db):
    await notification_service.emit(db, type="inbox_new", title="New item")
    cur = await db.execute(
        "SELECT COUNT(*) as cnt FROM notifications WHERE type='inbox_new'"
    )
    row = await cur.fetchone()
    assert row["cnt"] == 1


@pytest.mark.asyncio
async def test_emit_publishes_to_queue(db):
    q = notification_service.subscribe()
    try:
        await notification_service.emit(db, type="inbox_new", title="New item")
        msg = q.get_nowait()
        assert msg["type"] == "inbox_new"
    finally:
        notification_service.unsubscribe(q)


@pytest.mark.asyncio
async def test_emit_with_full_arguments(db):
    await notification_service.emit(
        db,
        type="session_failed",
        title="T",
        body="B",
        payload={"session_id": "x"},
        target="user",
        priority="high",
    )
    cur = await db.execute("SELECT * FROM notifications WHERE type='session_failed'")
    row = await cur.fetchone()
    assert row["body"] == "B"
    assert row["priority"] == "high"
    assert row["target"] == "user"
    assert "session_id" in row["payload_json"]


@pytest.mark.asyncio
async def test_mark_read(db):
    nid = await notification_service.emit(db, type="inbox_new", title="Item")
    updated = await notification_service.mark_read(db, nid)
    assert updated is not None
    assert updated["read_at"] is not None


@pytest.mark.asyncio
async def test_mark_all_read(db):
    for i in range(3):
        await notification_service.emit(db, type="inbox_new", title=f"Item {i}")
    count = await notification_service.mark_all_read(db)
    assert count == 3
    unread = await notification_service.list_notifications(db, unread_only=True)
    assert len(unread) == 0


@pytest.mark.asyncio
async def test_cost_threshold_dedup(db):
    await notification_service.emit(db, type="cost_threshold", title="Threshold hit")
    await notification_service.emit(db, type="cost_threshold", title="Threshold hit 2")
    cur = await db.execute(
        "SELECT COUNT(*) as cnt FROM notifications WHERE type='cost_threshold'"
    )
    row = await cur.fetchone()
    # Both rows are inserted — dedup logic lives in agent_service, not here
    assert row["cnt"] == 2


@pytest.mark.asyncio
async def test_delete_notification(db):
    nid = await notification_service.emit(db, type="inbox_new", title="Delete me")
    deleted = await notification_service.delete_notification(db, nid)
    assert deleted is True
    remaining = await notification_service.list_notifications(db)
    assert all(n["id"] != nid for n in remaining)


@pytest.mark.asyncio
async def test_list_unread_only(db):
    nid1 = await notification_service.emit(db, type="inbox_new", title="Unread")
    nid2 = await notification_service.emit(db, type="inbox_new", title="Read")
    await notification_service.mark_read(db, nid2)
    unread = await notification_service.list_notifications(db, unread_only=True)
    ids = [n["id"] for n in unread]
    assert nid1 in ids
    assert nid2 not in ids
