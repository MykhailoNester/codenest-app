"""Tests for the launch presets service and router.

Covers:
- Create and read-back a preset, including a shell-only one.
- Duplicate name returns 409.
- Delete returns 200 / ``ok: true``.
- FK cascade: deleting the referenced project removes the preset.
- POST with a missing project_id, a missing provider_id, no panes, or too
  many panes.
- Read-time ``unresolved`` reporting for missing / disabled providers.

The grid shape (``rows``/``cols``/``provider_id``/``cells``) is gone —
migration 008 dropped those columns and converted every surviving grid row to
a pane list, so the conversion itself is pinned in ``test_migrations``.
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
    LaunchPresetCreate,
    PresetUnresolved,
    ShellPresetPane,
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
    """Build a valid preset payload: one agent pane + one shell pane."""
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
    """The smallest body the API accepts: one agent pane."""
    return {
        "name": name,
        "project_id": project_id,
        "extra_args": "",
        "target": "embedded",
        "profile_id": None,
        "panes": [
            {
                "kind": "agent",
                "provider_id": provider_id,
                "model": None,
                "permission_mode": "",
                "send_prompt": True,
            },
        ],
    }


def _agent_preset(
    name: str, project_id: int, provider_id: int, **kwargs
) -> LaunchPresetCreate:
    """A one-agent-pane `LaunchPresetCreate`, for the service-layer tests."""
    return LaunchPresetCreate(
        name=name,
        project_id=project_id,
        extra_args="",
        target=kwargs.pop("target", "embedded"),
        profile_id=None,
        panes=[AgentPresetPane(provider_id=provider_id)],
        **kwargs,
    )


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

    created = await launch_preset_service.create_preset(
        migrated_db, _agent_preset("Preset A", proj_id, prov_id)
    )
    assert created.id > 0
    assert created.name == "Preset A"
    assert [p.kind for p in created.panes] == ["agent"]
    assert created.split == "cols"  # the default when the body omits it

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

    payload = _agent_preset("Dup Preset", proj_id, prov_id)
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
    with pytest.raises(HTTPException) as exc_info:
        await launch_preset_service.create_preset(
            migrated_db, _agent_preset("Bad Project", 99999, prov_id)
        )
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_create_preset_missing_provider_raises_400(
    migrated_db: aiosqlite.Connection,
):
    """create_preset must raise HTTPException(400) when a pane's provider is absent."""
    from fastapi import HTTPException

    proj_id = await _insert_project(migrated_db, "BadProvProject")
    with pytest.raises(HTTPException) as exc_info:
        await launch_preset_service.create_preset(
            migrated_db, _agent_preset("Bad Provider", proj_id, 99999)
        )
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_delete_preset_removes_row(migrated_db: aiosqlite.Connection):
    """delete_preset must remove the row; subsequent list must not include it."""
    proj_id = await _insert_project(migrated_db, "DelProject")
    prov_id = await _get_claude_id(migrated_db)

    created = await launch_preset_service.create_preset(
        migrated_db, _agent_preset("To Delete", proj_id, prov_id, target="popout")
    )
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
    """Deleting a project must cascade-delete its associated presets.

    The rebuild in migration 008 kept `project_id`'s ON DELETE CASCADE; only
    the provider FK went away.
    """
    proj_id = await _insert_project(migrated_db, "CascadeProject")
    prov_id = await _get_claude_id(migrated_db)

    created = await launch_preset_service.create_preset(
        migrated_db, _agent_preset("Cascade Preset", proj_id, prov_id)
    )

    await migrated_db.execute("DELETE FROM projects WHERE id = ?", (proj_id,))
    await migrated_db.commit()

    cur = await migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM launch_presets WHERE id = ?", (created.id,)
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0, "preset should have been cascade-deleted with its project"


@pytest.mark.asyncio
async def test_deleting_a_provider_leaves_the_preset_standing(
    migrated_db: aiosqlite.Connection,
):
    """A preset survives the deletion of a provider one of its panes names.

    Before 008 the header `provider_id` carried ON DELETE CASCADE, so deleting
    a provider silently deleted every preset built on it. There is no such
    column now: the pane reads back `unresolved` instead.
    """
    proj_id = await _insert_project(migrated_db, "ProviderGoneProject")
    prov_id = await _get_claude_id(migrated_db)

    created = await launch_preset_service.create_preset(
        migrated_db, _agent_preset("Survivor", proj_id, prov_id)
    )

    await migrated_db.execute("DELETE FROM providers WHERE id = ?", (prov_id,))
    await migrated_db.commit()

    preset = await launch_preset_service.get_preset(migrated_db, created.id)
    assert preset.unresolved == [
        PresetUnresolved(pane_index=0, provider_id=prov_id, reason="missing")
    ]


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
    assert data["target"] == "embedded"
    assert len(data["panes"]) == 1
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
# Pane shape (005 — ordered typed pane list; 008 — the only shape there is)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pane_preset_round_trip(test_app):
    """POST an agent+shell pane list and read it back byte-identical."""
    client, db = test_app
    proj_id = await _insert_project(db, "PaneRoundTripProject")
    prov_id = await _get_claude_id(db)

    payload = _pane_payload(proj_id, prov_id, "Agent + shell")
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 201
    data = resp.json()
    assert data["panes"] == payload["panes"]
    assert data["split"] == "cols"

    list_resp = client.get("/api/v1/launch-presets")
    found = next(p for p in list_resp.json() if p["id"] == data["id"])
    assert found["panes"] == payload["panes"]
    assert found["split"] == "cols"


@pytest.mark.asyncio
async def test_shell_only_preset_round_trips(test_app):
    """Three shell panes, no agent, saves and reloads as exactly that.

    Pins the ticket's acceptance criterion 1 — the "at least one agent pane"
    400 was a projection of `provider_id NOT NULL`, which migration 008 removed.
    """
    client, db = test_app
    proj_id = await _insert_project(db, "ShellOnlyProject")

    panes = [
        {"kind": "shell", "shell": "/bin/zsh", "command": "pnpm build"},
        {"kind": "shell", "shell": "/bin/zsh", "command": "tail -f app.log"},
        {"kind": "shell", "shell": "", "command": ""},
    ]
    payload = {
        "name": "build + logs + tail",
        "project_id": proj_id,
        "extra_args": "",
        "target": "embedded",
        "profile_id": None,
        "split": "rows",
        "panes": panes,
    }
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 201, resp.json()
    data = resp.json()
    assert data["panes"] == panes
    assert data["split"] == "rows"
    assert data["unresolved"] == []

    found = next(
        p for p in client.get("/api/v1/launch-presets").json() if p["id"] == data["id"]
    )
    assert found["panes"] == panes
    assert found["split"] == "rows"


@pytest.mark.asyncio
async def test_shell_only_preset_needs_no_provider_at_all(
    migrated_db: aiosqlite.Connection,
):
    """A shell-only preset saves on a DB with zero provider rows."""
    proj_id = await _insert_project(migrated_db, "NoProvidersProject")

    created = await launch_preset_service.create_preset(
        migrated_db,
        LaunchPresetCreate(
            name="Shells only",
            project_id=proj_id,
            extra_args="",
            target="embedded",
            profile_id=None,
            split="grid",
            panes=[ShellPresetPane(command="make watch"), ShellPresetPane()],
        ),
    )
    assert [p.kind for p in created.panes] == ["shell", "shell"]
    assert created.split == "grid"
    assert created.unresolved == []


@pytest.mark.asyncio
async def test_pane_preset_ignores_top_level_provider_id(test_app):
    """A stray top-level provider_id is ignored, never a 500.

    The grid body is gone, so `provider_id` is now simply an unknown key.
    """
    client, db = test_app
    proj_id = await _insert_project(db, "IgnoreTopLevelProject")
    prov_id = await _get_claude_id(db)

    payload = _pane_payload(proj_id, prov_id, "IgnoreTopLevelPreset")
    payload["provider_id"] = 99999
    resp = client.post("/api/v1/launch-presets", json=payload)
    assert resp.status_code == 201
    assert resp.json()["panes"] == payload["panes"]


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
async def test_body_without_panes_is_422(test_app):
    """`panes` is required — a body without it is a 422, not a 500."""
    client, db = test_app
    proj_id = await _insert_project(db, "NoPanesProject")

    resp = client.post(
        "/api/v1/launch-presets",
        json={
            "name": "NoPanesPreset",
            "project_id": proj_id,
            "extra_args": "",
            "target": "embedded",
            "profile_id": None,
        },
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_preset_rejects_empty_pane_list_with_400(
    migrated_db: aiosqlite.Connection,
):
    """An empty pane list is a 400 — including for a direct caller that
    bypassed model validation and handed over ``None``."""
    from fastapi import HTTPException

    proj_id = await _insert_project(migrated_db, "EmptyPanesProject")

    for panes in ([], None):
        payload = LaunchPresetCreate.model_construct(
            name=f"EmptyPanes{panes}",
            project_id=proj_id,
            extra_args="",
            target="embedded",
            profile_id=None,
            panes=panes,
            split=None,
        )
        with pytest.raises(HTTPException) as exc_info:
            await launch_preset_service.create_preset(migrated_db, payload)
        assert exc_info.value.status_code == 400
        assert "at least one pane" in exc_info.value.detail


@pytest.mark.asyncio
async def test_unresolved_reports_missing_provider(migrated_db: aiosqlite.Connection):
    """A pane whose provider was deleted comes back `unresolved` with reason
    'missing', and the preset itself survives."""
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
