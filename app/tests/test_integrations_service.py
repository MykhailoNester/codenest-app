"""Tests for integrations_service."""

from __future__ import annotations

import json
import pathlib

import aiosqlite
import pytest
import pytest_asyncio

from app.services import integrations_service


MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await db.executescript(mig.read_text())


@pytest_asyncio.fixture
async def db(tmp_path):
    conn = await aiosqlite.connect(str(tmp_path / "test.db"))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    yield conn
    await conn.close()


# ─── Catalog shape ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_catalog_contains_all_ten_named_integrations(db):
    expected = {
        "gmail",
        "google_calendar",
        "google_drive",
        "notion",
        "atlassian",
        "slack",
        "figma",
        "sentry",
        "github",
        "linear",
    }
    catalog = await integrations_service.list_catalog_from_db(db)
    actual = {entry["slug"] for entry in catalog}
    assert expected.issubset(actual), f"missing: {expected - actual}"


@pytest.mark.asyncio
async def test_catalog_entries_have_required_fields(db):
    catalog = await integrations_service.list_catalog_from_db(db)
    for entry in catalog:
        assert entry["slug"]
        assert entry["name"]
        assert entry["pane_url"].startswith("https://")
        assert entry["mcp"]["command"]
        assert isinstance(entry["mcp"].get("env_template", []), list)


@pytest.mark.asyncio
async def test_catalog_has_no_duplicate_slugs(db):
    catalog = await integrations_service.list_catalog_from_db(db)
    slugs = [entry["slug"] for entry in catalog]
    assert len(slugs) == len(set(slugs))


# ─── list_with_status ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_with_status_marks_uninstalled_when_no_rows(db):
    items = await integrations_service.list_with_status(db)
    catalog = await integrations_service.list_catalog_from_db(db)
    assert len(items) == len(catalog)
    assert all(not i["installed"] for i in items)


@pytest.mark.asyncio
async def test_install_creates_mcp_server_with_source_marker(db):
    await integrations_service.install(
        db, "github", {"GITHUB_PERSONAL_ACCESS_TOKEN": "fake"}
    )
    async with db.execute(
        "SELECT slug, source, env_json FROM mcp_servers WHERE source = 'integration:github'"
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["slug"] == "integration-github"
    env = json.loads(row["env_json"])
    assert env == {"GITHUB_PERSONAL_ACCESS_TOKEN": "fake"}


@pytest.mark.asyncio
async def test_list_with_status_flips_installed_after_install(db):
    await integrations_service.install(db, "github", {})
    items = await integrations_service.list_with_status(db)
    by_slug = {i["slug"]: i for i in items}
    assert by_slug["github"]["installed"] is True
    assert by_slug["github"]["mcp_server_slug"] == "integration-github"
    assert by_slug["slack"]["installed"] is False


@pytest.mark.asyncio
async def test_install_with_missing_env_keys_persists_empty_strings(db):
    await integrations_service.install(db, "atlassian", {"ATLASSIAN_EMAIL": "alice@x"})
    async with db.execute(
        "SELECT env_json FROM mcp_servers WHERE source = 'integration:atlassian'"
    ) as cur:
        row = await cur.fetchone()
    env = json.loads(row["env_json"])
    assert env["ATLASSIAN_EMAIL"] == "alice@x"
    assert env["ATLASSIAN_API_TOKEN"] == ""
    assert env["ATLASSIAN_SITE"] == ""


@pytest.mark.asyncio
async def test_install_with_unknown_env_keys_drops_them(db):
    await integrations_service.install(db, "github", {"NOT_A_REAL_KEY": "x"})
    async with db.execute(
        "SELECT env_json FROM mcp_servers WHERE source = 'integration:github'"
    ) as cur:
        row = await cur.fetchone()
    env = json.loads(row["env_json"])
    assert "NOT_A_REAL_KEY" not in env


@pytest.mark.asyncio
async def test_install_unknown_slug_raises_404(db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await integrations_service.install(db, "bogus-slug", {})


@pytest.mark.asyncio
async def test_double_install_raises_409(db):
    from fastapi import HTTPException

    await integrations_service.install(db, "github", {})
    with pytest.raises(HTTPException) as exc:
        await integrations_service.install(db, "github", {})
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_uninstall_removes_row_and_flips_status(db):
    await integrations_service.install(db, "github", {})
    result = await integrations_service.uninstall(db, "github")
    assert result["removed"] is True
    items = await integrations_service.list_with_status(db)
    by_slug = {i["slug"]: i for i in items}
    assert by_slug["github"]["installed"] is False


@pytest.mark.asyncio
async def test_uninstall_when_not_installed_is_noop(db):
    result = await integrations_service.uninstall(db, "github")
    assert result == {"slug": "github", "removed": False}


@pytest.mark.asyncio
async def test_install_rejects_control_chars_in_env_value(db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await integrations_service.install(
            db,
            "github",
            {"GITHUB_PERSONAL_ACCESS_TOKEN": "foo\nMALICIOUS_KEY=bar"},
        )
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException):
        await integrations_service.install(
            db,
            "github",
            {"GITHUB_PERSONAL_ACCESS_TOKEN": "foo\x00bar"},
        )
