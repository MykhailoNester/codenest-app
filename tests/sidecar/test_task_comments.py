"""Tests for `task_comments`: service CRUD on `task_service`, the stored
human/agent/operator attribution, and the four
`/api/v1/tasks/{id}/comments` router endpoints."""

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


async def _make_member(db: aiosqlite.Connection, name: str, kind: str) -> int:
    cur = await db.execute(
        "INSERT INTO members (name, role, type) VALUES (?, ?, ?)",
        (name, "role", kind),
    )
    await db.commit()
    member_id = cur.lastrowid
    assert member_id is not None
    return member_id


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
async def test_comments_are_scoped_to_their_task_and_listed_oldest_first(
    migrated_db: aiosqlite.Connection,
) -> None:
    task_a = await _make_task(migrated_db, "A")
    task_b = await _make_task(migrated_db, "B")
    await task_service.create_comment(migrated_db, task_a, "first")
    await task_service.create_comment(migrated_db, task_a, "second")
    await task_service.create_comment(migrated_db, task_b, "other")

    assert [
        c["body"] for c in await task_service.list_comments(migrated_db, task_a)
    ] == ["first", "second"]
    assert [
        c["body"] for c in await task_service.list_comments(migrated_db, task_b)
    ] == ["other"]


@pytest.mark.asyncio
async def test_author_kind_is_stored_per_comment(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The decision this ticket settled: an agent may post, a human may post,
    and a comment with no author is the operator — never a fabricated name."""
    task_id = await _make_task(migrated_db)
    human = await _make_member(migrated_db, "Dana", "human")
    agent = await _make_member(migrated_db, "Orion", "agent")

    operator = await task_service.create_comment(migrated_db, task_id, "mine")
    assert (operator["author_kind"], operator["author_id"]) == ("operator", None)
    assert operator["author_name"] is None

    by_human = await task_service.create_comment(migrated_db, task_id, "hi", human)
    assert (by_human["author_kind"], by_human["author_name"]) == ("human", "Dana")

    by_agent = await task_service.create_comment(migrated_db, task_id, "ran it", agent)
    assert (by_agent["author_kind"], by_agent["author_name"]) == ("agent", "Orion")

    with pytest.raises(HTTPException) as exc:
        await task_service.create_comment(migrated_db, task_id, "ghost", 9999)
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_another_tasks_comment_is_not_reachable(
    migrated_db: aiosqlite.Connection,
) -> None:
    owner = await _make_task(migrated_db, "owner")
    stranger = await _make_task(migrated_db, "stranger")
    comment = await task_service.create_comment(migrated_db, owner, "mine")

    with pytest.raises(HTTPException) as exc:
        await task_service.update_comment(
            migrated_db, stranger, comment["id"], {"body": "theirs"}
        )
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        await task_service.delete_comment(migrated_db, stranger, comment["id"])
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_deleting_a_task_cascades_to_its_comments(
    migrated_db: aiosqlite.Connection,
) -> None:
    task_id = await _make_task(migrated_db)
    await task_service.create_comment(migrated_db, task_id, "gone soon")

    await task_service.delete_task(migrated_db, task_id)

    async with migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM task_comments WHERE task_id = ?", (task_id,)
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

    created = client.post(f"/api/v1/tasks/{task_id}/comments", json={"body": "ship it"})
    assert created.status_code == 201
    comment_id = created.json()["id"]

    assert (
        client.post(
            f"/api/v1/tasks/{task_id}/comments", json={"body": "  "}
        ).status_code
        == 400
    )

    patched = client.patch(
        f"/api/v1/tasks/{task_id}/comments/{comment_id}", json={"body": "ship it now"}
    )
    assert patched.json()["body"] == "ship it now"

    assert (
        client.delete(f"/api/v1/tasks/{task_id}/comments/{comment_id}").status_code
        == 200
    )
    assert client.get(f"/api/v1/tasks/{task_id}/comments").json() == []
