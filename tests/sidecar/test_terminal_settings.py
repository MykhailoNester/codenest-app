"""Tests for terminal.* settings validation (section 18.2).

Covers the typed domain validation in settings_service._validate_terminal_setting
via the HTTP layer using the FastAPI test client.
"""

from __future__ import annotations

import json

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import settings as settings_router


@pytest_asyncio.fixture
async def test_app(migrated_db: aiosqlite.Connection):
    """FastAPI test client wired to the isolated migrated database."""
    original = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(settings_router.router)
    with TestClient(application, raise_server_exceptions=True) as client:
        yield client, migrated_db
    db_module._db = original


def _put(client: TestClient, key: str, value: object):
    return client.put(
        f"/api/v1/settings/{key}",
        json={"value_json": json.dumps(value)},
    )


# ─── terminal.font_size ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_font_size_valid(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.font_size", 14)
    assert resp.status_code == 200
    data = resp.json()
    assert json.loads(data["value_json"]) == 14


@pytest.mark.asyncio
async def test_font_size_min_boundary(test_app) -> None:
    client, _ = test_app
    assert _put(client, "terminal.font_size", 9).status_code == 200


@pytest.mark.asyncio
async def test_font_size_max_boundary(test_app) -> None:
    client, _ = test_app
    assert _put(client, "terminal.font_size", 24).status_code == 200


@pytest.mark.asyncio
async def test_font_size_too_small(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.font_size", 8)
    assert resp.status_code == 422
    assert "9" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_font_size_too_large(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.font_size", 25)
    assert resp.status_code == 422
    assert "24" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_font_size_not_a_number(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.font_size", "big")
    assert resp.status_code == 422


# ─── terminal.scrollback ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_scrollback_valid(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.scrollback", 10000)
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_scrollback_min_boundary(test_app) -> None:
    client, _ = test_app
    assert _put(client, "terminal.scrollback", 1000).status_code == 200


@pytest.mark.asyncio
async def test_scrollback_max_boundary(test_app) -> None:
    client, _ = test_app
    assert _put(client, "terminal.scrollback", 100000).status_code == 200


@pytest.mark.asyncio
async def test_scrollback_too_small(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.scrollback", 999)
    assert resp.status_code == 422
    assert "1000" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_scrollback_too_large(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.scrollback", 100001)
    assert resp.status_code == 422


# ─── terminal.shell ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_shell_empty_string_allowed(test_app) -> None:
    """Empty string means 'use $SHELL' — must be accepted."""
    client, _ = test_app
    assert _put(client, "terminal.shell", "").status_code == 200


@pytest.mark.asyncio
async def test_shell_valid_path(test_app) -> None:
    """/bin/sh is guaranteed to exist on all POSIX systems."""
    import os

    client, _ = test_app
    if os.path.isfile("/bin/sh"):
        assert _put(client, "terminal.shell", "/bin/sh").status_code == 200


@pytest.mark.asyncio
async def test_shell_nonexistent_path(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.shell", "/does/not/exist/shell")
    assert resp.status_code == 422
    assert "does not exist" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_shell_not_a_string(test_app) -> None:
    client, _ = test_app
    resp = _put(client, "terminal.shell", 42)
    assert resp.status_code == 422


# ─── terminal boolean keys ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    "key",
    [
        "terminal.copy_on_select",
        "terminal.paste_confirm_multiline",
        "terminal.cwd_follow",
    ],
)
@pytest.mark.asyncio
async def test_bool_accepts_zero(test_app, key: str) -> None:
    client, _ = test_app
    assert _put(client, key, 0).status_code == 200


@pytest.mark.parametrize(
    "key",
    [
        "terminal.copy_on_select",
        "terminal.paste_confirm_multiline",
        "terminal.cwd_follow",
    ],
)
@pytest.mark.asyncio
async def test_bool_accepts_one(test_app, key: str) -> None:
    client, _ = test_app
    assert _put(client, key, 1).status_code == 200


@pytest.mark.parametrize(
    "key",
    [
        "terminal.copy_on_select",
        "terminal.paste_confirm_multiline",
        "terminal.cwd_follow",
    ],
)
@pytest.mark.asyncio
async def test_bool_rejects_two(test_app, key: str) -> None:
    client, _ = test_app
    resp = _put(client, key, 2)
    assert resp.status_code == 422
    assert "0 or 1" in resp.json()["detail"]


# ─── terminal.font_family ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_font_family_any_string(test_app) -> None:
    client, _ = test_app
    assert (
        _put(client, "terminal.font_family", "Fira Code, monospace").status_code == 200
    )


# ─── migration: seed rows present ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_migration_seeds_terminal_settings(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Migration 020 must have seeded all 7 terminal.* rows."""
    keys = {
        "terminal.font_family",
        "terminal.font_size",
        "terminal.scrollback",
        "terminal.shell",
        "terminal.copy_on_select",
        "terminal.paste_confirm_multiline",
        "terminal.cwd_follow",
    }
    for key in keys:
        cur = await migrated_db.execute(
            "SELECT value_json FROM app_settings WHERE key = ?", (key,)
        )
        row = await cur.fetchone()
        assert row is not None, f"missing seed row for {key}"
        # Each value must be valid JSON.
        json.loads(row["value_json"])
