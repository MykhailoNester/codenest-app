"""Integration tests for notification emitters wired into existing services."""

import pathlib

import aiosqlite
import pytest
import pytest_asyncio

from app.models.session_end_reason import EndCategory, classify
from app.services import (
    agent_service,
    notification_service,
    task_service,
)

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        text = mig.read_text()
        await db.executescript(text)


@pytest_asyncio.fixture
async def db(tmp_path):
    conn = await aiosqlite.connect(str(tmp_path / "test.db"))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    notification_service._subscribers.clear()

    # Seed a project (required by task_service)
    await conn.execute(
        "INSERT INTO projects(name, description) VALUES (?, ?)",
        ("TestProject", "test"),
    )
    await conn.commit()
    yield conn
    await conn.close()


async def _project_id(db: aiosqlite.Connection) -> int:
    cur = await db.execute("SELECT id FROM projects WHERE name='TestProject'")
    row = await cur.fetchone()
    return row["id"]  # type: ignore[index]


@pytest.mark.asyncio
async def test_cascade_unblock_emits_blocker_resolved(db):
    pid = await _project_id(db)
    # Create blocking task and blocked task
    blocker_id = await task_service.create_task(
        db, {"title": "Blocker", "project_id": pid, "status": "todo"}
    )
    blocked_id = await task_service.create_task(
        db, {"title": "Blocked", "project_id": pid, "status": "blocked"}
    )
    # Link them
    await db.execute(
        "INSERT INTO task_blockers (blocked_task_id, blocking_task_id) VALUES (?, ?)",
        (blocked_id, blocker_id),
    )
    await db.commit()

    # Mark blocker done → should cascade and emit blocker_resolved
    await task_service.change_task_status(db, blocker_id, "done")

    cur = await db.execute("SELECT * FROM notifications WHERE type='blocker_resolved'")
    row = await cur.fetchone()
    assert row is not None
    assert "Blocked" in row["title"]


@pytest.mark.asyncio
async def test_task_assigned_emits_notification(db):
    pid = await _project_id(db)
    # Seed a member
    await db.execute(
        "INSERT INTO members(name, role, type) VALUES (?, ?, ?)",
        ("Alice", "engineer", "human"),
    )
    await db.commit()
    member_cur = await db.execute("SELECT id FROM members WHERE name='Alice'")
    member = await member_cur.fetchone()
    member_id = member["id"]

    task_id = await task_service.create_task(
        db, {"title": "Assign me", "project_id": pid}
    )
    await task_service.update_task(db, task_id, {"assignee_id": member_id})

    cur = await db.execute("SELECT * FROM notifications WHERE type='task_assigned'")
    row = await cur.fetchone()
    assert row is not None
    assert "Alice" in row["title"]


@pytest.mark.asyncio
async def test_session_end_error_emits_session_failed(db):
    await agent_service.record_session_end(
        db,
        {
            "session_id": "test-session-abc",
            "reason": "error",
        },
    )
    cur = await db.execute("SELECT * FROM notifications WHERE type='session_failed'")
    row = await cur.fetchone()
    assert row is not None
    assert row["priority"] == "high"


@pytest.mark.asyncio
async def test_session_end_normal_emits_session_completed(db):
    await agent_service.record_session_end(
        db,
        {
            "session_id": "test-session-xyz",
            "reason": "normal",
        },
    )
    # Normal end must NOT emit a failure notification.
    cur = await db.execute("SELECT * FROM notifications WHERE type='session_failed'")
    assert await cur.fetchone() is None
    # Normal end MUST emit session_completed (D4: notify on every session end).
    cur = await db.execute("SELECT * FROM notifications WHERE type='session_completed'")
    row = await cur.fetchone()
    assert row is not None
    assert row["priority"] == "normal"


# ─── session-end reason classification ──────────────────────────────


# Unit tests for the pure classify() function — no DB needed.


def test_classify_clean_reasons() -> None:
    """All historically-normal reasons and the new 'other' all map to CLEAN."""
    clean = [
        "",
        "normal",
        "complete",
        "completed",
        "clear",
        "prompt_input_exit",
        "other",
        "manual_cleanup",
    ]
    for r in clean:
        assert classify(r) is EndCategory.CLEAN, f"expected CLEAN for {r!r}"


def test_classify_case_insensitive() -> None:
    assert classify("TIMEOUT") is EndCategory.TIMEOUT
    assert classify("Error") is EndCategory.ERROR
    assert classify("Other") is EndCategory.CLEAN


def test_classify_user_cancelled() -> None:
    assert classify("user_cancelled") is EndCategory.USER_CANCELLED


def test_classify_error() -> None:
    assert classify("error") is EndCategory.ERROR


def test_classify_timeout() -> None:
    assert classify("timeout") is EndCategory.TIMEOUT


def test_classify_unknown_falls_through() -> None:
    assert classify("xyzzy_unknown_reason") is EndCategory.UNKNOWN
    assert classify("some_future_harness_string") is EndCategory.UNKNOWN


# Integration tests — each EndCategory exercised against a real DB.


@pytest.mark.asyncio
async def test_session_end_other_no_failure(db):
    """'other' is the most common false-positive — must not emit session_failed."""
    await agent_service.record_session_end(
        db, {"session_id": "test-idea26-other", "reason": "other"}
    )
    cur = await db.execute("SELECT * FROM notifications WHERE type='session_failed'")
    assert await cur.fetchone() is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reason",
    ["", "complete", "completed", "clear", "prompt_input_exit", "other"],
)
async def test_session_end_clean_reasons_emit_completed_not_failed(db, reason):
    """All CLEAN reasons must emit session_completed (not session_failed)."""
    sid = f"test-clean-{reason or 'empty'}"
    await agent_service.record_session_end(db, {"session_id": sid, "reason": reason})
    cur_failed = await db.execute(
        "SELECT * FROM notifications WHERE type='session_failed'"
    )
    assert await cur_failed.fetchone() is None
    cur_completed = await db.execute(
        "SELECT * FROM notifications WHERE type='session_completed'"
    )
    assert await cur_completed.fetchone() is not None


@pytest.mark.asyncio
async def test_session_end_timeout_emits_session_failed(db):
    await agent_service.record_session_end(
        db, {"session_id": "test-idea26-timeout", "reason": "timeout"}
    )
    cur = await db.execute("SELECT * FROM notifications WHERE type='session_failed'")
    row = await cur.fetchone()
    assert row is not None
    assert row["priority"] == "high"
    assert "timeout" in row["body"]


@pytest.mark.asyncio
async def test_session_end_user_cancelled_silent(db):
    """user_cancelled must produce zero notifications — it is a deliberate action."""
    await agent_service.record_session_end(
        db, {"session_id": "test-idea26-cancelled", "reason": "user_cancelled"}
    )
    cur = await db.execute("SELECT COUNT(*) as cnt FROM notifications")
    row = await cur.fetchone()
    assert row["cnt"] == 0


@pytest.mark.asyncio
async def test_session_end_unknown_emits_info_not_error(db):
    """An unrecognised reason emits session_info (soft), never session_failed."""
    await agent_service.record_session_end(
        db,
        {"session_id": "test-idea26-unknown", "reason": "xyzzy_unknown_reason"},
    )
    cur_failed = await db.execute(
        "SELECT * FROM notifications WHERE type='session_failed'"
    )
    assert await cur_failed.fetchone() is None

    cur_info = await db.execute("SELECT * FROM notifications WHERE type='session_info'")
    row = await cur_info.fetchone()
    assert row is not None
    assert row["priority"] == "normal"
    assert "xyzzy_unknown_reason" in row["body"]


@pytest.mark.asyncio
async def test_list_recent_unread_returns_recent(db):
    """list_recent_unread returns unread notifications within the window."""
    await notification_service.emit(
        db, type="session_completed", title="Done", priority="normal"
    )
    result = await notification_service.list_recent_unread(db, window_minutes=60)
    assert len(result) == 1
    assert result[0]["type"] == "session_completed"


@pytest.mark.asyncio
async def test_list_recent_unread_excludes_read(db):
    """list_recent_unread excludes already-read notifications."""
    nid = await notification_service.emit(
        db, type="session_completed", title="Done", priority="normal"
    )
    await notification_service.mark_read(db, nid)
    result = await notification_service.list_recent_unread(db, window_minutes=60)
    assert result == []
