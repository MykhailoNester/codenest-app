"""Tests for org_agent_service.reconcile_stale.

Covers the case where the DB contains org_agents that are no longer in the
bundle manifest (e.g. orchestrator and roadmap-orchestrator removed in E1.3).
After reconcile_stale, only the three manifest agents must remain.
"""

from __future__ import annotations

import pathlib
from datetime import datetime, timezone

import aiosqlite
import pytest

from app.services.org_agent_service import reconcile_stale

BUNDLE_DIR = (
    pathlib.Path(__file__).parents[2] / "src-tauri" / "resources" / "org-agents"
)

_LINK_BASE = "/workspace/.claude/agents"


async def _insert_agent(
    db: aiosqlite.Connection,
    name: str,
    install_path: str = "",
) -> None:
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        """INSERT INTO org_agents
               (name, display_name, description, model, version,
                bundle_path, install_path, link_path, sha256, installed_at)
           VALUES (?, ?, '', NULL, 'old', '', ?, ?, '', ?)""",
        (name, name, install_path, f"{_LINK_BASE}/{name}.md", now),
    )


async def _insert_fake_agent(
    db: aiosqlite.Connection,
    name: str,
    target_dir: pathlib.Path,
) -> pathlib.Path:
    """Insert a minimal org_agents row and a placeholder file in target_dir."""
    fake_file = target_dir / f"{name}.md"
    fake_file.write_text(f"# {name}\n")
    await _insert_agent(db, name, install_path=str(fake_file))
    await db.commit()
    return fake_file


@pytest.mark.asyncio
async def test_reconcile_removes_stale_agents(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Rows for orchestrator and roadmap-orchestrator are removed; the three
    manifest agents are untouched."""
    target_dir = tmp_path / "org-agents"
    target_dir.mkdir()

    # Insert the three valid agents (install_path outside target_dir so
    # reconcile won't try to delete the files — mimicking already-installed agents).
    for name in ("atlas-recruiter", "orion-ops", "vega-research"):
        await _insert_agent(migrated_db, name, install_path="")
    await migrated_db.commit()

    # Insert two stale agents WITH real files in target_dir
    orch_file = await _insert_fake_agent(migrated_db, "orchestrator", target_dir)
    rm_file = await _insert_fake_agent(migrated_db, "roadmap-orchestrator", target_dir)

    # Confirm DB has 5 rows before reconcile
    cur = await migrated_db.execute("SELECT name FROM org_agents ORDER BY name")
    names_before = {r[0] for r in await cur.fetchall()}
    assert names_before == {
        "atlas-recruiter",
        "orion-ops",
        "vega-research",
        "orchestrator",
        "roadmap-orchestrator",
    }

    removed = await reconcile_stale(
        migrated_db,
        bundle_dir=BUNDLE_DIR,
        target_dir=target_dir,
    )

    assert sorted(removed) == ["orchestrator", "roadmap-orchestrator"]

    # DB now has exactly the 3 manifest agents
    cur = await migrated_db.execute("SELECT name FROM org_agents ORDER BY name")
    names_after = {r[0] for r in await cur.fetchall()}
    assert names_after == {"atlas-recruiter", "orion-ops", "vega-research"}

    # Installed files for stale agents were deleted from target_dir
    assert not orch_file.exists()
    assert not rm_file.exists()


@pytest.mark.asyncio
async def test_reconcile_is_idempotent(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """Running reconcile_stale when DB already matches manifest removes nothing."""
    target_dir = tmp_path / "org-agents"
    target_dir.mkdir()

    for name in ("atlas-recruiter", "orion-ops", "vega-research"):
        await _insert_agent(migrated_db, name, install_path="")
    await migrated_db.commit()

    removed = await reconcile_stale(
        migrated_db,
        bundle_dir=BUNDLE_DIR,
        target_dir=target_dir,
    )
    assert removed == []

    cur = await migrated_db.execute("SELECT count(*) FROM org_agents")
    row = await cur.fetchone()
    assert row is not None
    assert row[0] == 3
