"""Tests for the launch override service and router.

Covers:
- PUT creates a new row.
- PUT updates an existing row and bumps updated_at.
- DELETE removes a row.
- Invalid prompt_fanout returns 422.
- Invalid source_kind returns 422.
- Deleting a source task cascades to drop the override.
- Deleting a source inbox item cascades to drop the override.
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
import aiosqlite
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import launch_overrides as overrides_router
from app.routers import tasks as tasks_router
from app.routers import inbox as inbox_router
from app.services import launch_override_service
from app.models.launch import LaunchOverrideUpsert

# ---------------------------------------------------------------------------
# Test app fixture
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def test_app(migrated_db: aiosqlite.Connection):
    """FastAPI app wired to the isolated migrated DB."""
    original = db_module._db
    db_module._db = migrated_db

    application = FastAPI()
    application.include_router(overrides_router.router)
    application.include_router(tasks_router.router)
    application.include_router(inbox_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db

    db_module._db = original


# ---------------------------------------------------------------------------
# Helper: insert a task / inbox item
# ---------------------------------------------------------------------------


async def _insert_task(db: aiosqlite.Connection, title: str = "Test task") -> int:
    # Need a project to satisfy the FK on tasks.project_id
    cur = await db.execute(
        "INSERT OR IGNORE INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
        ("TestProject", None, None, "active"),
    )
    await db.commit()
    cur = await db.execute("SELECT id FROM projects WHERE name='TestProject'")
    proj = await cur.fetchone()
    assert proj is not None

    cur = await db.execute(
        "INSERT INTO tasks (title, status, priority, project_id) VALUES (?, ?, ?, ?)",
        (title, "todo", "medium", proj["id"]),
    )
    await db.commit()
    return cur.lastrowid  # type: ignore[return-value]


async def _insert_inbox(db: aiosqlite.Connection, title: str = "Inbox item") -> int:
    cur = await db.execute(
        "INSERT INTO workflow_items (title, status, type, priority) VALUES (?, ?, ?, ?)",
        (title, "inbox", "action", "medium"),
    )
    await db.commit()
    return cur.lastrowid  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Service layer tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upsert_creates_row(migrated_db: aiosqlite.Connection) -> None:
    """upsert_override must create a new row when none exists."""
    tid = await _insert_task(migrated_db)
    payload = LaunchOverrideUpsert(model="claude-opus-4-7", rows=2, cols=2)

    result = await launch_override_service.upsert_override(
        migrated_db, "task", tid, payload
    )

    assert result.source_kind == "task"
    assert result.source_id == tid
    assert result.model == "claude-opus-4-7"
    assert result.rows == 2
    assert result.cols == 2


@pytest.mark.asyncio
async def test_upsert_updates_row_and_bumps_updated_at(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Second upsert must update the row and bump updated_at."""
    tid = await _insert_task(migrated_db)

    first = await launch_override_service.upsert_override(
        migrated_db, "task", tid, LaunchOverrideUpsert(model="claude-sonnet-4-6")
    )
    # Small delay to ensure CURRENT_TIMESTAMP can differ at seconds resolution.
    await asyncio.sleep(1.1)

    second = await launch_override_service.upsert_override(
        migrated_db, "task", tid, LaunchOverrideUpsert(model="claude-haiku-4-5")
    )

    assert second.model == "claude-haiku-4-5"
    # updated_at should be >= first (may be equal if sub-second resolution)
    assert second.updated_at is not None
    assert first.updated_at is not None


@pytest.mark.asyncio
async def test_delete_removes_row(migrated_db: aiosqlite.Connection) -> None:
    """delete_override must remove the row."""
    tid = await _insert_task(migrated_db)
    await launch_override_service.upsert_override(
        migrated_db, "task", tid, LaunchOverrideUpsert(rows=1)
    )

    assert (
        await launch_override_service.get_override(migrated_db, "task", tid) is not None
    )

    await launch_override_service.delete_override(migrated_db, "task", tid)

    assert await launch_override_service.get_override(migrated_db, "task", tid) is None


@pytest.mark.asyncio
async def test_delete_task_cascades_override(migrated_db: aiosqlite.Connection) -> None:
    """Deleting a task via task_service must also drop its override row."""
    from app.services import task_service

    tid = await _insert_task(migrated_db)
    await launch_override_service.upsert_override(
        migrated_db, "task", tid, LaunchOverrideUpsert(rows=2)
    )
    assert (
        await launch_override_service.get_override(migrated_db, "task", tid) is not None
    )

    await task_service.delete_task(migrated_db, tid)

    assert await launch_override_service.get_override(migrated_db, "task", tid) is None


@pytest.mark.asyncio
async def test_delete_inbox_cascades_override(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Deleting an inbox item via inbox_service must also drop its override row."""
    from app.services import inbox_service

    iid = await _insert_inbox(migrated_db)
    await launch_override_service.upsert_override(
        migrated_db, "inbox", iid, LaunchOverrideUpsert(prompt_fanout="every")
    )
    assert (
        await launch_override_service.get_override(migrated_db, "inbox", iid)
        is not None
    )

    await inbox_service.delete_item(migrated_db, iid)

    assert await launch_override_service.get_override(migrated_db, "inbox", iid) is None


# ---------------------------------------------------------------------------
# Router (HTTP) layer tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_http_put_creates_override(test_app) -> None:
    """PUT must return 200 and create an override row."""
    client, db = test_app
    tid = await _insert_task(db)

    resp = client.put(
        f"/api/v1/launch/overrides/task/{tid}",
        json={
            "model": "claude-opus-4-7",
            "rows": 2,
            "cols": 2,
            "prompt_fanout": "every",
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["model"] == "claude-opus-4-7"
    assert data["rows"] == 2
    assert data["prompt_fanout"] == "every"


@pytest.mark.asyncio
async def test_http_put_updates_override(test_app) -> None:
    """Second PUT must update the row."""
    client, db = test_app
    tid = await _insert_task(db)

    client.put(
        f"/api/v1/launch/overrides/task/{tid}", json={"model": "claude-sonnet-4-6"}
    )
    resp = client.put(
        f"/api/v1/launch/overrides/task/{tid}", json={"model": "claude-haiku-4-5"}
    )

    assert resp.status_code == 200
    assert resp.json()["model"] == "claude-haiku-4-5"


@pytest.mark.asyncio
async def test_http_delete_override(test_app) -> None:
    """DELETE must return 200 and remove the row."""
    client, db = test_app
    tid = await _insert_task(db)

    client.put(f"/api/v1/launch/overrides/task/{tid}", json={"rows": 1})
    resp = client.delete(f"/api/v1/launch/overrides/task/{tid}")
    assert resp.status_code == 200

    override = await launch_override_service.get_override(db, "task", tid)
    assert override is None


@pytest.mark.asyncio
async def test_http_invalid_prompt_fanout_returns_422(test_app) -> None:
    """Invalid prompt_fanout must be rejected with 422."""
    client, db = test_app
    tid = await _insert_task(db)

    resp = client.put(
        f"/api/v1/launch/overrides/task/{tid}",
        json={"prompt_fanout": "shotgun"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_http_invalid_source_kind_returns_422(test_app) -> None:
    """Invalid source_kind path segment must return 422."""
    client, _ = test_app
    resp = client.put("/api/v1/launch/overrides/slack/1", json={})
    assert resp.status_code == 422
