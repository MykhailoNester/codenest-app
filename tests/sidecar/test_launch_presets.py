"""Tests for the launch presets service and router.

Covers:
- Create and read-back a preset.
- Duplicate name returns 409.
- Delete returns 200 / ``ok: true``.
- FK cascade: deleting the referenced project removes the preset.
- POST with a missing project_id returns 400.
- POST with a missing provider_id returns 400.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
import aiosqlite
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import launch_presets as presets_router
from app.models.launch import LaunchPresetCreate
from app.services import launch_preset_service

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _insert_project(db: aiosqlite.Connection, name: str = "TestProject") -> int:
    cursor = await db.execute(
        "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, NULL, NULL, 'active')",
        (name,),
    )
    await db.commit()
    assert cursor.lastrowid is not None
    return cursor.lastrowid


async def _get_claude_id(db: aiosqlite.Connection) -> int:
    """Return the id of a test Anthropic-style provider, creating one if needed.

    E0.1: fresh DB has zero seeded providers, so tests must insert their own.
    """
    cur = await db.execute(
        "SELECT id FROM providers WHERE name='test-anthropic' LIMIT 1"
    )
    row = await cur.fetchone()
    if row is not None:
        return row["id"]
    cur = await db.execute(
        "INSERT INTO providers (name, display_name, command_template, is_enabled) "
        "VALUES (?, ?, ?, 1)",
        ("test-anthropic", "Test Anthropic", "claude {extra_args}"),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


def _valid_payload(project_id: int, provider_id: int, name: str = "My Preset") -> dict:
    return {
        "name": name,
        "project_id": project_id,
        "provider_id": provider_id,
        "rows": 2,
        "cols": 2,
        "extra_args": "",
        "target": "embedded",
        "profile_id": None,
    }


# ---------------------------------------------------------------------------
# Test app fixture
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def test_app(migrated_db: aiosqlite.Connection):
    original = db_module._db
    db_module._db = migrated_db

    application = FastAPI()
    application.include_router(presets_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db

    db_module._db = original


# ---------------------------------------------------------------------------
# Service layer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_and_list_preset(migrated_db: aiosqlite.Connection):
    """create_preset must persist a row that list_presets returns."""
    proj_id = await _insert_project(migrated_db)
    prov_id = await _get_claude_id(migrated_db)

    payload = LaunchPresetCreate(
        name="Preset A",
        project_id=proj_id,
        provider_id=prov_id,
        rows=1,
        cols=1,
        extra_args="",
        target="embedded",
        profile_id=None,
    )
    created = await launch_preset_service.create_preset(migrated_db, payload)
    assert created.id > 0
    assert created.name == "Preset A"
    assert created.rows == 1
    assert created.cols == 1

    presets = await launch_preset_service.list_presets(migrated_db)
    assert any(p.id == created.id for p in presets)


@pytest.mark.asyncio
async def test_create_preset_duplicate_name_raises_409(
    migrated_db: aiosqlite.Connection,
):
    """create_preset must raise HTTPException(409) on duplicate name."""
    from fastapi import HTTPException

    proj_id = await _insert_project(migrated_db, "DupProject")
    prov_id = await _get_claude_id(migrated_db)

    payload = LaunchPresetCreate(
        name="Dup Preset",
        project_id=proj_id,
        provider_id=prov_id,
        rows=1,
        cols=1,
        extra_args="",
        target="embedded",
        profile_id=None,
    )
    await launch_preset_service.create_preset(migrated_db, payload)

    with pytest.raises(HTTPException) as exc_info:
        await launch_preset_service.create_preset(migrated_db, payload)
    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_create_preset_missing_project_raises_400(
    migrated_db: aiosqlite.Connection,
):
    """create_preset must raise HTTPException(400) when project_id is absent."""
    from fastapi import HTTPException

    prov_id = await _get_claude_id(migrated_db)
    payload = LaunchPresetCreate(
        name="Bad Project",
        project_id=99999,
        provider_id=prov_id,
        rows=1,
        cols=1,
        extra_args="",
        target="embedded",
        profile_id=None,
    )
    with pytest.raises(HTTPException) as exc_info:
        await launch_preset_service.create_preset(migrated_db, payload)
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_create_preset_missing_provider_raises_400(
    migrated_db: aiosqlite.Connection,
):
    """create_preset must raise HTTPException(400) when provider_id is absent."""
    from fastapi import HTTPException

    proj_id = await _insert_project(migrated_db, "BadProvProject")
    payload = LaunchPresetCreate(
        name="Bad Provider",
        project_id=proj_id,
        provider_id=99999,
        rows=1,
        cols=1,
        extra_args="",
        target="embedded",
        profile_id=None,
    )
    with pytest.raises(HTTPException) as exc_info:
        await launch_preset_service.create_preset(migrated_db, payload)
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_delete_preset_removes_row(migrated_db: aiosqlite.Connection):
    """delete_preset must remove the row; subsequent list must not include it."""
    proj_id = await _insert_project(migrated_db, "DelProject")
    prov_id = await _get_claude_id(migrated_db)

    payload = LaunchPresetCreate(
        name="To Delete",
        project_id=proj_id,
        provider_id=prov_id,
        rows=1,
        cols=1,
        extra_args="",
        target="popout",
        profile_id=None,
    )
    created = await launch_preset_service.create_preset(migrated_db, payload)
    await launch_preset_service.delete_preset(migrated_db, created.id)

    presets = await launch_preset_service.list_presets(migrated_db)
    assert all(p.id != created.id for p in presets)


@pytest.mark.asyncio
async def test_delete_preset_missing_raises_404(migrated_db: aiosqlite.Connection):
    """delete_preset must raise HTTPException(404) for a non-existent id."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await launch_preset_service.delete_preset(migrated_db, 99999)
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_fk_cascade_deletes_preset_on_project_delete(
    migrated_db: aiosqlite.Connection,
):
    """Deleting a project must cascade-delete its associated presets."""
    proj_id = await _insert_project(migrated_db, "CascadeProject")
    prov_id = await _get_claude_id(migrated_db)

    payload = LaunchPresetCreate(
        name="Cascade Preset",
        project_id=proj_id,
        provider_id=prov_id,
        rows=1,
        cols=1,
        extra_args="",
        target="embedded",
        profile_id=None,
    )
    created = await launch_preset_service.create_preset(migrated_db, payload)

    await migrated_db.execute("DELETE FROM projects WHERE id = ?", (proj_id,))
    await migrated_db.commit()

    cur = await migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM launch_presets WHERE id = ?", (created.id,)
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0, "preset should have been cascade-deleted with its project"


# ---------------------------------------------------------------------------
# Router (HTTP) layer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_http_create_preset_returns_201(test_app):
    """POST /api/v1/launch-presets must return 201 with the created object."""
    client, db = test_app
    proj_id = await _insert_project(db, "HttpProject")
    prov_id = await _get_claude_id(db)

    resp = client.post(
        "/api/v1/launch-presets",
        json=_valid_payload(proj_id, prov_id, "HTTP Preset"),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "HTTP Preset"
    assert data["rows"] == 2
    assert data["cols"] == 2
    assert data["target"] == "embedded"
    assert "id" in data
    assert "created_at" in data


@pytest.mark.asyncio
async def test_http_list_presets(test_app):
    """GET /api/v1/launch-presets must return 200 with a list."""
    client, db = test_app
    proj_id = await _insert_project(db, "ListProject")
    prov_id = await _get_claude_id(db)

    client.post("/api/v1/launch-presets", json=_valid_payload(proj_id, prov_id, "P1"))
    client.post("/api/v1/launch-presets", json=_valid_payload(proj_id, prov_id, "P2"))

    resp = client.get("/api/v1/launch-presets")
    assert resp.status_code == 200
    data = resp.json()
    names = {p["name"] for p in data}
    assert "P1" in names
    assert "P2" in names


@pytest.mark.asyncio
async def test_http_create_duplicate_name_returns_409(test_app):
    """POST with a duplicate preset name must return 409."""
    client, db = test_app
    proj_id = await _insert_project(db, "DupHttpProject")
    prov_id = await _get_claude_id(db)

    client.post(
        "/api/v1/launch-presets", json=_valid_payload(proj_id, prov_id, "DupPreset")
    )
    resp = client.post(
        "/api/v1/launch-presets",
        json=_valid_payload(proj_id, prov_id, "DupPreset"),
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_http_delete_preset_returns_200(test_app):
    """DELETE /api/v1/launch-presets/{id} must return 200 {"ok": true}."""
    client, db = test_app
    proj_id = await _insert_project(db, "DelHttpProject")
    prov_id = await _get_claude_id(db)

    create_resp = client.post(
        "/api/v1/launch-presets",
        json=_valid_payload(proj_id, prov_id, "DeleteMe"),
    )
    preset_id = create_resp.json()["id"]

    resp = client.delete(f"/api/v1/launch-presets/{preset_id}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}

    # Verify it's gone
    list_resp = client.get("/api/v1/launch-presets")
    ids = {p["id"] for p in list_resp.json()}
    assert preset_id not in ids


@pytest.mark.asyncio
async def test_http_delete_missing_preset_returns_404(test_app):
    """DELETE with a non-existent id must return 404."""
    client, _ = test_app
    resp = client.delete("/api/v1/launch-presets/99999")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_http_create_missing_project_returns_400(test_app):
    """POST with an unknown project_id must return 400."""
    client, db = test_app
    prov_id = await _get_claude_id(db)
    resp = client.post(
        "/api/v1/launch-presets",
        json=_valid_payload(99999, prov_id, "BadProj"),
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Workspace (cells) branch
# ---------------------------------------------------------------------------


def _workspace_payload(
    project_id: int,
    provider_id: int,
    name: str = "Workspace Preset",
) -> dict:
    """Build a valid workspace-mode preset payload with a 2×2 heterogeneous grid."""
    cells = [
        {
            "row": 0,
            "col": 0,
            "project_id": project_id,
            "provider_id": provider_id,
            "extra_args": "--flag1",
            "profile_id": None,
            "env_overlay": {"MY_VAR": "hello"},
        },
        {
            "row": 0,
            "col": 1,
            "project_id": project_id,
            "provider_id": provider_id,
            "extra_args": "",
            "profile_id": None,
            "env_overlay": {},
        },
        {
            "row": 1,
            "col": 0,
            "project_id": project_id,
            "provider_id": provider_id,
            "extra_args": "--debug",
            "profile_id": None,
            "env_overlay": {"ANOTHER": "world"},
        },
        # (1,1) intentionally omitted — sparse preset
    ]
    return {
        "name": name,
        "project_id": project_id,
        "provider_id": provider_id,
        # rows/cols are ignored when cells is present (derived by service)
        "rows": 1,
        "cols": 1,
        "extra_args": "",
        "target": "embedded",
        "profile_id": None,
        "cells": cells,
    }


@pytest.mark.asyncio
async def test_workspace_create_and_read_back(migrated_db: aiosqlite.Connection):
    """Workspace preset round-trip: create stores cells_json; read deserializes it."""
    from app.models.launch import LaunchCell, LaunchPresetCreate

    proj_id = await _insert_project(migrated_db, "WsProject")
    prov_id = await _get_claude_id(migrated_db)

    cells = [
        LaunchCell(
            row=0, col=0, project_id=proj_id, provider_id=prov_id, extra_args="--a"
        ),
        LaunchCell(
            row=0,
            col=1,
            project_id=proj_id,
            provider_id=prov_id,
            env_overlay={"K": "V"},
        ),
        LaunchCell(row=1, col=0, project_id=proj_id, provider_id=prov_id),
    ]
    payload = LaunchPresetCreate(
        name="WsPreset",
        project_id=proj_id,
        provider_id=prov_id,
        rows=1,  # will be overridden to 2 by validator
        cols=1,  # will be overridden to 2 by validator
        extra_args="",
        target="embedded",
        profile_id=None,
        cells=cells,
    )

    # Validator should derive rows=2, cols=2 from max(row)+1, max(col)+1.
    assert payload.rows == 2
    assert payload.cols == 2

    from app.services import launch_preset_service

    created = await launch_preset_service.create_preset(migrated_db, payload)

    assert created.cells is not None
    assert len(created.cells) == 3
    assert any(
        c.row == 0 and c.col == 0 and c.extra_args == "--a" for c in created.cells
    )
    assert any(
        c.row == 0 and c.col == 1 and c.env_overlay == {"K": "V"} for c in created.cells
    )
    assert created.rows == 2
    assert created.cols == 2

    # Read back via list.
    presets = await launch_preset_service.list_presets(migrated_db)
    found = next((p for p in presets if p.id == created.id), None)
    assert found is not None
    assert found.cells is not None
    assert len(found.cells) == 3


@pytest.mark.asyncio
async def test_workspace_rejects_duplicate_coords(migrated_db: aiosqlite.Connection):
    """LaunchPresetCreate must reject cells with duplicate (row, col) pairs."""
    from pydantic import ValidationError
    from app.models.launch import LaunchCell, LaunchPresetCreate

    proj_id = await _insert_project(migrated_db, "DupCoordsProject")
    prov_id = await _get_claude_id(migrated_db)

    with pytest.raises(ValidationError) as exc_info:
        LaunchPresetCreate(
            name="DupCoords",
            project_id=proj_id,
            provider_id=prov_id,
            rows=1,
            cols=1,
            extra_args="",
            target="embedded",
            profile_id=None,
            cells=[
                LaunchCell(row=0, col=0, project_id=proj_id, provider_id=prov_id),
                LaunchCell(row=0, col=0, project_id=proj_id, provider_id=prov_id),
            ],
        )
    assert "duplicate" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_workspace_rejects_unknown_project_in_cell(
    migrated_db: aiosqlite.Connection,
):
    """create_preset must return 400 when a cell references a non-existent project."""
    from fastapi import HTTPException
    from app.models.launch import LaunchCell, LaunchPresetCreate
    from app.services import launch_preset_service

    proj_id = await _insert_project(migrated_db, "GoodProject")
    prov_id = await _get_claude_id(migrated_db)

    payload = LaunchPresetCreate(
        name="BadCellProject",
        project_id=proj_id,
        provider_id=prov_id,
        rows=1,
        cols=1,
        extra_args="",
        target="embedded",
        profile_id=None,
        cells=[
            LaunchCell(row=0, col=0, project_id=99999, provider_id=prov_id),
        ],
    )

    with pytest.raises(HTTPException) as exc_info:
        await launch_preset_service.create_preset(migrated_db, payload)
    assert exc_info.value.status_code == 400
    assert "project_id" in exc_info.value.detail


@pytest.mark.asyncio
async def test_workspace_http_create_and_read_back(test_app):
    """POST with workspace cells returns the preset including cells on read."""
    client, db = test_app
    proj_id = await _insert_project(db, "WsHttpProject")
    prov_id = await _get_claude_id(db)

    payload = _workspace_payload(proj_id, prov_id, "WsHttpPreset")
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["rows"] == 2  # derived from max(row)=1 → 2
    assert data["cols"] == 2  # derived from max(col)=1 → 2
    assert isinstance(data["cells"], list)
    assert len(data["cells"]) == 3
    # Verify env_overlay round-trip
    cell00 = next((c for c in data["cells"] if c["row"] == 0 and c["col"] == 0), None)
    assert cell00 is not None
    assert cell00["env_overlay"] == {"MY_VAR": "hello"}

    # Re-read via list endpoint
    list_resp = client.get("/api/v1/launch-presets")
    assert list_resp.status_code == 200
    all_presets = list_resp.json()
    found = next((p for p in all_presets if p["name"] == "WsHttpPreset"), None)
    assert found is not None
    assert found["cells"] is not None
    assert len(found["cells"]) == 3


@pytest.mark.asyncio
async def test_workspace_http_duplicate_coords_returns_422(test_app):
    """POST with duplicate (row, col) pairs in cells must return 422 (validation error)."""
    client, db = test_app
    proj_id = await _insert_project(db, "DupCoordsHttpProject")
    prov_id = await _get_claude_id(db)

    payload = {
        "name": "DupCoordsHttp",
        "project_id": proj_id,
        "provider_id": prov_id,
        "rows": 1,
        "cols": 1,
        "extra_args": "",
        "target": "embedded",
        "profile_id": None,
        "cells": [
            {
                "row": 0,
                "col": 0,
                "project_id": proj_id,
                "provider_id": prov_id,
                "extra_args": "",
                "profile_id": None,
                "env_overlay": {},
            },
            {
                "row": 0,
                "col": 0,
                "project_id": proj_id,
                "provider_id": prov_id,
                "extra_args": "",
                "profile_id": None,
                "env_overlay": {},
            },
        ],
    }
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 422
