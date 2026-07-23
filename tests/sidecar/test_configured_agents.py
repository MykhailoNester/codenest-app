"""Tests for command_center_service.list_configured_agents."""

from __future__ import annotations

import pytest

from app.services.command_center_service import list_configured_agents

# ---------------------------------------------------------------------------
# Minimal INSERT helpers that satisfy NOT NULL schema constraints
# ---------------------------------------------------------------------------

_ORG_AGENT_SQL = """
    INSERT INTO org_agents
        (name, display_name, description, model, enabled, version,
         bundle_path, install_path, link_path, link_type, verify_status)
    VALUES (?, ?, ?, ?, ?, '1.0',
            '/bundle/{name}.md', '/install/{name}.md', '/link/{name}.md',
            'symlink', 'ok')
"""

_PROJECT_AGENT_SQL = """
    INSERT INTO project_agents
        (project_id, name, description, model, canonical_path,
         link_path, link_type, enabled, verify_status)
    VALUES (?, ?, ?, NULL,
            '/repo/.claude/agents/{name}.md',
            '/ws/.claude/agents/{name}.md',
            'symlink', ?, 'ok')
"""


async def _insert_org_agent(
    db,
    name: str,
    display_name: str = "",
    enabled: int = 1,
    description: str | None = None,
) -> None:
    await db.execute(
        """
        INSERT INTO org_agents
            (name, display_name, description, model, enabled, version,
             bundle_path, install_path, link_path, link_type, verify_status)
        VALUES (?, ?, ?, NULL, ?, '1.0',
                '/bundle/x.md', '/install/x.md', ?, 'symlink', 'ok')
        """,
        (name, display_name or name, description, enabled, f"/link/{name}.md"),
    )
    await db.commit()


async def _insert_project(db, name: str) -> int:
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
    db, project_id: int, name: str, enabled: int = 1
) -> None:
    await db.execute(
        """
        INSERT INTO project_agents
            (project_id, name, description, model, canonical_path,
             link_path, link_type, enabled, verify_status)
        VALUES (?, ?, NULL, NULL,
                '/repo/.claude/agents/x.md',
                ?, 'symlink', ?, 'ok')
        """,
        (project_id, name, f"/ws/.claude/agents/{name}.md", enabled),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_db_returns_empty_groups(migrated_db):
    result = await list_configured_agents(migrated_db)
    assert result["shared"] == []
    assert result["by_project"] == []


@pytest.mark.asyncio
async def test_org_agents_appear_in_shared(migrated_db):
    db = migrated_db
    await _insert_org_agent(
        db, "atlas-recruiter", "Atlas · Recruiting", description="Agent Atlas"
    )

    result = await list_configured_agents(db)

    assert len(result["shared"]) == 1
    agent = result["shared"][0]
    assert agent["name"] == "atlas-recruiter"
    assert agent["display_name"] == "Atlas · Recruiting"
    assert agent["kind"] == "org"
    assert result["by_project"] == []


@pytest.mark.asyncio
async def test_disabled_org_agents_not_included(migrated_db):
    db = migrated_db
    await _insert_org_agent(db, "disabled-agent", enabled=0)

    result = await list_configured_agents(db)
    assert result["shared"] == []


@pytest.mark.asyncio
async def test_project_agent_enabled_goes_to_shared(migrated_db):
    db = migrated_db
    pid = await _insert_project(db, "TestProject")
    await _insert_project_agent(db, pid, "my-agent", enabled=1)

    result = await list_configured_agents(db)

    shared_names = [a["name"] for a in result["shared"]]
    assert "my-agent" in shared_names
    # An enabled project agent appears in BOTH the shared section and its
    # project's group (flagged is_shared=True) so the per-project management UI
    # lists every agent the project owns — see list_configured_agents.
    by_project = {
        g["project_name"]: {(a["name"], a["is_shared"]) for a in g["agents"]}
        for g in result["by_project"]
    }
    assert ("my-agent", True) in by_project.get("TestProject", set())


@pytest.mark.asyncio
async def test_project_agent_disabled_goes_to_by_project(migrated_db):
    db = migrated_db
    pid = await _insert_project(db, "MyProject")
    await _insert_project_agent(db, pid, "local-agent", enabled=0)

    result = await list_configured_agents(db)

    assert result["shared"] == []
    assert len(result["by_project"]) == 1
    group = result["by_project"][0]
    assert group["project_name"] == "MyProject"
    assert group["project_id"] == pid
    assert len(group["agents"]) == 1
    assert group["agents"][0]["name"] == "local-agent"
    assert group["agents"][0]["kind"] == "project"


@pytest.mark.asyncio
async def test_mixed_grouping(migrated_db):
    """Shared section gets org agents + enabled project agents; by_project gets
    disabled project agents, grouped per project."""
    db = migrated_db
    await _insert_org_agent(db, "orion-ops", "Orion")

    pid1 = await _insert_project(db, "ProjectA")
    await _insert_project_agent(db, pid1, "shared-agent", enabled=1)
    await _insert_project_agent(db, pid1, "local-agent", enabled=0)

    pid2 = await _insert_project(db, "ProjectB")
    await _insert_project_agent(db, pid2, "b-only-agent", enabled=0)

    result = await list_configured_agents(db)

    shared_names = {a["name"] for a in result["shared"]}
    assert shared_names == {"orion-ops", "shared-agent"}

    by_project_names = {
        g["project_name"]: [a["name"] for a in g["agents"]]
        for g in result["by_project"]
    }
    assert "local-agent" in by_project_names.get("ProjectA", [])
    assert "b-only-agent" in by_project_names.get("ProjectB", [])
