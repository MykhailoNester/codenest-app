"""Tests for the launch seed service and router.

Covers:
- Task seed without override matches provider defaults.
- Inbox seed merges action_text into the prompt.
- Seed merges a saved override.
- Unknown source returns 404.
- Invalid source_kind returns 422.
- Project NULL on source returns project=null with 200.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
import aiosqlite
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import launch_seed as seed_router
from app.services import launch_seed_service, launch_override_service
from app.models.launch import LaunchOverrideUpsert


# ---------------------------------------------------------------------------
# Test app fixture
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def test_app(migrated_db: aiosqlite.Connection):
    original = db_module._db
    db_module._db = migrated_db

    application = FastAPI()
    application.include_router(seed_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db

    db_module._db = original


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_project_id(db: aiosqlite.Connection, name: str = "TestProject") -> int:
    await db.execute(
        "INSERT OR IGNORE INTO projects (name, description, tech_stack, status, path) "
        "VALUES (?, ?, ?, ?, ?)",
        (name, None, None, "active", f"/Users/test/{name}"),
    )
    await db.commit()
    cur = await db.execute("SELECT id FROM projects WHERE name = ?", (name,))
    row = await cur.fetchone()
    assert row is not None
    return row["id"]


async def _insert_task(
    db: aiosqlite.Connection,
    title: str = "Investigate CI",
    description: str | None = "logs at /tmp/ci.log",
    project_id: int | None = None,
) -> int:
    if project_id is None:
        project_id = await _get_project_id(db)
    cur = await db.execute(
        "INSERT INTO tasks (title, description, status, priority, project_id) VALUES (?, ?, ?, ?, ?)",
        (title, description, "todo", "medium", project_id),
    )
    await db.commit()
    return cur.lastrowid  # type: ignore[return-value]


async def _insert_inbox(
    db: aiosqlite.Connection,
    title: str = "Bug in onboarding",
    description: str | None = "users see blank screen",
    action_text: str | None = None,
    project_id: int | None = None,
) -> int:
    cur = await db.execute(
        "INSERT INTO workflow_items (title, description, action_text, status, type, priority, project_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (title, description, action_text, "inbox", "action", "medium", project_id),
    )
    await db.commit()
    return cur.lastrowid  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Service layer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_build_seed_task_no_override(migrated_db: aiosqlite.Connection) -> None:
    """Task seed without override must match provider defaults."""
    tid = await _insert_task(migrated_db)

    seed = await launch_seed_service.build_seed(migrated_db, "task", tid)

    assert seed.source.kind == "task"
    assert seed.source.id == tid
    assert seed.source.title == "Investigate CI"
    assert f"task #{tid}" in seed.prompt
    assert "Investigate CI" in seed.prompt
    assert "logs at /tmp/ci.log" in seed.prompt
    assert seed.project is not None
    assert seed.rows == 1
    assert seed.cols == 1
    assert seed.target == "embedded"
    assert seed.prompt_fanout == "primary"
    assert seed.has_override is False


@pytest.mark.asyncio
async def test_build_seed_inbox_with_action_text(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Inbox seed must merge action_text into the prompt."""
    iid = await _insert_inbox(
        migrated_db,
        action_text="repro on staging then file fix",
    )

    seed = await launch_seed_service.build_seed(migrated_db, "inbox", iid)

    assert "users see blank screen" in seed.prompt
    assert "Suggested action: repro on staging then file fix" in seed.prompt
    assert seed.project is None  # no project_id on the item


@pytest.mark.asyncio
async def test_build_seed_merges_override(migrated_db: aiosqlite.Connection) -> None:
    """Saved override must shadow defaults in the returned seed."""
    tid = await _insert_task(migrated_db)

    await launch_override_service.upsert_override(
        migrated_db,
        "task",
        tid,
        LaunchOverrideUpsert(
            model="claude-opus-4-7",
            rows=2,
            cols=2,
            prompt_fanout="every",
            extra_args="--verbose",
        ),
    )

    seed = await launch_seed_service.build_seed(migrated_db, "task", tid)

    assert seed.model == "claude-opus-4-7"
    assert seed.rows == 2
    assert seed.cols == 2
    assert seed.prompt_fanout == "every"
    assert seed.extra_args == "--verbose"
    assert seed.has_override is True


@pytest.mark.asyncio
async def test_build_seed_unknown_source_raises_404(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Missing source must raise HTTPException 404."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await launch_seed_service.build_seed(migrated_db, "task", 99999)
    assert exc_info.value.status_code == 404
    assert "99999" in exc_info.value.detail


@pytest.mark.asyncio
async def test_build_seed_null_project_returns_none(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Source with project_id=NULL must return project=None (not an error)."""
    iid = await _insert_inbox(migrated_db, project_id=None)

    seed = await launch_seed_service.build_seed(migrated_db, "inbox", iid)

    assert seed.project is None


# ---------------------------------------------------------------------------
# Router (HTTP) layer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_http_seed_task(test_app) -> None:
    """GET /api/v1/launch/seed?source_kind=task&source_id=N must return 200."""
    client, db = test_app
    tid = await _insert_task(db)

    resp = client.get(f"/api/v1/launch/seed?source_kind=task&source_id={tid}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["source"]["kind"] == "task"
    assert data["source"]["id"] == tid
    assert "has_override" in data


@pytest.mark.asyncio
async def test_http_seed_unknown_source_returns_404(test_app) -> None:
    """Unknown source_id must return 404."""
    client, _ = test_app
    resp = client.get("/api/v1/launch/seed?source_kind=task&source_id=99999")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_http_seed_invalid_source_kind_returns_422(test_app) -> None:
    """Invalid source_kind must return 422."""
    client, _ = test_app
    resp = client.get("/api/v1/launch/seed?source_kind=foo&source_id=1")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_http_seed_null_project_returns_200(test_app) -> None:
    """Source with null project must return 200 with project=null."""
    client, db = test_app
    iid = await _insert_inbox(db, project_id=None)

    resp = client.get(f"/api/v1/launch/seed?source_kind=inbox&source_id={iid}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["project"] is None
