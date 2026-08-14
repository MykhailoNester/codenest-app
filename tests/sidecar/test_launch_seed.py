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

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.models.launch import LaunchOverrideUpsert
from app.routers import launch_seed as seed_router
from app.services import (
    launch_override_service,
    launch_seed_service,
    task_service,
    taxonomy_service,
)

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


async def _assign_labels(
    db: aiosqlite.Connection, task_id: int, slugs: list[str]
) -> None:
    """Resolve label slugs to ids and assign them, replacing any existing set —
    the same pattern as `tests/sidecar/test_task_labels.py:26-29`."""
    rows = await taxonomy_service.list_by_kind(db, "task_label")
    label_ids = [next(r["id"] for r in rows if r["slug"] == slug) for slug in slugs]
    await task_service.set_task_labels(db, task_id, label_ids)


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
# Prompt sections (task #33)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sections_are_only_those_with_data(
    migrated_db: aiosqlite.Connection,
) -> None:
    """A task with a description and a project, no labels, gets exactly
    title + description + project — never an `action` row (no such column
    on tasks) and never an empty row."""
    tid = await _insert_task(migrated_db)

    seed = await launch_seed_service.build_seed(migrated_db, "task", tid)

    assert [s.id for s in seed.sections] == ["title", "description", "project"]


@pytest.mark.asyncio
async def test_no_description_yields_no_description_section(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The guard is truthiness, not `is not None`: both `None` and `""` yield
    no `description` section."""
    for description in (None, ""):
        tid = await _insert_task(migrated_db, description=description)
        seed = await launch_seed_service.build_seed(migrated_db, "task", tid)
        ids = [s.id for s in seed.sections]
        assert "description" not in ids


@pytest.mark.asyncio
async def test_inbox_sections_include_suggested_action(
    migrated_db: aiosqlite.Connection,
) -> None:
    iid = await _insert_inbox(
        migrated_db,
        action_text="repro on staging then file fix",
    )

    seed = await launch_seed_service.build_seed(migrated_db, "inbox", iid)

    assert [s.id for s in seed.sections] == ["title", "description", "action"]
    action_section = next(s for s in seed.sections if s.id == "action")
    assert action_section.text == "Suggested action: repro on staging then file fix"


@pytest.mark.asyncio
async def test_task_labels_section_is_on_by_default(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Task #35 flips D2's `default_on=False` to `True`: the modal that read
    the flat `prompt` string as a launch payload is deleted, so every
    section's default is checked. Pins the display-name choice, in
    `sort_order` (`bug` is 10, `feature` 20)."""
    tid = await _insert_task(migrated_db)
    await _assign_labels(migrated_db, tid, ["bug", "feature"])

    seed = await launch_seed_service.build_seed(migrated_db, "task", tid)

    labels_section = next(s for s in seed.sections if s.id == "labels")
    assert labels_section.default_on is True
    assert labels_section.text == "Labels: Bug, Feature"


@pytest.mark.asyncio
async def test_deactivated_label_is_excluded(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The read path inherits `_labels_by_task`'s `is_active = 1` filter
    rather than reimplementing it."""
    tid = await _insert_task(migrated_db)
    await _assign_labels(migrated_db, tid, ["bug", "feature"])
    rows = await taxonomy_service.list_by_kind(migrated_db, "task_label")
    feature_id = next(r["id"] for r in rows if r["slug"] == "feature")
    await taxonomy_service.delete(migrated_db, feature_id)

    seed = await launch_seed_service.build_seed(migrated_db, "task", tid)

    labels_section = next(s for s in seed.sections if s.id == "labels")
    assert labels_section.text == "Labels: Bug"


@pytest.mark.asyncio
async def test_prompt_is_the_join_of_default_on_sections(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Contract invariant 1."""
    tid = await _insert_task(migrated_db)
    seed = await launch_seed_service.build_seed(migrated_db, "task", tid)
    assert seed.prompt == "\n\n".join(s.text for s in seed.sections if s.default_on)

    iid = await _insert_inbox(migrated_db, action_text="repro on staging")
    seed = await launch_seed_service.build_seed(migrated_db, "inbox", iid)
    assert seed.prompt == "\n\n".join(s.text for s in seed.sections if s.default_on)


@pytest.mark.asyncio
async def test_prompt_includes_labels_for_a_labelled_task(
    migrated_db: aiosqlite.Connection,
) -> None:
    """With Labels now `default_on=True` (task #35), the flat `prompt`
    projection includes the Labels line for a labelled task — the join order
    matches `sections`' own order (title, description, project, labels)."""
    tid = await _insert_task(migrated_db)
    await _assign_labels(migrated_db, tid, ["bug"])

    seed = await launch_seed_service.build_seed(migrated_db, "task", tid)

    assert seed.prompt == (
        f"You are working on task #{tid}: Investigate CI\n\n"
        "logs at /tmp/ci.log\n\n"
        "Project: TestProject (/Users/test/TestProject)\n\n"
        "Labels: Bug"
    )


@pytest.mark.asyncio
async def test_compose_prompt_drops_exactly_the_unchecked_section(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The acceptance criterion: unchecking a section removes exactly that
    text and the total drops by that row's count."""
    tid = await _insert_task(migrated_db)
    seed = await launch_seed_service.build_seed(migrated_db, "task", tid)
    sections = seed.sections
    all_ids = {s.id for s in sections}
    description_section = next(s for s in sections if s.id == "description")

    full = launch_seed_service.compose_prompt(sections, all_ids)
    without_description = launch_seed_service.compose_prompt(
        sections, all_ids - {"description"}
    )

    # `full` minus exactly the description block and the one separator that
    # led into it (the description-to-project separator survives).
    assert without_description == full.replace(f"\n\n{description_section.text}", "", 1)

    total_before = sum(s.tokens for s in sections if s.id in all_ids)
    total_after = sum(s.tokens for s in sections if s.id in (all_ids - {"description"}))
    assert total_before - total_after == description_section.tokens


@pytest.mark.asyncio
async def test_estimate_tokens_is_documented_ceil_of_chars_over_four() -> None:
    assert launch_seed_service.estimate_tokens("") == 0
    assert launch_seed_service.estimate_tokens("abc") == 1
    assert launch_seed_service.estimate_tokens("a" * 8) == 2
    assert launch_seed_service.estimate_tokens("a" * 9) == 3


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


@pytest.mark.asyncio
async def test_http_seed_returns_sections(test_app) -> None:
    """The 200 body's `sections` list has objects with exactly the
    {id, label, text, tokens, default_on} keys, and `prompt` equals the
    join of the `default_on` texts."""
    client, db = test_app
    tid = await _insert_task(db)

    resp = client.get(f"/api/v1/launch/seed?source_kind=task&source_id={tid}")
    assert resp.status_code == 200
    data = resp.json()

    assert isinstance(data["sections"], list)
    assert len(data["sections"]) > 0
    for section in data["sections"]:
        assert set(section.keys()) == {"id", "label", "text", "tokens", "default_on"}

    assert data["prompt"] == "\n\n".join(
        s["text"] for s in data["sections"] if s["default_on"]
    )
