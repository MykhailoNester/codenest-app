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

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.models.launch import (
    AgentPresetPane,
    LaunchCell,
    LaunchPresetCreate,
    PresetUnresolved,
)
from app.routers import launch_presets as presets_router
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


async def _insert_provider(
    db: aiosqlite.Connection, name: str, is_enabled: int = 1
) -> int:
    """Insert a fresh, uniquely-named provider row and return its id."""
    cur = await db.execute(
        "INSERT INTO providers (name, display_name, command_template, is_enabled) "
        "VALUES (?, ?, ?, ?)",
        (name, name.title(), "claude {extra_args}", is_enabled),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


def _pane_payload(
    project_id: int,
    provider_id: int,
    name: str = "Pane Preset",
    split: str = "cols",
    panes: list[dict] | None = None,
) -> dict:
    """Build a valid pane-shape preset payload: one agent pane + one shell pane."""
    return {
        "name": name,
        "project_id": project_id,
        "extra_args": "",
        "target": "embedded",
        "profile_id": None,
        "split": split,
        "panes": panes
        if panes is not None
        else [
            {
                "kind": "agent",
                "provider_id": provider_id,
                "model": "opus",
                "permission_mode": "acceptEdits",
                "send_prompt": True,
            },
            {"kind": "shell", "shell": "/bin/zsh", "command": "npm run dev"},
        ],
    }


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


# ---------------------------------------------------------------------------
# Pane shape (migration 005 — ordered typed pane list)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pane_preset_round_trip(test_app):
    """POST an agent+shell pane list and read it back byte-identical.

    Pins acceptance criterion 1: a preset saved from an "agent + shell"
    composition reloads as exactly that composition.
    """
    client, db = test_app
    proj_id = await _insert_project(db, "PaneRoundTripProject")
    prov_id = await _get_claude_id(db)

    payload = _pane_payload(proj_id, prov_id, "Agent + shell")
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["panes"] == payload["panes"]
    assert data["split"] == "cols"
    assert data["shape"] == "panes"

    list_resp = client.get("/api/v1/launch-presets")
    found = next(p for p in list_resp.json() if p["id"] == data["id"])
    assert found["panes"] == payload["panes"]
    assert found["split"] == "cols"
    assert found["shape"] == "panes"


@pytest.mark.asyncio
async def test_pane_preset_writes_legacy_projection(test_app):
    """A 2-pane 'cols' preset projects onto rows=1, cols=2, header provider (D2)."""
    client, db = test_app
    proj_id = await _insert_project(db, "LegacyProjectionProject")
    prov_id = await _get_claude_id(db)

    payload = _pane_payload(proj_id, prov_id, "LegacyProjectionPreset")
    resp = client.post("/api/v1/launch-presets", json=payload)
    preset_id = resp.json()["id"]

    cur = await db.execute(
        "SELECT rows, cols, provider_id FROM launch_presets WHERE id = ?",
        (preset_id,),
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["rows"] == 1
    assert row["cols"] == 2
    assert row["provider_id"] == prov_id


@pytest.mark.asyncio
async def test_pane_preset_ignores_top_level_provider_id(test_app):
    """A bogus top-level provider_id sent alongside panes is ignored, never a 500."""
    client, db = test_app
    proj_id = await _insert_project(db, "IgnoreTopLevelProject")
    prov_id = await _get_claude_id(db)

    payload = _pane_payload(proj_id, prov_id, "IgnoreTopLevelPreset")
    payload["provider_id"] = 99999
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 201

    cur = await db.execute(
        "SELECT provider_id FROM launch_presets WHERE id = ?", (resp.json()["id"],)
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["provider_id"] == prov_id


@pytest.mark.asyncio
async def test_pane_preset_grid_split_projection_is_clamped(test_app):
    """8 panes with split='grid' land inside the rows/cols 1..4 CHECK."""
    client, db = test_app
    proj_id = await _insert_project(db, "GridSplitClampProject")
    prov_id = await _get_claude_id(db)

    panes = [
        {
            "kind": "agent",
            "provider_id": prov_id,
            "model": None,
            "permission_mode": "",
            "send_prompt": True,
        },
    ] + [{"kind": "shell", "shell": "", "command": ""} for _ in range(7)]
    payload = _pane_payload(
        proj_id, prov_id, "GridSplitClampPreset", split="grid", panes=panes
    )
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert 1 <= data["rows"] <= 4
    assert 1 <= data["cols"] <= 4


@pytest.mark.asyncio
async def test_pane_preset_rejects_shell_only(test_app):
    """A pane list with no agent pane is a 400 (D3)."""
    client, db = test_app
    proj_id = await _insert_project(db, "ShellOnlyProject")
    prov_id = await _get_claude_id(db)

    payload = _pane_payload(
        proj_id,
        prov_id,
        "ShellOnlyPreset",
        panes=[{"kind": "shell", "shell": "", "command": ""}],
    )
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 400
    assert "agent pane" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_pane_preset_rejects_unknown_provider(test_app):
    """An agent pane referencing an unknown provider is a 400 naming the index."""
    client, db = test_app
    proj_id = await _insert_project(db, "UnknownProviderProject")
    prov_id = await _get_claude_id(db)

    payload = _pane_payload(
        proj_id,
        prov_id,
        "UnknownProviderPreset",
        panes=[
            {
                "kind": "agent",
                "provider_id": prov_id,
                "model": None,
                "permission_mode": "",
                "send_prompt": True,
            },
            {
                "kind": "agent",
                "provider_id": 99999,
                "model": None,
                "permission_mode": "",
                "send_prompt": True,
            },
        ],
    )
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert "pane 1" in detail
    assert "99999" in detail


@pytest.mark.asyncio
async def test_pane_preset_rejects_cells_and_panes_together(test_app):
    """panes and cells are mutually exclusive — 400."""
    client, db = test_app
    proj_id = await _insert_project(db, "PanesAndCellsProject")
    prov_id = await _get_claude_id(db)

    payload = _pane_payload(proj_id, prov_id, "PanesAndCellsPreset")
    payload["cells"] = [
        {
            "row": 0,
            "col": 0,
            "project_id": proj_id,
            "provider_id": prov_id,
            "extra_args": "",
            "profile_id": None,
            "env_overlay": {},
        },
    ]
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 400
    assert "mutually exclusive" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_pane_preset_rejects_over_cap(test_app):
    """More than 8 panes is a 400."""
    client, db = test_app
    proj_id = await _insert_project(db, "OverCapProject")
    prov_id = await _get_claude_id(db)

    panes = [
        {
            "kind": "agent",
            "provider_id": prov_id,
            "model": None,
            "permission_mode": "",
            "send_prompt": True,
        },
    ] + [{"kind": "shell", "shell": "", "command": ""} for _ in range(8)]
    payload = _pane_payload(proj_id, prov_id, "OverCapPreset", panes=panes)
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 400
    assert "exceeds the maximum" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_grid_preset_without_provider_id_is_422(test_app):
    """A grid-shape body (rows/cols, no panes) missing provider_id is a 422, not a 500 (D11)."""
    client, db = test_app
    proj_id = await _insert_project(db, "NoProviderIdProject")

    resp = client.post(
        "/api/v1/launch-presets",
        json={
            "name": "NoProviderIdPreset",
            "project_id": proj_id,
            "rows": 1,
            "cols": 1,
            "extra_args": "",
            "target": "embedded",
            "profile_id": None,
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_grid_preset_with_cells_may_omit_rows_cols(test_app):
    """A grid body with cells + provider_id but no rows/cols is accepted (derived)."""
    client, db = test_app
    proj_id = await _insert_project(db, "CellsNoRowsColsProject")
    prov_id = await _get_claude_id(db)

    resp = client.post(
        "/api/v1/launch-presets",
        json={
            "name": "CellsNoRowsColsPreset",
            "project_id": proj_id,
            "provider_id": prov_id,
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
                    "row": 1,
                    "col": 1,
                    "project_id": proj_id,
                    "provider_id": prov_id,
                    "extra_args": "",
                    "profile_id": None,
                    "env_overlay": {},
                },
            ],
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["rows"] == 2
    assert data["cols"] == 2


@pytest.mark.asyncio
async def test_create_preset_rejects_unvalidated_grid_payload_with_422(
    migrated_db: aiosqlite.Connection,
):
    """A direct (non-HTTP) caller that bypasses model validation still gets a
    422 from the service's own gate, never an AssertionError or IntegrityError.

    Pins D11's "explicit gate, not an assert" — an assert would surface as
    AssertionError here instead.
    """
    from fastapi import HTTPException

    proj_id = await _insert_project(migrated_db, "UnvalidatedGridProject")

    payload = LaunchPresetCreate.model_construct(
        name="UnvalidatedGridPreset",
        project_id=proj_id,
        extra_args="",
        target="embedded",
        profile_id=None,
        provider_id=None,
        rows=None,
        cols=None,
        cells=None,
        panes=None,
        split=None,
    )
    with pytest.raises(HTTPException) as exc_info:
        await launch_preset_service.create_preset(migrated_db, payload)
    assert exc_info.value.status_code == 422


@pytest.mark.asyncio
async def test_legacy_grid_preset_reads_as_panes(migrated_db: aiosqlite.Connection):
    """A pre-migration grid preset (no cells_json) reads as N agent panes on the
    header provider. Pins acceptance criterion 2.
    """
    proj_id = await _insert_project(migrated_db, "LegacyGridProject")
    prov_id = await _get_claude_id(migrated_db)

    await migrated_db.execute(
        """INSERT INTO launch_presets
           (name, project_id, provider_id, rows, cols, extra_args, target, profile_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        ("LegacyGridPreset", proj_id, prov_id, 2, 2, "", "embedded", None),
    )
    await migrated_db.commit()
    cur = await migrated_db.execute(
        "SELECT id FROM launch_presets WHERE name = 'LegacyGridPreset'"
    )
    row = await cur.fetchone()
    assert row is not None
    preset_id = row["id"]

    preset = await launch_preset_service.get_preset(migrated_db, preset_id)
    assert len(preset.panes) == 4
    assert all(p.kind == "agent" and p.provider_id == prov_id for p in preset.panes)
    assert preset.split == "grid"
    assert preset.shape == "grid"
    assert preset.cells is None
    assert preset.rows == 2
    assert preset.cols == 2


@pytest.mark.asyncio
async def test_legacy_cells_preset_reads_as_panes_in_row_major_order(
    migrated_db: aiosqlite.Connection,
):
    """A sparse 2x2 legacy preset reads as 4 panes in row-major order, each
    per-cell provider when set, else the header provider (D4)."""
    proj_id = await _insert_project(migrated_db, "RowMajorProject")
    prov_a = await _get_claude_id(migrated_db)
    prov_b = await _insert_provider(migrated_db, "test-row-major-second")

    payload = LaunchPresetCreate(
        name="RowMajorPreset",
        project_id=proj_id,
        provider_id=prov_a,
        rows=1,
        cols=1,
        extra_args="",
        target="embedded",
        profile_id=None,
        cells=[
            LaunchCell(row=0, col=0, project_id=proj_id, provider_id=prov_a),
            LaunchCell(row=0, col=1, project_id=proj_id, provider_id=prov_b),
            LaunchCell(row=1, col=0, project_id=proj_id, provider_id=prov_a),
            # (1,1) intentionally omitted — falls back to the header provider.
        ],
    )
    created = await launch_preset_service.create_preset(migrated_db, payload)
    assert created.rows == 2
    assert created.cols == 2

    assert [p.provider_id for p in created.panes] == [prov_a, prov_b, prov_a, prov_a]
    assert all(p.kind == "agent" for p in created.panes)


@pytest.mark.asyncio
async def test_unresolved_reports_missing_provider(migrated_db: aiosqlite.Connection):
    """A pane whose provider was deleted comes back `unresolved` with reason
    'missing', and the preset itself survives. Pins acceptance criterion 3."""
    proj_id = await _insert_project(migrated_db, "MissingProviderProject")
    prov_a = await _get_claude_id(migrated_db)
    prov_b = await _insert_provider(migrated_db, "test-missing-second")

    payload = LaunchPresetCreate(
        name="MissingProviderPreset",
        project_id=proj_id,
        extra_args="",
        target="embedded",
        profile_id=None,
        split="cols",
        panes=[
            AgentPresetPane(provider_id=prov_a),
            AgentPresetPane(provider_id=prov_b),
        ],
    )
    created = await launch_preset_service.create_preset(migrated_db, payload)

    await migrated_db.execute("DELETE FROM providers WHERE id = ?", (prov_b,))
    await migrated_db.commit()

    preset = await launch_preset_service.get_preset(migrated_db, created.id)
    assert preset.unresolved == [
        PresetUnresolved(pane_index=1, provider_id=prov_b, reason="missing")
    ]


@pytest.mark.asyncio
async def test_unresolved_reports_disabled_provider(
    migrated_db: aiosqlite.Connection,
):
    """A pane whose provider was disabled comes back `unresolved` with reason
    'disabled'."""
    proj_id = await _insert_project(migrated_db, "DisabledProviderProject")
    prov_a = await _get_claude_id(migrated_db)
    prov_b = await _insert_provider(migrated_db, "test-disabled-second")

    payload = LaunchPresetCreate(
        name="DisabledProviderPreset",
        project_id=proj_id,
        extra_args="",
        target="embedded",
        profile_id=None,
        split="cols",
        panes=[
            AgentPresetPane(provider_id=prov_a),
            AgentPresetPane(provider_id=prov_b),
        ],
    )
    created = await launch_preset_service.create_preset(migrated_db, payload)

    await migrated_db.execute(
        "UPDATE providers SET is_enabled = 0 WHERE id = ?", (prov_b,)
    )
    await migrated_db.commit()

    preset = await launch_preset_service.get_preset(migrated_db, created.id)
    assert preset.unresolved == [
        PresetUnresolved(pane_index=1, provider_id=prov_b, reason="disabled")
    ]


@pytest.mark.asyncio
async def test_list_presets_resolves_every_row_from_one_provider_snapshot(
    migrated_db: aiosqlite.Connection,
):
    """list_presets applies one provider snapshot per row, not per pane —
    three presets with three different resolution states must all be correct."""
    proj_id = await _insert_project(migrated_db, "SnapshotProject")
    prov_good = await _get_claude_id(migrated_db)
    prov_missing = await _insert_provider(migrated_db, "test-snapshot-missing")
    prov_disabled = await _insert_provider(migrated_db, "test-snapshot-disabled")

    good = await launch_preset_service.create_preset(
        migrated_db,
        LaunchPresetCreate(
            name="SnapshotGood",
            project_id=proj_id,
            extra_args="",
            target="embedded",
            profile_id=None,
            split="cols",
            panes=[AgentPresetPane(provider_id=prov_good)],
        ),
    )
    with_missing = await launch_preset_service.create_preset(
        migrated_db,
        LaunchPresetCreate(
            name="SnapshotMissing",
            project_id=proj_id,
            extra_args="",
            target="embedded",
            profile_id=None,
            split="cols",
            panes=[
                AgentPresetPane(provider_id=prov_good),
                AgentPresetPane(provider_id=prov_missing),
            ],
        ),
    )
    with_disabled = await launch_preset_service.create_preset(
        migrated_db,
        LaunchPresetCreate(
            name="SnapshotDisabled",
            project_id=proj_id,
            extra_args="",
            target="embedded",
            profile_id=None,
            split="cols",
            panes=[
                AgentPresetPane(provider_id=prov_good),
                AgentPresetPane(provider_id=prov_disabled),
            ],
        ),
    )

    await migrated_db.execute("DELETE FROM providers WHERE id = ?", (prov_missing,))
    await migrated_db.execute(
        "UPDATE providers SET is_enabled = 0 WHERE id = ?", (prov_disabled,)
    )
    await migrated_db.commit()

    presets = {p.id: p for p in await launch_preset_service.list_presets(migrated_db)}
    assert presets[good.id].unresolved == []
    assert presets[with_missing.id].unresolved == [
        PresetUnresolved(pane_index=1, provider_id=prov_missing, reason="missing")
    ]
    assert presets[with_disabled.id].unresolved == [
        PresetUnresolved(pane_index=1, provider_id=prov_disabled, reason="disabled")
    ]
