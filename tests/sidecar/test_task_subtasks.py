"""Tests for the `task_subtasks` checklist: the service CRUD on
`task_service` and the four `/api/v1/tasks/{id}/subtasks` router endpoints."""

from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import tasks as tasks_router
from app.services import task_service


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
async def test_subtasks_persist_and_are_scoped_to_their_task(
    migrated_db: aiosqlite.Connection,
) -> None:
    task_a = await _make_task(migrated_db, "A")
    task_b = await _make_task(migrated_db, "B")
    await task_service.create_subtask(migrated_db, task_a, "first")
    await task_service.create_subtask(migrated_db, task_a, "second")
    await task_service.create_subtask(migrated_db, task_b, "other")

    rows = await task_service.list_subtasks(migrated_db, task_a)
    assert [r["title"] for r in rows] == ["first", "second"]
    assert [r["sort_order"] for r in rows] == [0, 1]
    assert [
        r["title"] for r in await task_service.list_subtasks(migrated_db, task_b)
    ] == ["other"]


@pytest.mark.asyncio
async def test_update_returns_the_stored_row(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The optimistic checkbox reconciles against this response, so a toggle
    (and a rename) must come back as the row actually stored."""
    task_id = await _make_task(migrated_db)
    created = await task_service.create_subtask(migrated_db, task_id, "draft")
    assert created["done"] is False

    toggled = await task_service.update_subtask(
        migrated_db, task_id, created["id"], {"done": True}
    )
    assert toggled["done"] is True

    renamed = await task_service.update_subtask(
        migrated_db, task_id, created["id"], {"title": "  final  "}
    )
    assert renamed == {**toggled, "title": "final"}


@pytest.mark.asyncio
async def test_another_tasks_subtask_is_not_reachable(
    migrated_db: aiosqlite.Connection,
) -> None:
    owner = await _make_task(migrated_db, "owner")
    stranger = await _make_task(migrated_db, "stranger")
    sub = await task_service.create_subtask(migrated_db, owner, "mine")

    with pytest.raises(HTTPException) as exc:
        await task_service.update_subtask(
            migrated_db, stranger, sub["id"], {"done": True}
        )
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        await task_service.delete_subtask(migrated_db, stranger, sub["id"])
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_deleting_a_task_cascades_to_its_subtasks(
    migrated_db: aiosqlite.Connection,
) -> None:
    task_id = await _make_task(migrated_db)
    await task_service.create_subtask(migrated_db, task_id, "gone soon")

    await task_service.delete_task(migrated_db, task_id)

    async with migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM task_subtasks WHERE task_id = ?", (task_id,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0


@pytest.mark.asyncio
async def test_router_crud_roundtrip(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    task_id = await _make_task(db)

    created = client.post(
        f"/api/v1/tasks/{task_id}/subtasks", json={"title": "ship it"}
    )
    assert created.status_code == 201
    subtask_id = created.json()["id"]

    assert (
        client.post(
            f"/api/v1/tasks/{task_id}/subtasks", json={"title": "  "}
        ).status_code
        == 400
    )

    patched = client.patch(
        f"/api/v1/tasks/{task_id}/subtasks/{subtask_id}", json={"done": True}
    )
    assert patched.json()["done"] is True

    assert (
        client.delete(f"/api/v1/tasks/{task_id}/subtasks/{subtask_id}").status_code
        == 200
    )
    assert client.get(f"/api/v1/tasks/{task_id}/subtasks").json() == []
