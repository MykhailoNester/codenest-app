"""Tests for D3 backend changes:

1. Auto-enable on import + rescan (agents and skills default enabled=1).
2. promote_agent_to_org: creates org_agents row with source='promoted'.
3. bootstrap reconciliation preserves source='promoted' rows.
"""

from __future__ import annotations

import pathlib
from datetime import datetime, timezone
from unittest.mock import patch

import aiosqlite
import pytest

from app.services.command_center_service import promote_agent_to_org
from app.services.org_agent_service import reconcile_stale


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _insert_project(db: aiosqlite.Connection, name: str) -> int:
    await db.execute(
        """INSERT INTO projects (name, status, is_workspace, is_active, imported_at)
           VALUES (?, 'active', 0, 1, '2024-01-01')""",
        (name,),
    )
    await db.commit()
    row = await (
        await db.execute("SELECT id FROM projects WHERE name = ?", (name,))
    ).fetchone()
    return int(row[0])


async def _insert_project_agent(
    db: aiosqlite.Connection,
    project_id: int,
    name: str,
    canonical_path: str,
    enabled: int = 1,
) -> int:
    await db.execute(
        """INSERT INTO project_agents
               (project_id, name, canonical_path, link_path, link_type,
                enabled, verify_status, last_scanned_at)
           VALUES (?, ?, ?, ?, 'symlink', ?, 'ok', ?)""",
        (project_id, name, canonical_path, canonical_path, enabled, _now()),
    )
    await db.commit()
    row = await (
        await db.execute(
            "SELECT id FROM project_agents WHERE project_id = ? AND name = ?",
            (project_id, name),
        )
    ).fetchone()
    return int(row[0])


async def _insert_org_agent(
    db: aiosqlite.Connection,
    name: str,
    source: str = "bundled",
    install_path: str = "",
) -> None:
    await db.execute(
        """INSERT INTO org_agents
               (name, display_name, description, model, version,
                bundle_path, install_path, link_path, source, sha256, installed_at)
           VALUES (?, ?, '', NULL, 'test', '', ?, ?, ?, '', ?)""",
        (
            name,
            name,
            install_path,
            f"/ws/.claude/agents/{name}.md",
            source,
            _now(),
        ),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# 1. Auto-enable on import
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_project_agents_enabled_by_default(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """import_project inserts project_agents with enabled=1 by default."""
    agent_file = tmp_path / ".claude" / "agents" / "my-agent.md"
    agent_file.parent.mkdir(parents=True)
    agent_file.write_text("---\nname: my-agent\n---\n# My Agent\n")

    from app.services.project_import_service import import_project

    # Patch regenerate to avoid needing a real workspace directory
    async def _noop_regen(_db):
        return {"total": 0, "counts": {}, "failed": []}

    with patch(
        "app.services.project_import_service.command_center_service"
        ".regenerate_workspace_links",
        side_effect=_noop_regen,
    ):
        result = await import_project(
            migrated_db,
            root_path=str(tmp_path),
            enable_agents=True,
            enable_skills=False,
            enable_commands=False,
        )

    assert result["agents_created"] >= 1

    cur = await migrated_db.execute(
        "SELECT enabled FROM project_agents WHERE project_id = ?",
        (result["project_id"],),
    )
    rows = await cur.fetchall()
    assert rows, "expected at least one project_agent row"
    for row in rows:
        assert row[0] == 1, "newly imported agent should have enabled=1"


@pytest.mark.asyncio
async def test_import_project_skills_enabled_by_default(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """import_project inserts project_skills with enabled=1 when enable_skills=True."""
    skill_dir = tmp_path / ".claude" / "skills" / "my-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "README.md").write_text("# My Skill\n")

    from app.services.project_import_service import import_project

    async def _noop_regen(_db):
        return {"total": 0, "counts": {}, "failed": []}

    with patch(
        "app.services.project_import_service.command_center_service"
        ".regenerate_workspace_links",
        side_effect=_noop_regen,
    ):
        result = await import_project(
            migrated_db,
            root_path=str(tmp_path),
            enable_agents=False,
            enable_skills=True,
            enable_commands=False,
        )

    if result["skills_created"] > 0:
        cur = await migrated_db.execute(
            "SELECT enabled FROM project_skills WHERE project_id = ?",
            (result["project_id"],),
        )
        rows = await cur.fetchall()
        for row in rows:
            assert row[0] == 1, "newly imported skill should have enabled=1"


# ---------------------------------------------------------------------------
# 2. Auto-enable on rescan
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rescan_new_agents_enabled_by_default(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """rescan_project enables newly discovered agents (enabled=1)."""
    # Create a project row directly
    now = _now()
    await migrated_db.execute(
        """INSERT INTO projects (name, status, is_workspace, is_active,
                                 root_path, imported_at)
           VALUES ('TestProj', 'active', 0, 1, ?, ?)""",
        (str(tmp_path), now),
    )
    await migrated_db.commit()
    pid = int(
        (
            await (
                await migrated_db.execute(
                    "SELECT id FROM projects WHERE name = 'TestProj'"
                )
            ).fetchone()
        )[0]
    )

    # Create agent file
    agent_file = tmp_path / ".claude" / "agents" / "new-agent.md"
    agent_file.parent.mkdir(parents=True)
    agent_file.write_text("---\nname: new-agent\n---\n# New Agent\n")

    from app.services.project_import_service import rescan_project

    async def _noop_regen(_db):
        return {"total": 0, "counts": {}, "failed": []}

    with patch(
        "app.services.project_import_service.command_center_service"
        ".regenerate_workspace_links",
        side_effect=_noop_regen,
    ):
        result = await rescan_project(migrated_db, pid)

    assert result["agents_added"] >= 1

    cur = await migrated_db.execute(
        "SELECT enabled FROM project_agents WHERE project_id = ?", (pid,)
    )
    rows = await cur.fetchall()
    assert rows
    for row in rows:
        assert row[0] == 1, "newly discovered agent via rescan should have enabled=1"


# ---------------------------------------------------------------------------
# 3. promote_agent_to_org
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_promote_agent_creates_org_row(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """promote_agent_to_org inserts an org_agents row with source='promoted'."""
    # Create a real agent file so symlink_service can link it
    agent_file = tmp_path / "my-promoted-agent.md"
    agent_file.write_text("---\nname: my-promoted-agent\n---\n# Promoted\n")

    pid = await _insert_project(migrated_db, "Promotable")
    aid = await _insert_project_agent(
        migrated_db, pid, "my-promoted-agent", str(agent_file)
    )

    org_dir = tmp_path / "org-agents"
    org_dir.mkdir()

    from app.config import settings as real_settings

    with (
        patch.object(real_settings, "ORG_AGENTS_DIR", org_dir),
        patch.object(real_settings, "WORKSPACE_ROOT", tmp_path / "workspace"),
    ):
        # Patch regenerate so we don't need a full workspace
        async def _noop_regen(_db):
            return {"total": 0, "counts": {}, "failed": []}

        with patch(
            "app.services.command_center_service.regenerate_workspace_links",
            side_effect=_noop_regen,
        ):
            result = await promote_agent_to_org(migrated_db, pid, aid)

    assert result["already_existed"] is False
    org_row = result["org_agent"]
    assert org_row["name"] == "my-promoted-agent"
    assert org_row["source"] == "promoted"
    assert org_row["enabled"] == 1

    # File was linked into org_dir
    linked = org_dir / agent_file.name
    assert linked.exists() or linked.is_symlink()

    # The source project_agent is disabled on promote so the agent links into
    # the workspace once (as the shared org agent), not twice.
    cur = await migrated_db.execute(
        "SELECT enabled FROM project_agents WHERE id = ?", (aid,)
    )
    assert (await cur.fetchone())[0] == 0


@pytest.mark.asyncio
async def test_promote_agent_idempotent(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Promoting the same agent twice returns already_existed=True."""
    agent_file = tmp_path / "repeat-agent.md"
    agent_file.write_text("---\nname: repeat-agent\n---\n# Repeat\n")

    pid = await _insert_project(migrated_db, "RepeatProj")
    aid = await _insert_project_agent(migrated_db, pid, "repeat-agent", str(agent_file))

    org_dir = tmp_path / "org-agents"
    org_dir.mkdir()

    from app.config import settings as real_settings

    with (
        patch.object(real_settings, "ORG_AGENTS_DIR", org_dir),
        patch.object(real_settings, "WORKSPACE_ROOT", tmp_path / "workspace"),
    ):

        async def _noop_regen(_db):
            return {"total": 0, "counts": {}, "failed": []}

        with patch(
            "app.services.command_center_service.regenerate_workspace_links",
            side_effect=_noop_regen,
        ):
            first = await promote_agent_to_org(migrated_db, pid, aid)
            second = await promote_agent_to_org(migrated_db, pid, aid)

    assert first["already_existed"] is False
    assert second["already_existed"] is True

    cur = await migrated_db.execute(
        "SELECT COUNT(*) FROM org_agents WHERE name = 'repeat-agent'"
    )
    row = await cur.fetchone()
    assert row[0] == 1, "promote twice should not duplicate the org_agents row"


@pytest.mark.asyncio
async def test_promote_agent_bundled_collision_raises(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Promoting over an existing bundled agent name raises ValueError."""
    agent_file = tmp_path / "orion-ops.md"
    agent_file.write_text("---\nname: orion-ops\n---\n# Fake Orion\n")

    pid = await _insert_project(migrated_db, "CollisionProj")
    aid = await _insert_project_agent(migrated_db, pid, "orion-ops", str(agent_file))

    # Insert a bundled org_agent with the same name
    await _insert_org_agent(migrated_db, "orion-ops", source="bundled")

    org_dir = tmp_path / "org-agents"
    org_dir.mkdir()

    from app.config import settings as real_settings

    with (
        patch.object(real_settings, "ORG_AGENTS_DIR", org_dir),
        patch.object(real_settings, "WORKSPACE_ROOT", tmp_path / "workspace"),
    ):
        with pytest.raises(ValueError, match="bundled"):
            await promote_agent_to_org(migrated_db, pid, aid)


@pytest.mark.asyncio
async def test_promote_agent_not_found_raises(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Non-existent project_id or agent_id raises ValueError."""
    org_dir = tmp_path / "org-agents"
    org_dir.mkdir()

    from app.config import settings as real_settings

    with (
        patch.object(real_settings, "ORG_AGENTS_DIR", org_dir),
        patch.object(real_settings, "WORKSPACE_ROOT", tmp_path / "workspace"),
    ):
        with pytest.raises(ValueError, match="not found"):
            await promote_agent_to_org(migrated_db, 9999, 9999)


# ---------------------------------------------------------------------------
# 4. Bootstrap reconciliation preserves source='promoted' rows
# ---------------------------------------------------------------------------

BUNDLE_DIR = (
    pathlib.Path(__file__).parents[2] / "src-tauri" / "resources" / "org-agents"
)


@pytest.mark.asyncio
async def test_reconcile_preserves_promoted_rows(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """reconcile_stale must NOT remove rows with source='promoted'."""
    target_dir = tmp_path / "org-agents"
    target_dir.mkdir()

    # Insert a promoted row (not in the manifest)
    await _insert_org_agent(
        migrated_db, "my-custom-agent", source="promoted", install_path=""
    )

    # Insert a stale bundled row (not in the manifest)
    stale_file = target_dir / "stale-bundled.md"
    stale_file.write_text("# stale\n")
    await migrated_db.execute(
        """INSERT INTO org_agents
               (name, display_name, version, bundle_path, install_path, link_path,
                source, sha256, installed_at)
           VALUES ('stale-bundled', 'stale', 'old', '', ?, ?,
                   'bundled', '', ?)""",
        (str(stale_file), "/ws/.claude/agents/stale-bundled.md", _now()),
    )
    await migrated_db.commit()

    removed = await reconcile_stale(
        migrated_db, bundle_dir=BUNDLE_DIR, target_dir=target_dir
    )

    # Stale bundled agent removed
    assert "stale-bundled" in removed

    # Promoted row is untouched
    assert "my-custom-agent" not in removed
    cur = await migrated_db.execute(
        "SELECT source FROM org_agents WHERE name = 'my-custom-agent'"
    )
    row = await cur.fetchone()
    assert row is not None, "promoted row should still exist after reconcile"
    assert row[0] == "promoted"
