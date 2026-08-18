"""Tests for command_center_service.list_invocables — the composer's catalog.

Covers the two things a picker cannot get wrong: the *token* it inserts (agents
resolve by frontmatter name, skills and commands by path segment) and the *scope*
it offers them in (a workspace pane and a project pane see different trees).
"""

from __future__ import annotations

import pathlib
from unittest.mock import patch

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.config import settings as real_settings
from app.routers import command_center as cc_router
from app.services.command_center_service import list_invocables

# ---------------------------------------------------------------------------
# Insert helpers — minimal rows that satisfy the NOT NULL constraints
# ---------------------------------------------------------------------------


async def _insert_project(
    db: aiosqlite.Connection,
    name: str,
    root: str | pathlib.Path | None = None,
    *,
    is_active: int = 1,
) -> int:
    await db.execute(
        """INSERT INTO projects (name, status, is_workspace, is_active, path,
                                 root_path, imported_at)
           VALUES (?, 'active', 0, ?, ?, ?, '2024-01-01')""",
        (name, is_active, str(root) if root else None, str(root) if root else None),
    )
    await db.commit()
    row = await (
        await db.execute("SELECT id FROM projects WHERE name = ?", (name,))
    ).fetchone()
    return int(row[0])


async def _insert_org_agent(db: aiosqlite.Connection, name: str) -> None:
    await db.execute(
        """INSERT INTO org_agents
               (name, display_name, description, model, enabled, version,
                bundle_path, install_path, link_path, link_type, verify_status)
           VALUES (?, ?, ?, 'opus', 1, '1.0', '/bundle/x.md', ?, ?, 'symlink', 'ok')""",
        (
            name,
            f"{name} (org)",
            f"description of {name}",
            f"/org-agents/{name}.md",
            f"/ws/.claude/agents/{name}.md",
        ),
    )
    await db.commit()


async def _insert_asset(
    db: aiosqlite.Connection,
    bucket: str,
    project_id: int,
    name: str,
    *,
    enabled: int = 1,
    canonical: str | None = None,
) -> int:
    """Insert one project_agents / project_skills / project_commands row."""
    table = {
        "agents": "project_agents",
        "skills": "project_skills",
        "commands": "project_commands",
    }[bucket]
    default_canonical = {
        "agents": f"/repo/.claude/agents/{name}.md",
        "skills": f"/repo/.claude/skills/{name}",
        "commands": f"/repo/.claude/commands/{name}.md",
    }[bucket]
    path = canonical or default_canonical
    if bucket == "agents":
        await db.execute(
            """INSERT INTO project_agents
                   (project_id, name, description, model, canonical_path,
                    link_path, link_type, enabled, verify_status)
               VALUES (?, ?, ?, 'sonnet', ?, ?, 'symlink', ?, 'ok')""",
            (
                project_id,
                name,
                f"description of {name}",
                path,
                f"/placeholder/{project_id}/{name}.md",
                enabled,
            ),
        )
    else:
        await db.execute(
            f"""INSERT INTO {table}
                    (project_id, name, canonical_path, link_path, link_type,
                     enabled, verify_status)
                VALUES (?, ?, ?, ?, 'symlink', ?, 'ok')""",
            (
                project_id,
                name,
                path,
                f"/placeholder/{project_id}/{bucket}/{name}",
                enabled,
            ),
        )
    await db.commit()
    row = await (
        await db.execute(
            f"SELECT id FROM {table} WHERE project_id = ? AND name = ?",
            (project_id, name),
        )
    ).fetchone()
    return int(row[0])


@pytest.fixture
def workspace(tmp_path: pathlib.Path):
    """Point WORKSPACE_ROOT at a temp dir for the duration of a test."""
    root = tmp_path / "workspace"
    with patch.object(real_settings, "WORKSPACE_ROOT", root):
        yield root


def _by_name(items: list[dict]) -> dict[str, dict]:
    return {item["name"]: item for item in items}


# ---------------------------------------------------------------------------
# Workspace scope
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_workspace_reports_only_the_builtin_skill(migrated_db, workspace):
    result = await list_invocables(migrated_db)

    assert result["scope"] == "workspace"
    assert result["agents"] == []
    assert result["commands"] == []
    assert result["shadowed"] == []
    assert [s["name"] for s in result["skills"]] == ["projects"]


@pytest.mark.asyncio
async def test_absent_cwd_means_workspace(migrated_db, workspace):
    """A new agent pane starts in the workspace, so no cwd must not mean "nowhere"."""
    await _insert_org_agent(migrated_db, "orion-ops")

    for cwd in (None, "", "   "):
        result = await list_invocables(migrated_db, cwd=cwd)
        assert result["scope"] == "workspace", cwd
        assert [a["name"] for a in result["agents"]] == ["orion-ops"], cwd


@pytest.mark.asyncio
async def test_agent_token_is_the_frontmatter_name(migrated_db, workspace):
    await _insert_org_agent(migrated_db, "orion-ops")
    pid = await _insert_project(migrated_db, "codenest-app", "/repo/codenest-app")
    await _insert_asset(migrated_db, "agents", pid, "coder-agent")

    agents = _by_name((await list_invocables(migrated_db))["agents"])

    assert agents["orion-ops"]["invoke_token"] == "@agent-orion-ops"
    assert agents["orion-ops"]["kind"] == "org"
    assert agents["orion-ops"]["alias"] == "orion-ops"
    assert agents["orion-ops"]["display_name"] == "orion-ops (org)"
    assert agents["coder-agent"]["invoke_token"] == "@agent-coder-agent"
    assert agents["coder-agent"]["kind"] == "project"
    assert agents["coder-agent"]["alias"] == "codenest-app:coder-agent"
    assert agents["coder-agent"]["project_name"] == "codenest-app"
    assert agents["coder-agent"]["model"] == "sonnet"


@pytest.mark.asyncio
async def test_shadowed_agent_is_reported_but_never_invocable(migrated_db, workspace):
    """Two projects shipping `code-reviewer`: one is linked, the other is not.

    The CLI resolves an agent by frontmatter name, so the second file could only
    ever be ambiguous — it must not appear in `agents` with a token that would
    reach the first one.
    """
    first = await _insert_project(migrated_db, "codenest-app", "/repo/codenest-app")
    second = await _insert_project(migrated_db, "miragold", "/repo/miragold")
    await _insert_asset(migrated_db, "agents", first, "code-reviewer")
    await _insert_asset(migrated_db, "agents", second, "code-reviewer")

    result = await list_invocables(migrated_db)

    assert [a["project_name"] for a in result["agents"]] == ["codenest-app"]
    assert len(result["shadowed"]) == 1
    shadowed = result["shadowed"][0]
    assert shadowed["name"] == "code-reviewer"
    assert shadowed["project"] == "miragold"
    assert shadowed["shadowed_by"] == "codenest-app"


@pytest.mark.asyncio
async def test_skill_token_is_the_linked_directory_segment(migrated_db, workspace):
    """A duplicated skill name really is disambiguated by its workspace entry."""
    first = await _insert_project(migrated_db, "codenest-app", "/repo/codenest-app")
    second = await _insert_project(migrated_db, "miragold", "/repo/miragold")
    await _insert_asset(migrated_db, "skills", first, "frontend-design")
    await _insert_asset(migrated_db, "skills", second, "frontend-design")

    skills = (await list_invocables(migrated_db))["skills"]
    tokens = {s["invoke_token"] for s in skills}

    assert "/frontend-design" in tokens
    assert "/miragold--frontend-design" in tokens
    # The alias stays the name the project declared, so a picker row reads the way
    # its author would recognise it.
    prefixed = next(s for s in skills if s["name"] == "miragold--frontend-design")
    assert prefixed["alias"] == "miragold:frontend-design"


@pytest.mark.asyncio
async def test_command_token_is_the_linked_file_stem(migrated_db, workspace):
    first = await _insert_project(migrated_db, "codenest-app", "/repo/codenest-app")
    second = await _insert_project(migrated_db, "miragold", "/repo/miragold")
    await _insert_asset(migrated_db, "commands", first, "ship")
    await _insert_asset(migrated_db, "commands", second, "ship")

    commands = (await list_invocables(migrated_db))["commands"]

    assert {c["invoke_token"] for c in commands} == {"/ship", "/miragold--ship"}
    assert all(not c["name"].endswith(".md") for c in commands)


@pytest.mark.asyncio
async def test_link_path_is_derived_not_read_from_the_row(migrated_db, workspace):
    """`link_path` holds a placeholder until a regeneration runs; a picker cannot
    wait for one, so the catalog derives the path the linker would use."""
    pid = await _insert_project(migrated_db, "codenest-app", "/repo/codenest-app")
    await _insert_asset(migrated_db, "agents", pid, "coder-agent")

    agent = (await list_invocables(migrated_db))["agents"][0]

    assert agent["link_path"] == str(workspace / ".claude/agents/coder-agent.md")
    assert agent["canonical_path"] == "/repo/.claude/agents/coder-agent.md"


@pytest.mark.asyncio
async def test_workspace_scope_matches_the_linker_predicate(migrated_db, workspace):
    """Unshared assets and archived projects are not linked, so not invocable."""
    live = await _insert_project(migrated_db, "codenest-app", "/repo/codenest-app")
    archived = await _insert_project(
        migrated_db, "old-thing", "/repo/old-thing", is_active=0
    )
    await _insert_asset(migrated_db, "agents", live, "shared-agent", enabled=1)
    await _insert_asset(migrated_db, "agents", live, "local-agent", enabled=0)
    await _insert_asset(migrated_db, "agents", archived, "archived-agent")

    result = await list_invocables(migrated_db)

    assert [a["name"] for a in result["agents"]] == ["shared-agent"]


@pytest.mark.asyncio
async def test_builtin_projects_skill_reports_whether_it_exists(migrated_db, workspace):
    missing = (await list_invocables(migrated_db))["skills"][0]
    assert missing["name"] == "projects"
    assert missing["invoke_token"] == "/projects"
    assert missing["kind"] == "builtin"
    assert missing["verify_status"] == "missing_target"
    assert "imported projects" in missing["description"]

    (workspace / ".claude/skills/projects").mkdir(parents=True)
    present = (await list_invocables(migrated_db))["skills"][0]
    assert present["verify_status"] == "ok"


# ---------------------------------------------------------------------------
# Project scope
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_project_scope_returns_that_projects_own_assets(
    migrated_db, workspace, tmp_path
):
    """A pane rooted in a project reads that project's `.claude/`, and nothing
    else: not the org agents, not another project's."""
    root = tmp_path / "repo" / "miragold"
    root.mkdir(parents=True)
    await _insert_org_agent(migrated_db, "orion-ops")
    other = await _insert_project(migrated_db, "codenest-app", tmp_path / "repo/cn")
    mine = await _insert_project(migrated_db, "miragold", root)
    await _insert_asset(migrated_db, "agents", other, "coder-agent")
    await _insert_asset(migrated_db, "agents", mine, "debugger")
    await _insert_asset(migrated_db, "skills", mine, "frontend-design")
    await _insert_asset(migrated_db, "commands", mine, "ship")

    result = await list_invocables(migrated_db, cwd=str(root))

    assert result["scope"] == "project"
    assert result["project_id"] == mine
    assert [a["name"] for a in result["agents"]] == ["debugger"]
    assert [s["invoke_token"] for s in result["skills"]] == ["/frontend-design"]
    assert [c["invoke_token"] for c in result["commands"]] == ["/ship"]
    assert result["shadowed"] == []


@pytest.mark.asyncio
async def test_project_scope_includes_unshared_assets(migrated_db, workspace, tmp_path):
    """`enabled` controls sharing into the workspace, not what the project's own
    session can reach — the file is right there either way."""
    root = tmp_path / "repo" / "miragold"
    root.mkdir(parents=True)
    pid = await _insert_project(migrated_db, "miragold", root)
    await _insert_asset(migrated_db, "agents", pid, "local-agent", enabled=0)

    agent = (await list_invocables(migrated_db, cwd=str(root)))["agents"][0]

    assert agent["name"] == "local-agent"
    assert agent["invoke_token"] == "@agent-local-agent"
    assert agent["shared"] is False
    # No workspace link exists for an unshared asset, so none is claimed.
    assert agent["link_path"] is None


@pytest.mark.asyncio
async def test_shadowed_agent_is_still_invocable_in_its_own_project(
    migrated_db, workspace, tmp_path
):
    root = tmp_path / "repo" / "miragold"
    root.mkdir(parents=True)
    first = await _insert_project(migrated_db, "codenest-app", tmp_path / "repo/cn")
    second = await _insert_project(migrated_db, "miragold", root)
    await _insert_asset(migrated_db, "agents", first, "code-reviewer")
    await _insert_asset(migrated_db, "agents", second, "code-reviewer")

    result = await list_invocables(migrated_db, cwd=str(root))

    assert [a["invoke_token"] for a in result["agents"]] == ["@agent-code-reviewer"]


@pytest.mark.asyncio
async def test_deepest_project_root_wins(migrated_db, workspace, tmp_path):
    """A project checked out inside another resolves to itself."""
    outer = tmp_path / "repo"
    inner = outer / "vendor" / "inner"
    inner.mkdir(parents=True)
    outer_id = await _insert_project(migrated_db, "outer", outer)
    inner_id = await _insert_project(migrated_db, "inner", inner)
    await _insert_asset(migrated_db, "agents", outer_id, "outer-agent")
    await _insert_asset(migrated_db, "agents", inner_id, "inner-agent")

    result = await list_invocables(migrated_db, cwd=str(inner / "src"))

    assert result["project_id"] == inner_id
    assert [a["name"] for a in result["agents"]] == ["inner-agent"]


@pytest.mark.asyncio
async def test_cwd_inside_the_workspace_is_workspace_scope(
    migrated_db, workspace, tmp_path
):
    await _insert_org_agent(migrated_db, "orion-ops")
    nested = workspace / "some" / "dir"
    nested.mkdir(parents=True)

    result = await list_invocables(migrated_db, cwd=str(nested))

    assert result["scope"] == "workspace"
    assert [a["name"] for a in result["agents"]] == ["orion-ops"]


@pytest.mark.asyncio
async def test_unknown_cwd_offers_nothing(migrated_db, workspace, tmp_path):
    """Codenest manages no `.claude/` there, so any token would be a guess."""
    await _insert_org_agent(migrated_db, "orion-ops")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()

    result = await list_invocables(migrated_db, cwd=str(elsewhere))

    assert result["scope"] == "unknown"
    assert result["agents"] == []
    assert result["skills"] == []
    assert result["commands"] == []


@pytest.mark.asyncio
async def test_archived_project_root_is_not_a_scope(migrated_db, workspace, tmp_path):
    root = tmp_path / "repo" / "old-thing"
    root.mkdir(parents=True)
    pid = await _insert_project(migrated_db, "old-thing", root, is_active=0)
    await _insert_asset(migrated_db, "agents", pid, "archived-agent")

    result = await list_invocables(migrated_db, cwd=str(root))

    assert result["scope"] == "unknown"
    assert result["agents"] == []


# ---------------------------------------------------------------------------
# Router wiring
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def client(migrated_db):
    original = db_module._db
    db_module._db = migrated_db
    app = FastAPI()
    app.include_router(cc_router.router)
    yield TestClient(app, raise_server_exceptions=True)
    db_module._db = original


@pytest.mark.asyncio
async def test_endpoint_scopes_on_the_cwd_query_param(
    client, migrated_db, workspace, tmp_path
):
    root = tmp_path / "repo" / "miragold"
    root.mkdir(parents=True)
    await _insert_org_agent(migrated_db, "orion-ops")
    pid = await _insert_project(migrated_db, "miragold", root)
    await _insert_asset(migrated_db, "agents", pid, "debugger")

    workspace_body = client.get("/api/v1/command-center/invocables").json()
    project_body = client.get(
        "/api/v1/command-center/invocables", params={"cwd": str(root)}
    ).json()

    assert [a["name"] for a in workspace_body["agents"]] == ["orion-ops", "debugger"]
    assert [a["name"] for a in project_body["agents"]] == ["debugger"]
    assert project_body["project_name"] == "miragold"
