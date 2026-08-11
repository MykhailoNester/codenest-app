"""Tests for the per-task activity read: `activity_service.list_for_entity`,
`task_service.list_task_activity`, and `GET /api/v1/tasks/{id}/activity`.

The `migrated_db` fixture ships with the `Unassigned` project (id 1) from the
baseline seed and zero tasks; every test seeds its own task(s) via
`_make_task`.
"""

from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import tasks as tasks_router
from app.services import activity_service, task_service


async def _make_task(db: aiosqlite.Connection, title: str = "t") -> int:
    return await task_service.create_task(db, {"title": title, "project_id": 1})


@pytest_asyncio.fixture
async def tasks_app(
    migrated_db: aiosqlite.Connection,
) -> tuple[TestClient, aiosqlite.Connection]:
    original_db = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(tasks_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db
    db_module._db = original_db


@pytest.mark.asyncio
async def test_returns_only_this_tasks_rows(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    a = await _make_task(db, "a")
    b = await _make_task(db, "b")
    await task_service.change_task_status(db, a, "in-progress")
    await task_service.change_task_status(db, b, "in-progress")

    resp = client.get(f"/api/v1/tasks/{a}/activity")
    assert resp.status_code == 200
    rows = resp.json()
    assert rows
    assert {row["entity_id"] for row in rows} == {a}
    assert {row["action"] for row in rows} == {"created", "status_changed"}


@pytest.mark.asyncio
async def test_newest_first_with_id_tiebreak(
    migrated_db: aiosqlite.Connection,
) -> None:
    tid = await _make_task(migrated_db)
    same_stamp = "2026-01-01 12:00:00"
    await migrated_db.execute(
        "INSERT INTO activity_log "
        "(entity_type, entity_id, action, actor, created_at) "
        "VALUES ('task', ?, 'label_added', 'system', ?)",
        (tid, same_stamp),
    )
    await migrated_db.execute(
        "INSERT INTO activity_log "
        "(entity_type, entity_id, action, actor, created_at) "
        "VALUES ('task', ?, 'label_removed', 'system', ?)",
        (tid, same_stamp),
    )
    await migrated_db.commit()

    rows = await activity_service.list_for_entity(migrated_db, "task", tid)
    tied = [r for r in rows if r["created_at"] == same_stamp]
    assert len(tied) == 2
    assert tied[0]["id"] > tied[1]["id"]


@pytest.mark.asyncio
async def test_default_limit_is_50(migrated_db: aiosqlite.Connection) -> None:
    tid = await _make_task(migrated_db)
    # Far-future stamps so every inserted row sorts newer than the "created"
    # row _make_task wrote with the real CURRENT_TIMESTAMP.
    for i in range(60):
        await migrated_db.execute(
            "INSERT INTO activity_log "
            "(entity_type, entity_id, action, actor, created_at) "
            "VALUES ('task', ?, 'label_added', 'system', ?)",
            (tid, f"2099-01-01 12:{i:02d}:00"),
        )
    await migrated_db.commit()

    rows = await activity_service.list_for_entity(migrated_db, "task", tid)
    assert len(rows) == 50
    # Newest 50 of the 60 inserted rows -- confirm the very newest timestamp
    # is included and the "created" row (oldest) is excluded.
    assert rows[0]["created_at"] == "2099-01-01 12:59:00"
    assert all(row["action"] == "label_added" for row in rows)


@pytest.mark.asyncio
async def test_limit_param_is_honoured_and_clamped(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    tid = await _make_task(db)
    # Insert rows directly (mirroring test_newest_first_with_id_tiebreak)
    # rather than depending on real label ids.
    for i in range(210):
        await db.execute(
            "INSERT INTO activity_log "
            "(entity_type, entity_id, action, actor, created_at) "
            "VALUES ('task', ?, 'label_added', 'system', ?)",
            (tid, f"2026-01-02 00:{i % 60:02d}:{i // 60:02d}"),
        )
    await db.commit()

    resp = client.get(f"/api/v1/tasks/{tid}/activity", params={"limit": 2})
    assert len(resp.json()) == 2

    resp = client.get(f"/api/v1/tasks/{tid}/activity", params={"limit": 0})
    assert len(resp.json()) == 1

    resp = client.get(f"/api/v1/tasks/{tid}/activity", params={"limit": 9999})
    assert len(resp.json()) == activity_service.MAX_ENTITY_LIMIT


@pytest.mark.asyncio
async def test_unknown_task_returns_404(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, _ = tasks_app
    resp = client.get("/api/v1/tasks/9999/activity")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "task not found"}


@pytest.mark.asyncio
async def test_task_with_no_activity_returns_empty_array(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    # Insert a tasks row directly, bypassing create_task (which logs
    # "created"), so this task truly has zero activity_log rows.
    cursor = await db.execute(
        "INSERT INTO tasks (title, status, priority, project_id) "
        "VALUES ('bare', 'todo', 'medium', 1)"
    )
    await db.commit()
    tid = cursor.lastrowid
    assert tid is not None

    resp = client.get(f"/api/v1/tasks/{tid}/activity")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_row_shape_and_values(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    tid = await _make_task(db)
    await task_service.change_task_status(db, tid, "done")

    resp = client.get(f"/api/v1/tasks/{tid}/activity")
    rows = resp.json()
    newest = rows[0]
    assert newest["action"] == "status_changed"
    assert newest["old_value"] == "todo"
    assert newest["new_value"] == "done"
    assert newest["actor"] == "system"
    assert "project_id" not in newest


@pytest.mark.asyncio
async def test_service_is_reusable_for_other_entities(
    migrated_db: aiosqlite.Connection,
) -> None:
    from app.services import inbox_service

    item_id = await inbox_service.create_item(migrated_db, {"title": "inbox item"})

    rows = await activity_service.list_for_entity(migrated_db, "workflow_item", item_id)
    assert len(rows) == 1
    assert rows[0]["action"] == "created"
    assert rows[0]["entity_type"] == "workflow_item"


@pytest.mark.asyncio
async def test_list_task_activity_404s_via_service(
    migrated_db: aiosqlite.Connection,
) -> None:
    with pytest.raises(HTTPException) as exc:
        await task_service.list_task_activity(migrated_db, 999_999)
    assert exc.value.status_code == 404
