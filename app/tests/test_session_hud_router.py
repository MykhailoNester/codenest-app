"""Tests for GET /api/v1/agents/hud (C1).

Same harness as `app/tests/test_agents_router.py` (no conftest — a raw
`executescript` migration apply + a `db_module._db` swap).
"""

from __future__ import annotations

import pathlib
import uuid

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.models.session_hud import PaneHud
from app.routers import agents as agents_router
from app.services import session_hud_service

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


def _gen_uuid() -> str:
    return str(uuid.uuid4())


async def _insert_session(
    db: aiosqlite.Connection,
    session_id: str,
    *,
    pane_id: str | None,
    status: str = "active",
    model: str | None = None,
) -> None:
    await db.execute(
        """INSERT INTO agent_sessions (session_id, status, cost_usd, pane_id, model)
           VALUES (?, ?, 0.0, ?, ?)""",
        (session_id, status, pane_id, model),
    )
    await db.commit()


@pytest.mark.asyncio
async def test_hud_endpoint_empty_on_clean_db(test_app):
    """A freshly migrated DB with no sessions returns a bare, empty, 200 array."""
    resp = test_app.get("/api/v1/agents/hud")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_hud_endpoint_returns_pane_row(test_app):
    db = db_module._db
    session_id = _gen_uuid()
    pane_id = _gen_uuid()
    await _insert_session(
        db, session_id, pane_id=pane_id, model="claude-opus-4-5-20251101"
    )

    resp = test_app.get("/api/v1/agents/hud")
    assert resp.status_code == 200
    panes = resp.json()
    assert isinstance(panes, list)
    assert len(panes) == 1
    pane = panes[0]
    for key in (
        "pane_id",
        "session_id",
        "status",
        "model",
        "context_tokens",
        "context_window",
        "cost_usd",
        "started_at",
        "ended_at",
        "current_tool",
        "current_tool_started_at",
        "thinking",
        "todo_done",
        "todo_total",
    ):
        assert key in pane
    assert pane["pane_id"] == pane_id
    assert pane["session_id"] == session_id
    assert pane["context_window"] == 200_000


@pytest.mark.asyncio
async def test_hud_endpoint_emits_null_not_zero(test_app):
    """Unknown model / context_tokens / todo_* serialise as JSON null, not 0
    or "" — the honesty contract at the HTTP boundary."""
    db = db_module._db
    session_id = _gen_uuid()
    await _insert_session(db, session_id, pane_id=_gen_uuid(), model=None)

    resp = test_app.get("/api/v1/agents/hud")
    assert resp.status_code == 200
    pane = resp.json()[0]
    assert pane["model"] is None
    assert pane["context_tokens"] is None
    assert pane["context_window"] is None
    assert pane["todo_done"] is None
    assert pane["todo_total"] is None


@pytest.mark.asyncio
async def test_hud_endpoint_key_set_matches_sse_paths(test_app):
    """The GET path validates through `PaneHud`; the SSE delta/snapshot paths
    (`agent_service._broadcast`, `stream()`) emit `session_hud_service`'s raw
    dicts unvalidated. They agree today because both come from the same
    `_row_to_hud` — this pins that a field added to one does not silently
    drift from the other."""
    db = db_module._db
    await _insert_session(db, _gen_uuid(), pane_id=_gen_uuid())

    resp = test_app.get("/api/v1/agents/hud")
    http_keys = set(resp.json()[0].keys())

    raw = await session_hud_service.list_live_huds(db)
    assert len(raw) == 1
    assert set(raw[0].keys()) == http_keys
    assert set(PaneHud.model_fields.keys()) == http_keys
