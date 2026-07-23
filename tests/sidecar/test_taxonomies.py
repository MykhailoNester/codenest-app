"""Tests for the IDEA-04 schema-driven taxonomies."""

from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import taxonomies as taxonomies_router
from app.services import settings_service, taxonomy_service


@pytest_asyncio.fixture
async def taxonomy_app(
    migrated_db: aiosqlite.Connection,
) -> tuple[TestClient, aiosqlite.Connection]:
    original_db = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(taxonomies_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db
    db_module._db = original_db


@pytest.mark.asyncio
async def test_seed_defaults_are_non_technical(
    migrated_db: aiosqlite.Connection,
) -> None:
    rows = await taxonomy_service.list_by_kind(migrated_db, "task_status")
    by_slug = {r["slug"]: r["display_name"] for r in rows}
    # "Idea" (not "backlog") and "In progress" (not "in-progress") are the
    # acceptance proof — defaults are user-facing words, not engineer words.
    assert by_slug["backlog"] == "Idea"
    assert by_slug["in-progress"] == "In progress"
    assert by_slug["done"] == "Done"


@pytest.mark.asyncio
async def test_rename_changes_display_name_only(
    migrated_db: aiosqlite.Connection,
) -> None:
    rows = await taxonomy_service.list_by_kind(migrated_db, "task_status")
    todo = next(r for r in rows if r["slug"] == "todo")
    # Tasks on disk still reference the slug, never the label.
    await migrated_db.execute(
        "INSERT INTO tasks (title, status, priority, project_id) "
        "VALUES ('demo', 'todo', 'medium', (SELECT id FROM projects LIMIT 1))"
    )
    await migrated_db.commit()
    updated = await taxonomy_service.update(
        migrated_db, todo["id"], {"display_name": "Drafting"}
    )
    assert updated["display_name"] == "Drafting"
    assert updated["slug"] == "todo"
    cur = await migrated_db.execute("SELECT status FROM tasks WHERE title='demo'")
    row = await cur.fetchone()
    # Cascade safety: the rename is display-only — task row untouched.
    assert row is not None and row["status"] == "todo"


@pytest.mark.asyncio
async def test_create_rejects_invalid_kind(
    migrated_db: aiosqlite.Connection,
) -> None:
    with pytest.raises(Exception) as exc:
        await taxonomy_service.create(
            migrated_db, {"kind": "bogus", "slug": "x", "display_name": "X"}
        )
    assert "unknown taxonomy kind" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_create_rejects_invalid_slug(
    migrated_db: aiosqlite.Connection,
) -> None:
    with pytest.raises(Exception) as exc:
        await taxonomy_service.create(
            migrated_db,
            {"kind": "task_status", "slug": "Has Spaces", "display_name": "x"},
        )
    assert "slug must match" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_create_new_status_then_assign_to_task(
    migrated_db: aiosqlite.Connection,
) -> None:
    # Acceptance: new slugs work end-to-end now that the CHECK constraint
    # is gone (migration 027).
    created = await taxonomy_service.create(
        migrated_db,
        {
            "kind": "task_status",
            "slug": "drafting",
            "display_name": "Drafting",
            "sort_order": 25,
        },
    )
    assert created["slug"] == "drafting"
    # Insert a task with the new slug — would have failed CHECK pre-027.
    await migrated_db.execute(
        "INSERT INTO tasks (title, status, priority, project_id) "
        "VALUES ('new-slug-task', 'drafting', 'medium', (SELECT id FROM projects LIMIT 1))"
    )
    await migrated_db.commit()
    cur = await migrated_db.execute(
        "SELECT status FROM tasks WHERE title = 'new-slug-task'"
    )
    row = await cur.fetchone()
    assert row is not None and row["status"] == "drafting"


@pytest.mark.asyncio
async def test_delete_refuses_default(migrated_db: aiosqlite.Connection) -> None:
    rows = await taxonomy_service.list_by_kind(migrated_db, "task_status")
    default_row = next(r for r in rows if r["is_default"])
    with pytest.raises(Exception) as exc:
        await taxonomy_service.delete(migrated_db, default_row["id"])
    assert "cannot be deleted" in str(exc.value.detail).lower()


@pytest.mark.asyncio
async def test_reorder_persists_new_sort(migrated_db: aiosqlite.Connection) -> None:
    rows = await taxonomy_service.list_by_kind(migrated_db, "task_priority")
    reversed_ids = [r["id"] for r in reversed(rows)]
    new_order = await taxonomy_service.reorder(
        migrated_db, "task_priority", reversed_ids
    )
    assert [r["id"] for r in new_order] == reversed_ids


@pytest.mark.asyncio
async def test_router_round_trip(
    taxonomy_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, _ = taxonomy_app
    resp = client.get("/api/v1/taxonomies/task_status")
    assert resp.status_code == 200
    rows = resp.json()
    assert any(r["slug"] == "todo" and r["display_name"] == "To do" for r in rows)

    # Create then PATCH
    create_resp = client.post(
        "/api/v1/taxonomies",
        json={
            "kind": "task_status",
            "slug": "live",
            "display_name": "Live",
            "sort_order": 60,
        },
    )
    assert create_resp.status_code == 201
    new_id = create_resp.json()["id"]
    patch_resp = client.patch(
        f"/api/v1/taxonomies/{new_id}",
        json={"display_name": "Shipped"},
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["display_name"] == "Shipped"


@pytest.mark.asyncio
async def test_workflow_priority_kind_removed(
    migrated_db: aiosqlite.Connection,
) -> None:
    # Migration 001 drops the unused workflow_priority kind entirely.
    rows = await taxonomy_service.list_by_kind(
        migrated_db, "workflow_priority", include_inactive=True
    )
    assert rows == []


@pytest.mark.asyncio
async def test_lookups_source_from_taxonomy(
    migrated_db: aiosqlite.Connection,
) -> None:
    # The Workflow Labels taxonomy is the single source of truth: get_lookups
    # exposes structured vocab and derives the legacy statuses/colors from it.
    lookups = await settings_service.get_lookups(migrated_db)

    task_statuses = await taxonomy_service.list_by_kind(migrated_db, "task_status")
    expected_slugs = [r["slug"] for r in task_statuses]

    assert lookups["statuses"] == expected_slugs
    assert [e["slug"] for e in lookups["workflow_task_statuses"]] == expected_slugs
    # Renaming a status flows through to the derived lookups.
    todo = next(r for r in task_statuses if r["slug"] == "todo")
    await taxonomy_service.update(migrated_db, todo["id"], {"display_name": "Queued"})
    refreshed = await settings_service.get_lookups(migrated_db)
    queued = next(e for e in refreshed["workflow_task_statuses"] if e["slug"] == "todo")
    assert queued["label"] == "Queued"
    assert "workflow_task_priorities" in refreshed
    assert "workflow_inbox_statuses" in refreshed
