"""Tests for the providers service and router.

Covers:
- Fresh DB ships with zero seeded providers (E0.1 clean-slate requirement).
- Disabled rows are excluded by default and included via ``include_disabled``.
- ``GET /api/v1/providers?include_disabled=true`` returns all rows.
- ``get_provider`` raises 404 for an unknown id.
- Migration 024: models_json / default_model columns are present.
- set_provider_models replace semantics, idempotency, and error cases.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
import aiosqlite
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import providers as providers_router
from app.services import provider_service

# ---------------------------------------------------------------------------
# Test app fixture
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def test_app(migrated_db: aiosqlite.Connection):
    """FastAPI test app wired to the isolated migrated database."""
    original = db_module._db
    db_module._db = migrated_db

    application = FastAPI()
    application.include_router(providers_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db

    db_module._db = original


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _insert_provider(
    db: aiosqlite.Connection,
    name: str = "test-anthropic",
    is_enabled: int = 1,
) -> int:
    """Insert a minimal Anthropic-style provider row and return its id."""
    cur = await db.execute(
        "INSERT INTO providers (name, display_name, command_template, is_enabled) "
        "VALUES (?, ?, ?, ?)",
        (name, name.replace("-", " ").title(), "claude {extra_args}", is_enabled),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


# ---------------------------------------------------------------------------
# Clean-slate assertion (E0.1)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clean_slate_zero_providers(migrated_db: aiosqlite.Connection):
    """E0.1 decision: fresh DB must ship with zero seeded provider rows."""
    providers = await provider_service.list_providers(migrated_db, only_enabled=False)
    assert providers == [], (
        f"expected empty providers list on fresh DB, got {[p.name for p in providers]}"
    )


# ---------------------------------------------------------------------------
# Service layer — list / get
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_providers_returns_inserted_row(migrated_db: aiosqlite.Connection):
    """list_providers must return rows that were explicitly inserted."""
    await _insert_provider(migrated_db, "my-provider")
    providers = await provider_service.list_providers(migrated_db)
    names = {p.name for p in providers}
    assert "my-provider" in names


@pytest.mark.asyncio
async def test_list_providers_omits_disabled(migrated_db: aiosqlite.Connection):
    """Disabled providers must not appear in the default list."""
    await _insert_provider(migrated_db, "enabled-prov", is_enabled=1)
    await _insert_provider(migrated_db, "disabled-prov", is_enabled=0)

    providers = await provider_service.list_providers(migrated_db)
    names = {p.name for p in providers}
    assert "enabled-prov" in names
    assert "disabled-prov" not in names


@pytest.mark.asyncio
async def test_list_providers_include_disabled(migrated_db: aiosqlite.Connection):
    """only_enabled=False must return all providers including disabled ones."""
    await _insert_provider(migrated_db, "active-prov", is_enabled=1)
    await _insert_provider(migrated_db, "aider-prov", is_enabled=0)

    providers = await provider_service.list_providers(migrated_db, only_enabled=False)
    names = {p.name for p in providers}
    assert "active-prov" in names
    assert "aider-prov" in names


@pytest.mark.asyncio
async def test_get_provider_returns_404_for_unknown(migrated_db: aiosqlite.Connection):
    """get_provider must raise HTTPException(404) for a missing id."""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await provider_service.get_provider(migrated_db, 9999)
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_get_provider_returns_correct_row(migrated_db: aiosqlite.Connection):
    """get_provider must return the correct provider for a valid id."""
    pid = await _insert_provider(migrated_db, "lookup-prov")
    provider = await provider_service.get_provider(migrated_db, pid)
    assert provider.name == "lookup-prov"


# ---------------------------------------------------------------------------
# Router (HTTP) layer
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_http_list_providers_default(test_app):
    """GET /api/v1/providers must return 200 with only enabled providers."""
    client, db = test_app
    await _insert_provider(db, "http-prov-enabled")
    resp = client.get("/api/v1/providers")
    assert resp.status_code == 200
    data = resp.json()
    names = {p["name"] for p in data}
    assert "http-prov-enabled" in names
    assert all(p["is_enabled"] for p in data)


@pytest.mark.asyncio
async def test_http_list_providers_include_disabled(test_app):
    """GET /api/v1/providers?include_disabled=true must include disabled rows."""
    client, db = test_app
    await _insert_provider(db, "enabled-http-prov", is_enabled=1)
    await db.execute(
        "INSERT INTO providers (name, display_name, command_template, is_enabled) "
        "VALUES (?, ?, ?, 0)",
        ("disabled-http-prov", "Disabled", "cmd"),
    )
    await db.commit()

    resp = client.get("/api/v1/providers?include_disabled=true")
    assert resp.status_code == 200
    data = resp.json()
    names = {p["name"] for p in data}
    assert "disabled-http-prov" in names
    assert "enabled-http-prov" in names


@pytest.mark.asyncio
async def test_http_list_providers_default_omits_disabled(test_app):
    """GET /api/v1/providers must not return disabled rows by default."""
    client, db = test_app
    await db.execute(
        "INSERT INTO providers (name, display_name, command_template, is_enabled) "
        "VALUES (?, ?, ?, 0)",
        ("hidden-prov", "Hidden", "cmd"),
    )
    await db.commit()

    resp = client.get("/api/v1/providers")
    assert resp.status_code == 200
    data = resp.json()
    names = {p["name"] for p in data}
    assert "hidden-prov" not in names


# ---------------------------------------------------------------------------
# Migration 024 — models_json / default_model columns present
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_providers_table_has_models_json_and_default_model(
    migrated_db: aiosqlite.Connection,
):
    """Migration 024 columns must be present in the schema."""
    cur = await migrated_db.execute("PRAGMA table_info(providers)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    assert "models_json" in col_names, "models_json column missing from providers"
    assert "default_model" in col_names, "default_model column missing from providers"


@pytest.mark.asyncio
async def test_list_providers_fallback_on_corrupt_models_json(
    migrated_db: aiosqlite.Connection,
):
    """Corrupt models_json must fall back to ['default']."""
    await migrated_db.execute(
        "INSERT INTO providers (name, display_name, command_template, models_json, is_enabled) "
        "VALUES (?, ?, ?, ?, 1)",
        ("bad-json-prov", "Bad JSON", "cmd", "NOT JSON AT ALL"),
    )
    await migrated_db.commit()

    providers = await provider_service.list_providers(migrated_db, only_enabled=False)
    bad = next((p for p in providers if p.name == "bad-json-prov"), None)
    assert bad is not None
    assert bad.models == ["default"]


# ---------------------------------------------------------------------------
# set_provider_models — onboarding 3-tier replace (idempotent)
# ---------------------------------------------------------------------------


_THREE_TIERS = [
    {"model_name": "claude-opus-4-8", "display_name": "Opus", "is_default": True},
    {"model_name": "claude-sonnet-4-6", "display_name": "Sonnet"},
    {"model_name": "claude-haiku-4-5-20251001", "display_name": "Haiku"},
]


@pytest.mark.asyncio
async def test_set_provider_models_replaces_with_three_tiers(
    migrated_db: aiosqlite.Connection,
):
    pid = await _insert_provider(migrated_db, "claude-work-models")
    result = await provider_service.set_provider_models(migrated_db, pid, _THREE_TIERS)
    assert [m.model_name for m in result] == [
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ]
    defaults = [m for m in result if m.is_default]
    assert len(defaults) == 1 and defaults[0].model_name == "claude-opus-4-8"


@pytest.mark.asyncio
async def test_set_provider_models_is_idempotent_and_reassigns_default(
    migrated_db: aiosqlite.Connection,
):
    pid = await _insert_provider(migrated_db, "claude-idem-models")
    await provider_service.set_provider_models(migrated_db, pid, _THREE_TIERS)
    # Re-run with Sonnet as default — no duplicates, default moves.
    rerun = await provider_service.set_provider_models(
        migrated_db,
        pid,
        [
            {"model_name": "claude-opus-4-8", "display_name": "Opus"},
            {
                "model_name": "claude-sonnet-4-6",
                "display_name": "Sonnet",
                "is_default": True,
            },
            {"model_name": "claude-haiku-4-5-20251001", "display_name": "Haiku"},
        ],
    )
    assert len(rerun) == 3  # replaced, not appended
    [default] = [m for m in rerun if m.is_default]
    assert default.model_name == "claude-sonnet-4-6"


@pytest.mark.asyncio
async def test_set_provider_models_defaults_to_first_when_none_flagged(
    migrated_db: aiosqlite.Connection,
):
    pid = await _insert_provider(migrated_db, "claude-first-default")
    result = await provider_service.set_provider_models(
        migrated_db,
        pid,
        [
            {"model_name": "claude-opus-4-8"},
            {"model_name": "claude-sonnet-4-6"},
        ],
    )
    assert result[0].is_default and not result[1].is_default
    # display_name falls back to model_name.
    assert result[0].display_name == "claude-opus-4-8"


@pytest.mark.asyncio
async def test_set_provider_models_rejects_multiple_defaults(
    migrated_db: aiosqlite.Connection,
):
    from fastapi import HTTPException

    pid = await _insert_provider(migrated_db, "claude-multi-default")
    with pytest.raises(HTTPException) as exc:
        await provider_service.set_provider_models(
            migrated_db,
            pid,
            [
                {"model_name": "a", "is_default": True},
                {"model_name": "b", "is_default": True},
            ],
        )
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_set_provider_models_rejects_blank_model_name(
    migrated_db: aiosqlite.Connection,
):
    from fastapi import HTTPException

    pid = await _insert_provider(migrated_db, "claude-blank-model")
    with pytest.raises(HTTPException) as exc:
        await provider_service.set_provider_models(
            migrated_db, pid, [{"model_name": "  "}]
        )
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_set_provider_models_rejects_duplicate_in_set(
    migrated_db: aiosqlite.Connection,
):
    from fastapi import HTTPException

    pid = await _insert_provider(migrated_db, "claude-dup-model")
    with pytest.raises(HTTPException) as exc:
        await provider_service.set_provider_models(
            migrated_db,
            pid,
            [{"model_name": "dup"}, {"model_name": "dup"}],
        )
    assert exc.value.status_code == 400


@pytest.mark.asyncio
async def test_set_provider_models_is_atomic_on_cross_provider_collision(
    migrated_db: aiosqlite.Connection,
):
    """A model name owned by another provider must 409 AND leave prior set intact."""
    from fastapi import HTTPException

    # Create two providers; assign a model to the second one first.
    pid_a = await _insert_provider(migrated_db, "claude-atomic-a")
    pid_b = await _insert_provider(migrated_db, "claude-atomic-b")

    await provider_service.set_provider_models(
        migrated_db,
        pid_b,
        [{"model_name": "gpt-4o", "is_default": True}],
    )

    # Set initial models on pid_a.
    await provider_service.set_provider_models(
        migrated_db,
        pid_a,
        [{"model_name": "claude-sonnet-4-6", "is_default": True}],
    )
    before_a = [
        m.model_name
        for m in await provider_service.list_models(
            migrated_db, pid_a, only_enabled=False
        )
    ]
    assert before_a  # has models now

    with pytest.raises(HTTPException) as exc:
        await provider_service.set_provider_models(
            migrated_db,
            pid_a,
            [
                {"model_name": "claude-opus-4-8", "is_default": True},
                {"model_name": "gpt-4o"},  # owned by pid_b
            ],
        )
    assert exc.value.status_code == 409
    after_a = [
        m.model_name
        for m in await provider_service.list_models(
            migrated_db, pid_a, only_enabled=False
        )
    ]
    assert after_a == before_a  # rolled back — not truncated


@pytest.mark.asyncio
async def test_http_put_provider_models_round_trip(test_app):
    client, db = test_app
    pid = await _insert_provider(db, "http-models-prov")
    resp = client.put(f"/api/v1/providers/{pid}/models", json={"models": _THREE_TIERS})
    assert resp.status_code == 200
    data = resp.json()
    assert [m["model_name"] for m in data] == [
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
    ]
    assert sum(1 for m in data if m["is_default"]) == 1


@pytest.mark.asyncio
async def test_http_put_provider_models_rejects_empty(test_app):
    client, db = test_app
    pid = await _insert_provider(db, "http-empty-models-prov")
    resp = client.put(f"/api/v1/providers/{pid}/models", json={"models": []})
    assert resp.status_code == 400
