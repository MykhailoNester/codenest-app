"""Cross-project agent name collisions in the shared workspace.

Claude Code resolves an agent by its frontmatter ``name:``, not by its filename.
The workspace linker disambiguates *filenames* — two projects shipping a
``code-reviewer`` become ``code-reviewer.md`` and ``other--code-reviewer.md`` —
but both files still declare ``name: code-reviewer``, so the CLI would see two
agents under one name and silently pick one. A symlink cannot fix that: the link
and its target are the same bytes.

So the shadowed agent is left out of the workspace and reported instead. These
tests pin that, and pin that skills are *not* treated the same way — they resolve
by directory name, which the existing prefixing genuinely disambiguates.
"""

from __future__ import annotations

import pathlib
from unittest.mock import patch

import aiosqlite
import pytest

from app.services import command_center_service


async def _insert_project(
    db: aiosqlite.Connection, name: str, *, is_active: int = 1
) -> int:
    cur = await db.execute(
        """INSERT INTO projects (name, status, path, root_path, is_workspace, is_active)
           VALUES (?, 'active', ?, ?, 0, ?)""",
        (name, f"/w/{name}", f"/w/{name}", is_active),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


async def _insert_agent(
    db: aiosqlite.Connection,
    project_id: int,
    name: str,
    canonical: str,
    *,
    enabled: int = 1,
) -> int:
    cur = await db.execute(
        """INSERT INTO project_agents
               (project_id, name, canonical_path, link_path, enabled)
           VALUES (?, ?, ?, ?, ?)""",
        (project_id, name, canonical, canonical, enabled),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


async def _insert_skill(
    db: aiosqlite.Connection, project_id: int, name: str, canonical: str
) -> int:
    cur = await db.execute(
        """INSERT INTO project_skills
               (project_id, name, canonical_path, link_path, enabled)
           VALUES (?, ?, ?, ?, 1)""",
        (project_id, name, canonical, canonical),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


async def _insert_org_agent(
    db: aiosqlite.Connection, name: str, install_path: str
) -> int:
    cur = await db.execute(
        """INSERT INTO org_agents
               (name, display_name, version, bundle_path, install_path,
                link_path, sha256, enabled)
           VALUES (?, ?, '1', ?, ?, ?, 'x', 1)""",
        (name, name, install_path, install_path, install_path),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


@pytest.mark.asyncio
async def test_second_project_with_the_same_agent_name_is_not_linked(
    migrated_db: aiosqlite.Connection,
):
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", "/w/alpha/cr.md")
    await _insert_agent(migrated_db, second, "code-reviewer", "/w/beta/cr.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    agents = [d for d in desired if d["bucket"] == "agents"]
    assert len(agents) == 1, "the CLI must see exactly one `code-reviewer`"
    assert agents[0]["canonical_path"] == "/w/alpha/cr.md"

    assert len(conflicts) == 1
    assert conflicts[0]["name"] == "code-reviewer"
    assert conflicts[0]["project"] == "beta"
    assert conflicts[0]["shadowed_by"] == "alpha"
    # The path is what the user needs in order to go and rename it.
    assert conflicts[0]["canonical_path"] == "/w/beta/cr.md"


@pytest.mark.asyncio
async def test_distinct_names_across_projects_all_link(
    migrated_db: aiosqlite.Connection,
):
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "reviewer", "/w/alpha/a.md")
    await _insert_agent(migrated_db, second, "planner", "/w/beta/b.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    assert conflicts == []
    assert len([d for d in desired if d["bucket"] == "agents"]) == 2


@pytest.mark.asyncio
async def test_an_org_agent_shadows_a_project_agent_of_the_same_name(
    migrated_db: aiosqlite.Connection,
):
    """Org agents are collected first and keep winning — now visibly."""
    await _insert_org_agent(migrated_db, "orion", "/org/orion.md")
    pid = await _insert_project(migrated_db, "alpha")
    await _insert_agent(migrated_db, pid, "orion", "/w/alpha/orion.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    agents = [d for d in desired if d["bucket"] == "agents"]
    assert [a["table"] for a in agents] == ["org_agents"]
    assert len(conflicts) == 1
    assert conflicts[0]["shadowed_by_kind"] == "org_agent"
    assert conflicts[0]["shadowed_by"] == "shared"


@pytest.mark.asyncio
async def test_a_disabled_duplicate_is_not_a_conflict(
    migrated_db: aiosqlite.Connection,
):
    """Disabling one of the pair is a valid resolution, so it must clear."""
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", "/w/alpha/cr.md")
    await _insert_agent(
        migrated_db, second, "code-reviewer", "/w/beta/cr.md", enabled=0
    )

    _desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )
    assert conflicts == []


@pytest.mark.asyncio
async def test_an_inactive_project_is_not_a_conflict(
    migrated_db: aiosqlite.Connection,
):
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta", is_active=0)
    await _insert_agent(migrated_db, first, "code-reviewer", "/w/alpha/cr.md")
    await _insert_agent(migrated_db, second, "code-reviewer", "/w/beta/cr.md")

    _desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )
    assert conflicts == []


@pytest.mark.asyncio
async def test_same_named_skills_both_link_under_distinct_directories(
    migrated_db: aiosqlite.Connection,
):
    """Skills resolve by directory name, so prefixing really does disambiguate.

    Deduplicating them the way agents are deduplicated would hide a skill that
    works perfectly well under its prefixed name.
    """
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_skill(migrated_db, first, "deploy", "/w/alpha/skills/deploy")
    await _insert_skill(migrated_db, second, "deploy", "/w/beta/skills/deploy")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    skills = [d for d in desired if d["bucket"] == "skills"]
    assert len(skills) == 2
    names = {s["filename"] for s in skills}
    assert names == {"deploy", "beta--deploy"}
    assert conflicts == []


@pytest.mark.asyncio
async def test_conflicts_are_reported_by_the_health_view(
    migrated_db: aiosqlite.Connection,
):
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", "/w/alpha/cr.md")
    await _insert_agent(migrated_db, second, "code-reviewer", "/w/beta/cr.md")

    conflicts = await command_center_service.list_agent_name_conflicts(migrated_db)

    assert [c["name"] for c in conflicts] == ["code-reviewer"]


@pytest.mark.asyncio
async def test_regeneration_reports_conflicts_and_links_only_the_winner(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
):
    """End to end against a real workspace directory."""
    alpha_agent = tmp_path / "alpha" / "cr.md"
    alpha_agent.parent.mkdir(parents=True)
    alpha_agent.write_text("---\nname: code-reviewer\n---\nalpha\n")
    beta_agent = tmp_path / "beta" / "cr.md"
    beta_agent.parent.mkdir(parents=True)
    beta_agent.write_text("---\nname: code-reviewer\n---\nbeta\n")

    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", str(alpha_agent))
    await _insert_agent(migrated_db, second, "code-reviewer", str(beta_agent))

    from app.config import settings as real_settings

    workspace = tmp_path / "workspace"
    with patch.object(real_settings, "WORKSPACE_ROOT", workspace):
        regen = await command_center_service.regenerate_workspace_links(migrated_db)

    assert len(regen["conflicts"]) == 1
    assert regen["counts"]["project_agents_linked"] == 1

    linked = sorted(p.name for p in (workspace / ".claude" / "agents").iterdir())
    assert linked == ["code-reviewer.md"], (
        "a shadowed agent must not be linked at all — the CLI would ignore it "
        "while the user believed it was active"
    )
    assert (workspace / ".claude" / "agents" / "code-reviewer.md").read_text() == (
        "---\nname: code-reviewer\n---\nalpha\n"
    )
