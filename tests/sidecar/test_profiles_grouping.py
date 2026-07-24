"""Tests for item #9 backend: default 'Home Base' profile bootstrap,
project profile_id defaulting, and list_profiles project_count field.
"""

from __future__ import annotations

import pathlib
from unittest.mock import patch

import aiosqlite
import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _run_bootstrap(db: aiosqlite.Connection, tmp_path: pathlib.Path) -> dict:
    """Run command_center_service.bootstrap with a minimal fake workspace."""
    from app.config import settings as real_settings
    from app.services.command_center_service import bootstrap

    ws_root = tmp_path / "workspace"
    org_dir = tmp_path / "org-agents"
    bundle_dir = tmp_path / "bundle"
    bundle_dir.mkdir(exist_ok=True)
    # Write a minimal manifest so install_or_upgrade doesn't crash
    (bundle_dir / "manifest.json").write_text('{"version":"test","agents":[]}')

    with (
        patch.object(real_settings, "WORKSPACE_ROOT", ws_root),
        patch.object(real_settings, "ORG_AGENTS_DIR", org_dir),
        patch.object(real_settings, "BUNDLE_RESOURCES", bundle_dir),
        patch.object(real_settings, "APP_DATA_DIR", tmp_path),
    ):
        result = await bootstrap(db)

    return result


# ---------------------------------------------------------------------------
# 1. Bootstrap creates "Home Base" and stores default_profile_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bootstrap_creates_home_base_profile(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """bootstrap() creates a profile named 'Home Base' on a fresh DB."""
    result = await _run_bootstrap(migrated_db, tmp_path)

    assert "default_profile_id" in result
    default_id = result["default_profile_id"]
    assert isinstance(default_id, int)
    assert default_id > 0

    # The profile row exists with the correct name
    row = await (
        await migrated_db.execute(
            "SELECT id, name, icon FROM profiles WHERE id = ?", (default_id,)
        )
    ).fetchone()
    assert row is not None, "Home Base profile row should exist"
    assert row["name"] == "Home Base"

    # app_settings stores the id
    setting = await (
        await migrated_db.execute(
            "SELECT value_json FROM app_settings WHERE key = 'default_profile_id'"
        )
    ).fetchone()
    assert setting is not None
    assert int(setting["value_json"]) == default_id


@pytest.mark.asyncio
async def test_bootstrap_idempotent_home_base(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Calling bootstrap() twice does not duplicate the Home Base profile."""
    r1 = await _run_bootstrap(migrated_db, tmp_path)
    r2 = await _run_bootstrap(migrated_db, tmp_path)

    assert r1["default_profile_id"] == r2["default_profile_id"]

    cur = await migrated_db.execute(
        "SELECT COUNT(*) FROM profiles WHERE name = 'Home Base'"
    )
    row = await cur.fetchone()
    assert row[0] == 1, "Home Base profile should appear exactly once"


# ---------------------------------------------------------------------------
# 2. New project gets default profile_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_project_gets_default_profile_id(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """import_project defaults profile_id to default_profile_id from app_settings."""
    # Bootstrap first so default_profile_id is seeded
    result = await _run_bootstrap(migrated_db, tmp_path)
    default_id = result["default_profile_id"]

    # Create a minimal project directory for the import
    proj_dir = tmp_path / "my-project"
    proj_dir.mkdir()

    from app.services.project_import_service import import_project

    async def _noop_regen(_db):
        return {"total": 0, "counts": {}, "failed": []}

    with patch(
        "app.services.project_import_service.command_center_service"
        ".regenerate_workspace_links",
        side_effect=_noop_regen,
    ):
        imported = await import_project(
            migrated_db,
            root_path=str(proj_dir),
            enable_agents=False,
        )

    assert imported["profile_id"] == default_id

    row = await (
        await migrated_db.execute(
            "SELECT profile_id FROM projects WHERE id = ?", (imported["project_id"],)
        )
    ).fetchone()
    assert row is not None
    assert row["profile_id"] == default_id


@pytest.mark.asyncio
async def test_import_project_explicit_profile_id(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """import_project uses the caller-supplied profile_id instead of the default."""
    await _run_bootstrap(migrated_db, tmp_path)

    # Create a second profile
    ins = await migrated_db.execute(
        "INSERT INTO profiles (name, color, icon, env_json) VALUES ('Work', '#22c55e', 'briefcase', '{}')"
    )
    await migrated_db.commit()
    work_profile_id = ins.lastrowid

    proj_dir = tmp_path / "work-project"
    proj_dir.mkdir()

    from app.services.project_import_service import import_project

    async def _noop_regen(_db):
        return {"total": 0, "counts": {}, "failed": []}

    with patch(
        "app.services.project_import_service.command_center_service"
        ".regenerate_workspace_links",
        side_effect=_noop_regen,
    ):
        imported = await import_project(
            migrated_db,
            root_path=str(proj_dir),
            enable_agents=False,
            profile_id=work_profile_id,
        )

    assert imported["profile_id"] == work_profile_id

    row = await (
        await migrated_db.execute(
            "SELECT profile_id FROM projects WHERE id = ?", (imported["project_id"],)
        )
    ).fetchone()
    assert row["profile_id"] == work_profile_id


# ---------------------------------------------------------------------------
# 3. list_profiles returns project_count
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_profiles_project_count(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """list_profiles returns project_count = number of non-workspace projects."""
    result = await _run_bootstrap(migrated_db, tmp_path)
    default_id = result["default_profile_id"]

    # Import two projects under default profile
    for i in range(2):
        proj_dir = tmp_path / f"proj{i}"
        proj_dir.mkdir()
        from app.services.project_import_service import import_project

        async def _noop_regen(_db):
            return {"total": 0, "counts": {}, "failed": []}

        with patch(
            "app.services.project_import_service.command_center_service"
            ".regenerate_workspace_links",
            side_effect=_noop_regen,
        ):
            await import_project(
                migrated_db,
                root_path=str(proj_dir),
                enable_agents=False,
            )

    from app.services.profile_service import list_profiles

    profiles = await list_profiles(migrated_db)
    home_base = next((p for p in profiles if p["id"] == default_id), None)
    assert home_base is not None
    assert home_base["project_count"] == 2, (
        f"expected 2 projects attached to Home Base, got {home_base['project_count']}"
    )
    # Other profiles have 0
    for p in profiles:
        if p["id"] != default_id:
            assert p["project_count"] == 0
