"""Tests for task labels: the `task_label` taxonomy kind, the
`task_label_assignments` join table, the label service API on
`task_service`, and the four `/api/v1/tasks/{id}/labels` router endpoints.

The `migrated_db` fixture ships with the `Unassigned` project (id 1) from the
baseline seed and zero tasks; every test seeds its own task via `_make_task`.
"""

from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import tasks as tasks_router
from app.services import task_service, taxonomy_service


async def _make_task(db: aiosqlite.Connection, title: str = "t") -> int:
    return await task_service.create_task(db, {"title": title, "project_id": 1})


async def _label_id(db: aiosqlite.Connection, slug: str) -> int:
    rows = await taxonomy_service.list_by_kind(db, "task_label")
    return next(r["id"] for r in rows if r["slug"] == slug)


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


# ---------------------------------------------------------------------------
# Taxonomy-kind wiring
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_task_label_kind_is_accepted(migrated_db: aiosqlite.Connection) -> None:
    """`create(kind="task_label", ...)` must succeed and the row must be
    reachable through `list_by_kind` — the kind is wired, not merely seeded."""
    created = await taxonomy_service.create(
        migrated_db,
        {"kind": "task_label", "slug": "urgent-fix", "display_name": "Urgent fix"},
    )
    assert created["kind"] == "task_label"
    rows = await taxonomy_service.list_by_kind(migrated_db, "task_label")
    assert any(r["slug"] == "urgent-fix" for r in rows)


@pytest.mark.asyncio
async def test_seeded_labels_exist_and_are_not_default(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The five seeded slugs are present with is_default is False, so the user
    can remove them (D4)."""
    rows = await taxonomy_service.list_by_kind(migrated_db, "task_label")
    slugs = {r["slug"] for r in rows}
    assert slugs == {"bug", "feature", "chore", "research", "docs"}
    assert all(r["is_default"] is False for r in rows)


@pytest.mark.asyncio
async def test_seed_uses_no_explicit_ids(migrated_db: aiosqlite.Connection) -> None:
    """A new taxonomy row created after migration gets an id greater than
    every seeded task_label id — 004 claimed no explicit ids that could
    collide on an install with user-created taxonomies (D7)."""
    label_rows = await taxonomy_service.list_by_kind(migrated_db, "task_label")
    max_label_id = max(r["id"] for r in label_rows)

    created = await taxonomy_service.create(
        migrated_db,
        {"kind": "task_status", "slug": "triage", "display_name": "Triage"},
    )
    assert created["id"] > max_label_id


# ---------------------------------------------------------------------------
# set_task_labels — replace-the-whole-set semantics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_labels_replaces_the_whole_set(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Happy path: a second `set_task_labels` call fully replaces the first."""
    bug_id = await _label_id(migrated_db, "bug")
    feature_id = await _label_id(migrated_db, "feature")
    chore_id = await _label_id(migrated_db, "chore")
    tid = await _make_task(migrated_db)

    labels = await task_service.set_task_labels(migrated_db, tid, [bug_id, feature_id])
    assert {label["slug"] for label in labels} == {"bug", "feature"}

    labels = await task_service.set_task_labels(
        migrated_db, tid, [feature_id, chore_id]
    )
    assert {label["slug"] for label in labels} == {"feature", "chore"}

    async with migrated_db.execute(
        "SELECT 1 FROM task_label_assignments WHERE task_id = ? AND label_id = ?",
        (tid, bug_id),
    ) as cur:
        assert await cur.fetchone() is None


@pytest.mark.asyncio
async def test_set_labels_empty_list_clears(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Zero case: an empty list clears every assignment."""
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.set_task_labels(migrated_db, tid, [bug_id])

    labels = await task_service.set_task_labels(migrated_db, tid, [])
    assert labels == []

    async with migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM task_label_assignments WHERE task_id = ?",
        (tid,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0


@pytest.mark.asyncio
async def test_set_labels_rejects_non_label_taxonomy(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Passing a task_priority id must 400 and leave the existing set
    untouched — validate before mutating. Cross-kind tagging is the
    invariant under test."""
    priority_rows = await taxonomy_service.list_by_kind(migrated_db, "task_priority")
    high_id = next(r["id"] for r in priority_rows if r["slug"] == "high")
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.set_task_labels(migrated_db, tid, [bug_id])

    with pytest.raises(HTTPException) as exc:
        await task_service.set_task_labels(migrated_db, tid, [high_id])
    assert exc.value.status_code == 400

    labels = await task_service.list_task_labels(migrated_db, tid)
    assert [label["slug"] for label in labels] == ["bug"]


@pytest.mark.asyncio
async def test_set_labels_rejects_inactive_label(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A deactivated label id must 400 (D-d): the read path hides it, so a
    replace built from the visible set must not be able to newly assign it."""
    bug_id = await _label_id(migrated_db, "bug")
    feature_id = await _label_id(migrated_db, "feature")
    tid = await _make_task(migrated_db)
    await task_service.set_task_labels(migrated_db, tid, [bug_id])

    await taxonomy_service.delete(migrated_db, feature_id)

    with pytest.raises(HTTPException) as exc:
        await task_service.set_task_labels(migrated_db, tid, [feature_id])
    assert exc.value.status_code == 400

    labels = await task_service.list_task_labels(migrated_db, tid)
    assert [label["slug"] for label in labels] == ["bug"]


@pytest.mark.asyncio
async def test_set_labels_preserves_inactive_assignment(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The invariant D-d exists to protect: a replace built from the visible
    set must not delete an assignment to a label that is merely hidden."""
    bug_id = await _label_id(migrated_db, "bug")
    feature_id = await _label_id(migrated_db, "feature")
    tid = await _make_task(migrated_db)

    await task_service.add_task_label(migrated_db, tid, bug_id)
    await taxonomy_service.delete(migrated_db, bug_id)

    await task_service.set_task_labels(migrated_db, tid, [feature_id])

    async with migrated_db.execute(
        "SELECT 1 FROM task_label_assignments WHERE task_id = ? AND label_id = ?",
        (tid, bug_id),
    ) as cur:
        assert await cur.fetchone() is not None

    visible = await task_service.list_task_labels(migrated_db, tid)
    assert [label["slug"] for label in visible] == ["feature"]

    await taxonomy_service.update(migrated_db, bug_id, {"is_active": True})
    visible = await task_service.list_task_labels(migrated_db, tid)
    assert {label["slug"] for label in visible} == {"bug", "feature"}


# ---------------------------------------------------------------------------
# add_task_label / remove_task_label
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_add_label_is_idempotent(migrated_db: aiosqlite.Connection) -> None:
    """Adding the same label twice must not raise (composite PK + INSERT OR
    IGNORE) and must leave exactly one row."""
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.add_task_label(migrated_db, tid, bug_id)
    await task_service.add_task_label(migrated_db, tid, bug_id)

    async with migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM task_label_assignments "
        "WHERE task_id = ? AND label_id = ?",
        (tid, bug_id),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 1


@pytest.mark.asyncio
async def test_add_label_rejects_inactive_and_wrong_kind(
    migrated_db: aiosqlite.Connection,
) -> None:
    tid = await _make_task(migrated_db)
    priority_rows = await taxonomy_service.list_by_kind(migrated_db, "task_priority")
    high_id = next(r["id"] for r in priority_rows if r["slug"] == "high")

    with pytest.raises(HTTPException) as exc:
        await task_service.add_task_label(migrated_db, tid, high_id)
    assert exc.value.status_code == 400

    feature_id = await _label_id(migrated_db, "feature")
    await taxonomy_service.delete(migrated_db, feature_id)
    with pytest.raises(HTTPException) as exc:
        await task_service.add_task_label(migrated_db, tid, feature_id)
    assert exc.value.status_code == 400

    assert await task_service.list_task_labels(migrated_db, tid) == []


@pytest.mark.asyncio
async def test_remove_missing_label_is_a_no_op(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Two clients can race the same untag: removing an unassigned pair is a
    silent success, not a 404."""
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.remove_task_label(migrated_db, tid, bug_id)
    assert await task_service.list_task_labels(migrated_db, tid) == []


@pytest.mark.asyncio
async def test_remove_works_for_an_inactive_label(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A hidden assignment can still be dropped explicitly — remove_task_label
    has no is_active requirement."""
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.add_task_label(migrated_db, tid, bug_id)
    await taxonomy_service.delete(migrated_db, bug_id)

    await task_service.remove_task_label(migrated_db, tid, bug_id)

    async with migrated_db.execute(
        "SELECT 1 FROM task_label_assignments WHERE task_id = ? AND label_id = ?",
        (tid, bug_id),
    ) as cur:
        assert await cur.fetchone() is None


@pytest.mark.asyncio
async def test_label_calls_404_on_unknown_task(
    migrated_db: aiosqlite.Connection,
) -> None:
    missing_task_id = 999_999
    bug_id = await _label_id(migrated_db, "bug")

    with pytest.raises(HTTPException) as exc:
        await task_service.list_task_labels(migrated_db, missing_task_id)
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        await task_service.add_task_label(migrated_db, missing_task_id, bug_id)
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        await task_service.remove_task_label(migrated_db, missing_task_id, bug_id)
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:
        await task_service.set_task_labels(migrated_db, missing_task_id, [bug_id])
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# Deactivation + cascade behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deactivated_label_hidden_but_assignment_survives(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Mirrors deactivated-status behaviour: hidden from payloads, row kept,
    reactivating brings it back."""
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.add_task_label(migrated_db, tid, bug_id)

    await taxonomy_service.delete(migrated_db, bug_id)
    task = await task_service.get_task(migrated_db, tid)
    assert task is not None
    assert task["labels"] == []

    async with migrated_db.execute(
        "SELECT 1 FROM task_label_assignments WHERE task_id = ? AND label_id = ?",
        (tid, bug_id),
    ) as cur:
        assert await cur.fetchone() is not None

    await taxonomy_service.update(migrated_db, bug_id, {"is_active": True})
    task = await task_service.get_task(migrated_db, tid)
    assert task is not None
    assert [label["slug"] for label in task["labels"]] == ["bug"]


@pytest.mark.asyncio
async def test_delete_task_cascades_assignments(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The explicit cascade test the ticket requires: task_service.delete_task
    relies on the FK, not an explicit DELETE."""
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.add_task_label(migrated_db, tid, bug_id)

    await task_service.delete_task(migrated_db, tid)

    async with migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM task_label_assignments WHERE task_id = ?",
        (tid,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0


@pytest.mark.asyncio
async def test_raw_delete_from_tasks_cascades_assignments(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The factory-reset path: a raw DELETE FROM tasks never goes through
    delete_task, so the cascade must fire at the FK level."""
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.add_task_label(migrated_db, tid, bug_id)

    await migrated_db.execute("DELETE FROM tasks WHERE id = ?", (tid,))
    await migrated_db.commit()

    async with migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM task_label_assignments WHERE task_id = ?",
        (tid,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0


@pytest.mark.asyncio
async def test_hard_delete_of_a_label_cascades_assignments(
    migrated_db: aiosqlite.Connection,
) -> None:
    """No orphans when a taxonomies row is hard-deleted — through the API,
    taxonomy_service.delete only ever soft-deletes (is_active=0), so this
    path is exercised only by the factory reset's raw DELETE."""
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.add_task_label(migrated_db, tid, bug_id)

    await migrated_db.execute("DELETE FROM taxonomies WHERE id = ?", (bug_id,))
    await migrated_db.commit()

    async with migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM task_label_assignments WHERE label_id = ?",
        (bug_id,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0


# ---------------------------------------------------------------------------
# Embedding on get_all_tasks / get_task
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_all_tasks_embeds_labels_per_task(
    migrated_db: aiosqlite.Connection,
) -> None:
    bug_id = await _label_id(migrated_db, "bug")
    feature_id = await _label_id(migrated_db, "feature")
    chore_id = await _label_id(migrated_db, "chore")

    t1 = await _make_task(migrated_db, "t1")
    t2 = await _make_task(migrated_db, "t2")
    t3 = await _make_task(migrated_db, "t3")

    await task_service.set_task_labels(migrated_db, t1, [feature_id, bug_id])
    await task_service.set_task_labels(migrated_db, t2, [chore_id])
    # t3 gets no labels.

    tasks = await task_service.get_all_tasks(migrated_db)
    by_id = {task["id"]: task for task in tasks}

    # bug's sort_order (10) precedes feature's (20) regardless of assignment
    # order — the embedded list is always ordered by sort_order, then id.
    assert [label["slug"] for label in by_id[t1]["labels"]] == ["bug", "feature"]
    assert [label["slug"] for label in by_id[t2]["labels"]] == ["chore"]
    assert by_id[t3]["labels"] == []


@pytest.mark.asyncio
async def test_get_all_tasks_empty_returns_empty_list(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Empty-DB case: zero tasks -> [] and no label query is issued (an empty
    IN () would be a SQL syntax error)."""
    assert await task_service._labels_by_task(migrated_db, []) == {}
    assert await task_service.get_all_tasks(migrated_db) == []


@pytest.mark.asyncio
async def test_label_fetch_chunks_large_id_lists(
    migrated_db: aiosqlite.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """D-f: the label id list is chunked below SQLITE_MAX_VARIABLE_NUMBER."""
    monkeypatch.setattr(task_service, "_LABEL_ID_CHUNK", 2)

    bug_id = await _label_id(migrated_db, "bug")
    feature_id = await _label_id(migrated_db, "feature")

    t1 = await _make_task(migrated_db, "t1")
    t2 = await _make_task(migrated_db, "t2")
    t3 = await _make_task(migrated_db, "t3")

    await task_service.add_task_label(migrated_db, t1, bug_id)
    await task_service.add_task_label(migrated_db, t2, feature_id)
    # t3 gets no labels.

    tasks = await task_service.get_all_tasks(migrated_db)
    by_id = {task["id"]: task for task in tasks}

    assert [label["slug"] for label in by_id[t1]["labels"]] == ["bug"]
    assert [label["slug"] for label in by_id[t2]["labels"]] == ["feature"]
    assert by_id[t3]["labels"] == []


@pytest.mark.asyncio
async def test_get_task_embeds_labels_and_returns_none_for_missing(
    migrated_db: aiosqlite.Connection,
) -> None:
    bug_id = await _label_id(migrated_db, "bug")
    tid = await _make_task(migrated_db)
    await task_service.add_task_label(migrated_db, tid, bug_id)

    task = await task_service.get_task(migrated_db, tid)
    assert task is not None
    assert [label["slug"] for label in task["labels"]] == ["bug"]

    assert await task_service.get_task(migrated_db, 999_999) is None


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_router_label_round_trip(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    bug_id = await _label_id(db, "bug")
    feature_id = await _label_id(db, "feature")
    tid = await _make_task(db)

    resp = client.put(
        f"/api/v1/tasks/{tid}/labels", json={"label_ids": [bug_id, feature_id]}
    )
    assert resp.status_code == 200
    assert {label["slug"] for label in resp.json()} == {"bug", "feature"}

    resp = client.get(f"/api/v1/tasks/{tid}/labels")
    assert resp.status_code == 200
    assert {label["slug"] for label in resp.json()} == {"bug", "feature"}

    resp = client.delete(f"/api/v1/tasks/{tid}/labels/{bug_id}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    resp = client.post(f"/api/v1/tasks/{tid}/labels", json={"label_id": bug_id})
    assert resp.status_code == 201
    assert resp.json() == {"ok": True}

    resp = client.get(f"/api/v1/tasks/{tid}/labels")
    assert {label["slug"] for label in resp.json()} == {"bug", "feature"}

    resp = client.delete(f"/api/v1/tasks/{tid}/labels/{bug_id}")
    assert resp.status_code == 200
    resp = client.delete(f"/api/v1/tasks/{tid}/labels/{feature_id}")
    assert resp.status_code == 200

    resp = client.get(f"/api/v1/tasks/{tid}/labels")
    assert resp.json() == []


@pytest.mark.asyncio
async def test_router_rejects_bad_bodies(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    tid = await _make_task(db)

    resp = client.put(f"/api/v1/tasks/{tid}/labels", json={"label_ids": "nope"})
    assert resp.status_code == 400

    resp = client.request(
        "PUT", f"/api/v1/tasks/{tid}/labels", json=["not", "a", "dict"]
    )
    assert resp.status_code == 400

    resp = client.post(f"/api/v1/tasks/{tid}/labels", json={"label_id": 0})
    assert resp.status_code == 400

    # D-g: isinstance(True, int) is True in Python — `true` must not be
    # silently coerced to 1.
    resp = client.post(f"/api/v1/tasks/{tid}/labels", json={"label_id": True})
    assert resp.status_code == 400

    resp = client.post(
        f"/api/v1/tasks/{tid}/labels",
        content=b"not json",
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_router_unknown_task_is_404(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, _ = tasks_app
    missing_task_id = 999_999

    assert client.get(f"/api/v1/tasks/{missing_task_id}/labels").status_code == 404
    assert (
        client.put(
            f"/api/v1/tasks/{missing_task_id}/labels", json={"label_ids": []}
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/tasks/{missing_task_id}/labels", json={"label_id": 1}
        ).status_code
        == 404
    )
    assert client.delete(f"/api/v1/tasks/{missing_task_id}/labels/1").status_code == 404


# ---------------------------------------------------------------------------
# Activity log
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_label_activity_is_logged_once_per_call(
    migrated_db: aiosqlite.Connection,
) -> None:
    """D-e: a bulk `set_task_labels` writes a single `labels_set` row, not one
    per label."""
    bug_id = await _label_id(migrated_db, "bug")
    feature_id = await _label_id(migrated_db, "feature")
    chore_id = await _label_id(migrated_db, "chore")
    tid = await _make_task(migrated_db)

    await task_service.add_task_label(migrated_db, tid, bug_id)
    async with migrated_db.execute(
        "SELECT new_value FROM activity_log "
        "WHERE entity_type = 'task' AND entity_id = ? AND action = 'label_added'",
        (tid,),
    ) as cur:
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["new_value"] == "bug"

    await task_service.remove_task_label(migrated_db, tid, bug_id)
    async with migrated_db.execute(
        "SELECT old_value FROM activity_log "
        "WHERE entity_type = 'task' AND entity_id = ? AND action = 'label_removed'",
        (tid,),
    ) as cur:
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["old_value"] == "bug"

    await task_service.set_task_labels(migrated_db, tid, [bug_id, feature_id, chore_id])
    async with migrated_db.execute(
        "SELECT new_value FROM activity_log "
        "WHERE entity_type = 'task' AND entity_id = ? AND action = 'labels_set'",
        (tid,),
    ) as cur:
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert set(rows[0]["new_value"].split(",")) == {"bug", "feature", "chore"}


# ---------------------------------------------------------------------------
# board_wip_limits (settings_service.get_lookups)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lookups_exposes_board_wip_limits(
    migrated_db: aiosqlite.Connection,
) -> None:
    from app.services import settings_service

    lookups = await settings_service.get_lookups(migrated_db)
    assert lookups["board_wip_limits"] == {}

    await settings_service.upsert_setting(
        migrated_db, "board_wip_limits", '{"in-progress": 3}'
    )
    lookups = await settings_service.get_lookups(migrated_db)
    assert lookups["board_wip_limits"] == {"in-progress": 3}

    await settings_service.upsert_setting(
        migrated_db,
        "board_wip_limits",
        '{"in-progress": 0, "todo": "x", "bad": true, "ok": 2}',
    )
    lookups = await settings_service.get_lookups(migrated_db)
    assert lookups["board_wip_limits"] == {"ok": 2}
