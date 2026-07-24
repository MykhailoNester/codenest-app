"""Tests for agents router — ended-default behaviour, /sessions/ended, /recent-events."""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import agents as agents_router

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await db.executescript(mig.read_text())


@pytest_asyncio.fixture
async def test_app(tmp_path):
    conn = await aiosqlite.connect(str(tmp_path / "test.db"))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)

    original_db = db_module._db
    db_module._db = conn

    app = FastAPI()
    app.include_router(agents_router.router)
    client = TestClient(app, raise_server_exceptions=True)
    yield client

    db_module._db = original_db
    await conn.close()


async def _insert_session(
    db: aiosqlite.Connection,
    session_id: str,
    profile: str = "work",
    status: str = "ended",
    last_event_at: str = "datetime('now', '-1 hour')",
) -> None:
    await db.execute(
        f"""
        INSERT INTO agent_sessions
            (session_id, profile, status, cost_usd,
             started_at, last_event_at, tokens_in, tokens_out)
        VALUES (?, ?, ?, 0.0, {last_event_at}, {last_event_at}, 0, 0)
        """,
        (session_id, profile, status),
    )
    await db.commit()


# ─── Default list excludes ended ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_default_list_excludes_ended(test_app):
    """GET /api/v1/agents/sessions without params must NOT return ended sessions."""
    db = db_module._db
    await _insert_session(db, "s-ended-1", status="ended")
    await _insert_session(db, "s-active-1", status="active")
    await _insert_session(db, "s-idle-1", status="idle")

    resp = test_app.get("/api/v1/agents/sessions")
    assert resp.status_code == 200
    data = resp.json()
    ids = {s["session_id"] for s in data}
    assert "s-ended-1" not in ids
    assert "s-active-1" in ids
    assert "s-idle-1" in ids


@pytest.mark.asyncio
async def test_explicit_ended_status_returns_ended(test_app):
    """GET /api/v1/agents/sessions?status=ended should return only ended sessions."""
    db = db_module._db
    await _insert_session(db, "s-ended-2", status="ended")
    await _insert_session(db, "s-active-2", status="active")

    resp = test_app.get("/api/v1/agents/sessions?status=ended")
    assert resp.status_code == 200
    data = resp.json()
    ids = {s["session_id"] for s in data}
    assert "s-ended-2" in ids
    assert "s-active-2" not in ids


@pytest.mark.asyncio
async def test_include_ended_flag(test_app):
    """GET /api/v1/agents/sessions?include_ended=true must include all statuses."""
    db = db_module._db
    await _insert_session(db, "s-ended-3", status="ended")
    await _insert_session(db, "s-active-3", status="active")

    resp = test_app.get("/api/v1/agents/sessions?include_ended=true")
    assert resp.status_code == 200
    data = resp.json()
    ids = {s["session_id"] for s in data}
    assert "s-ended-3" in ids
    assert "s-active-3" in ids


# ─── /sessions/ended paginated history ───────────────────────────────────────


@pytest.mark.asyncio
async def test_sessions_ended_basic(test_app):
    """/sessions/ended returns {items, total} with only ended sessions."""
    db = db_module._db
    for i in range(5):
        await _insert_session(db, f"se-{i}", status="ended")
    await _insert_session(db, "se-active", status="active")

    resp = test_app.get("/api/v1/agents/sessions/ended?limit=10&offset=0")
    assert resp.status_code == 200
    data = resp.json()
    assert "items" in data
    assert "total" in data
    assert data["total"] == 5
    ids = {s["session_id"] for s in data["items"]}
    assert "se-active" not in ids
    for i in range(5):
        assert f"se-{i}" in ids


@pytest.mark.asyncio
async def test_sessions_ended_pagination(test_app):
    """/sessions/ended offset/limit paginates correctly."""
    db = db_module._db
    for i in range(7):
        await _insert_session(db, f"pg-{i}", status="ended")

    page1 = test_app.get("/api/v1/agents/sessions/ended?limit=4&offset=0").json()
    page2 = test_app.get("/api/v1/agents/sessions/ended?limit=4&offset=4").json()

    assert page1["total"] == 7
    assert len(page1["items"]) == 4
    assert len(page2["items"]) == 3

    ids1 = {s["session_id"] for s in page1["items"]}
    ids2 = {s["session_id"] for s in page2["items"]}
    assert ids1.isdisjoint(ids2)


@pytest.mark.asyncio
async def test_sessions_ended_empty(test_app):
    """/sessions/ended returns empty list when no ended sessions exist."""
    resp = test_app.get("/api/v1/agents/sessions/ended")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 0
    assert data["items"] == []


# ─── /recent-events ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recent_events_basic(test_app):
    """/recent-events returns list of cross-session events."""
    db = db_module._db
    await _insert_session(db, "rev-s1", status="active")
    # Insert events of relevant types
    for etype in ("PreToolUse", "UserPromptSubmit", "SessionEnd"):
        await db.execute(
            """
            INSERT INTO agent_events
                (session_id, event_type, tool_name, summary, payload_json, created_at)
            VALUES (?, ?, NULL, 'summary', '{}', datetime('now'))
            """,
            ("rev-s1", etype),
        )
    # Insert an irrelevant event type that should NOT appear
    await db.execute(
        """
        INSERT INTO agent_events
            (session_id, event_type, tool_name, summary, payload_json, created_at)
        VALUES ('rev-s1', 'PostToolUse', NULL, 'done', '{}', datetime('now'))
        """,
    )
    await db.commit()

    resp = test_app.get("/api/v1/agents/recent-events?limit=50")
    assert resp.status_code == 200
    data = resp.json()
    event_types = {e["event_type"] for e in data}
    assert "PreToolUse" in event_types
    assert "UserPromptSubmit" in event_types
    assert "SessionEnd" in event_types
    assert "PostToolUse" not in event_types

    # Each row must carry profile and project_name fields
    for ev in data:
        assert "profile" in ev
        assert "project_name" in ev
        assert "session_id" in ev


@pytest.mark.asyncio
async def test_recent_events_limit(test_app):
    """/recent-events respects the limit query param."""
    db = db_module._db
    await _insert_session(db, "rev-lim", status="active")
    for i in range(10):
        await db.execute(
            """
            INSERT INTO agent_events
                (session_id, event_type, tool_name, summary, payload_json, created_at)
            VALUES ('rev-lim', 'PreToolUse', 'Bash', ?, '{}', datetime('now'))
            """,
            (f"cmd-{i}",),
        )
    await db.commit()

    resp = test_app.get("/api/v1/agents/recent-events?limit=3")
    assert resp.status_code == 200
    assert len(resp.json()) <= 3


@pytest.mark.asyncio
async def test_recent_events_empty(test_app):
    """/recent-events returns empty list when no events exist."""
    resp = test_app.get("/api/v1/agents/recent-events")
    assert resp.status_code == 200
    assert resp.json() == []
