"""Cross-project agent name collisions in the shared workspace.

Claude Code resolves an agent by its frontmatter ``name:``, not by its filename,
so disambiguating *filenames* does nothing: two projects shipping a
``code-reviewer`` would still both declare that one name and the CLI would pick
one silently. A symlink cannot fix it either — the link and its target are the
same bytes.

So a contested name is aliased instead: every claimant gets
``<project-slug>--<name>`` and its workspace entry is *generated* (a copy with the
frontmatter rewritten) rather than linked. Nobody keeps the bare form, so which
project was imported first stops deciding who owns the short name.

The only agent still left out is one that declares no frontmatter ``name:`` at all
(nothing to rewrite) while something else already answers to its bare name. These
tests pin all of that, and pin that skills are untouched by it — they resolve by
directory name, which the existing prefixing genuinely disambiguates.
"""

from __future__ import annotations

import pathlib
import stat
from unittest.mock import patch

import aiosqlite
import pytest

from app.services import command_center_service

_UNSET = object()


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
    frontmatter_name: object = _UNSET,
) -> int:
    """Insert a project agent.

    ``frontmatter_name`` defaults to *name*, which is what the scanner records for
    a normal agent file. Pass ``None`` for a file that declares no ``name:`` — the
    one case that cannot be aliased.
    """
    raw = name if frontmatter_name is _UNSET else frontmatter_name
    cur = await db.execute(
        """INSERT INTO project_agents
               (project_id, name, frontmatter_name_raw, canonical_path, link_path,
                enabled)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (project_id, name, raw, canonical, canonical, enabled),
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


def _agents(desired: list[dict]) -> list[dict]:
    return [d for d in desired if d["bucket"] == "agents"]


# ---------------------------------------------------------------------------
# Alias policy
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_same_named_agents_are_aliased_for_every_claimant(
    migrated_db: aiosqlite.Connection,
):
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", "/w/alpha/cr.md")
    await _insert_agent(migrated_db, second, "code-reviewer", "/w/beta/cr.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    agents = _agents(desired)
    assert conflicts == [], "both are invocable now, so nothing is shadowed"
    assert {a["alias"] for a in agents} == {
        "alpha--code-reviewer",
        "beta--code-reviewer",
    }
    # Nobody keeps the bare name: it would resolve to whichever project won a race.
    assert "code-reviewer" not in {a["alias"] for a in agents}
    assert all(a["materialize"] for a in agents)
    # The filename stem must equal the declared name, or the CLI resolves neither.
    assert all(a["filename"] == f"{a['alias']}.md" for a in agents)


@pytest.mark.asyncio
async def test_the_alias_does_not_depend_on_import_order(
    migrated_db: aiosqlite.Connection,
):
    """Inserting beta's agent first must produce the same two aliases."""
    second = await _insert_project(migrated_db, "beta")
    first = await _insert_project(migrated_db, "alpha")
    await _insert_agent(migrated_db, second, "code-reviewer", "/w/beta/cr.md")
    await _insert_agent(migrated_db, first, "code-reviewer", "/w/alpha/cr.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    assert conflicts == []
    assert {a["alias"] for a in _agents(desired)} == {
        "alpha--code-reviewer",
        "beta--code-reviewer",
    }


@pytest.mark.asyncio
async def test_a_unique_name_stays_bare_and_stays_a_link(
    migrated_db: aiosqlite.Connection,
):
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "reviewer", "/w/alpha/a.md")
    await _insert_agent(migrated_db, second, "planner", "/w/beta/b.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    agents = _agents(desired)
    assert conflicts == []
    assert {a["alias"] for a in agents} == {"reviewer", "planner"}
    assert not any(a["materialize"] for a in agents), (
        "an uncontested agent keeps its symlink, so editing the project file is "
        "still editing the agent the CLI runs"
    )


@pytest.mark.asyncio
async def test_an_org_agent_keeps_the_bare_name_and_the_project_agent_aliases(
    migrated_db: aiosqlite.Connection,
):
    """Org agents are app-owned and never renamed — but the project's namesake is
    no longer dropped for it."""
    await _insert_org_agent(migrated_db, "orion", "/org/orion.md")
    pid = await _insert_project(migrated_db, "alpha")
    await _insert_agent(migrated_db, pid, "orion", "/w/alpha/orion.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    agents = _agents(desired)
    assert conflicts == []
    by_table = {a["table"]: a for a in agents}
    assert by_table["org_agents"]["alias"] == "orion"
    assert by_table["org_agents"]["materialize"] is False
    assert by_table["project_agents"]["alias"] == "alpha--orion"
    assert by_table["project_agents"]["materialize"] is True


@pytest.mark.asyncio
async def test_a_disabled_duplicate_leaves_the_survivor_bare(
    migrated_db: aiosqlite.Connection,
):
    """Disabling one of the pair is still a valid resolution — and the one left
    is uncontested, so it keeps the short name."""
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", "/w/alpha/cr.md")
    await _insert_agent(
        migrated_db, second, "code-reviewer", "/w/beta/cr.md", enabled=0
    )

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    assert conflicts == []
    assert [a["alias"] for a in _agents(desired)] == ["code-reviewer"]


@pytest.mark.asyncio
async def test_an_inactive_project_leaves_the_survivor_bare(
    migrated_db: aiosqlite.Connection,
):
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta", is_active=0)
    await _insert_agent(migrated_db, first, "code-reviewer", "/w/alpha/cr.md")
    await _insert_agent(migrated_db, second, "code-reviewer", "/w/beta/cr.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    assert conflicts == []
    assert [a["alias"] for a in _agents(desired)] == ["code-reviewer"]


# ---------------------------------------------------------------------------
# The residue: files that cannot carry an alias
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_agent_without_frontmatter_keeps_the_bare_name(
    migrated_db: aiosqlite.Connection,
):
    """It cannot be renamed, so it gets the name it can answer to and the one that
    *can* be rewritten takes the alias. Both stay invocable."""
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(
        migrated_db, first, "code-reviewer", "/w/alpha/cr.md", frontmatter_name=None
    )
    await _insert_agent(migrated_db, second, "code-reviewer", "/w/beta/cr.md")

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    agents = {a["table"] + str(a["row_id"]): a for a in _agents(desired)}
    aliases = {a["alias"] for a in agents.values()}
    assert conflicts == []
    assert aliases == {"code-reviewer", "beta--code-reviewer"}
    bare = next(a for a in agents.values() if a["alias"] == "code-reviewer")
    assert bare["canonical_path"] == "/w/alpha/cr.md"
    assert bare["materialize"] is False


@pytest.mark.asyncio
async def test_two_agents_without_frontmatter_still_conflict(
    migrated_db: aiosqlite.Connection,
):
    """Neither file can be rewritten, so only one can be linked — the case the
    conflict report exists for."""
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(
        migrated_db, first, "code-reviewer", "/w/alpha/cr.md", frontmatter_name=None
    )
    await _insert_agent(
        migrated_db, second, "code-reviewer", "/w/beta/cr.md", frontmatter_name=None
    )

    desired, conflicts = await command_center_service._collect_desired_links(
        migrated_db
    )

    assert [a["alias"] for a in _agents(desired)] == ["code-reviewer"]
    assert len(conflicts) == 1
    assert conflicts[0]["project"] == "beta"
    assert conflicts[0]["shadowed_by"] == "alpha"
    # The path is what the user needs in order to go and rename it.
    assert conflicts[0]["canonical_path"] == "/w/beta/cr.md"


@pytest.mark.asyncio
async def test_conflicts_are_reported_by_the_health_view(
    migrated_db: aiosqlite.Connection,
):
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(
        migrated_db, first, "code-reviewer", "/w/alpha/cr.md", frontmatter_name=None
    )
    await _insert_agent(
        migrated_db, second, "code-reviewer", "/w/beta/cr.md", frontmatter_name=None
    )

    conflicts = await command_center_service.list_agent_name_conflicts(migrated_db)

    assert [c["name"] for c in conflicts] == ["code-reviewer"]


@pytest.mark.asyncio
async def test_aliasable_duplicates_clear_the_health_view(
    migrated_db: aiosqlite.Connection,
):
    """The install this shipped for: three projects, one `code-reviewer` each."""
    for project in ("codenest-app", "networa", "miragold"):
        pid = await _insert_project(migrated_db, project)
        await _insert_agent(migrated_db, pid, "code-reviewer", f"/w/{project}/cr.md")

    conflicts = await command_center_service.list_agent_name_conflicts(migrated_db)

    assert conflicts == []


# ---------------------------------------------------------------------------
# Skills are untouched
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_same_named_skills_both_link_under_distinct_directories(
    migrated_db: aiosqlite.Connection,
):
    """Skills resolve by directory name, so prefixing really does disambiguate —
    no rewrite, no copy.
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
    assert {s["filename"] for s in skills} == {"deploy", "beta--deploy"}
    assert {s["alias"] for s in skills} == {"deploy", "beta--deploy"}
    assert not any(s["materialize"] for s in skills)
    assert conflicts == []


# ---------------------------------------------------------------------------
# End to end against a real workspace directory
# ---------------------------------------------------------------------------


def _write_agent(path: pathlib.Path, name: str, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nname: {name}\ndescription: d\n---\n{body}\n")


@pytest.mark.asyncio
async def test_regeneration_materializes_both_duplicates(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
):
    alpha_agent = tmp_path / "alpha" / "cr.md"
    beta_agent = tmp_path / "beta" / "cr.md"
    solo_agent = tmp_path / "alpha" / "solo.md"
    _write_agent(alpha_agent, "code-reviewer", "alpha")
    _write_agent(beta_agent, "code-reviewer", "beta")
    _write_agent(solo_agent, "solo", "solo")

    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", str(alpha_agent))
    await _insert_agent(migrated_db, first, "solo", str(solo_agent))
    await _insert_agent(migrated_db, second, "code-reviewer", str(beta_agent))

    from app.config import settings as real_settings

    workspace = tmp_path / "workspace"
    with patch.object(real_settings, "WORKSPACE_ROOT", workspace):
        regen = await command_center_service.regenerate_workspace_links(migrated_db)

    agents_dir = workspace / ".claude" / "agents"
    assert regen["conflicts"] == []
    assert regen["counts"]["project_agents_linked"] == 3
    assert sorted(p.name for p in agents_dir.iterdir()) == [
        "alpha--code-reviewer.md",
        "beta--code-reviewer.md",
        "solo.md",
    ]

    # Each generated copy declares its own alias and points at its source.
    alpha_copy = (agents_dir / "alpha--code-reviewer.md").read_text()
    assert "name: alpha--code-reviewer" in alpha_copy
    assert "alpha" in alpha_copy
    assert str(alpha_agent) in alpha_copy
    assert (
        "name: beta--code-reviewer"
        in (agents_dir / "beta--code-reviewer.md").read_text()
    )

    # Copies are read-only; the uncontested agent is still a symlink.
    for name in ("alpha--code-reviewer.md", "beta--code-reviewer.md"):
        entry = agents_dir / name
        assert not entry.is_symlink()
        assert not (entry.stat().st_mode & stat.S_IWUSR)
    assert (agents_dir / "solo.md").is_symlink()

    # …and the rows say which is which.
    rows = await (
        await migrated_db.execute(
            """SELECT p.name AS project, pa.name AS agent, pa.link_type,
                      pa.verify_status
                 FROM project_agents pa
                 JOIN projects p ON p.id = pa.project_id
                ORDER BY p.name, pa.name"""
        )
    ).fetchall()
    assert [tuple(r) for r in rows] == [
        ("alpha", "code-reviewer", "copy", "ok"),
        ("alpha", "solo", "symlink", "ok"),
        ("beta", "code-reviewer", "copy", "ok"),
    ]

    # The source files are untouched by any of it.
    assert "name: code-reviewer" in alpha_agent.read_text()


@pytest.mark.asyncio
async def test_regeneration_is_repeatable_over_read_only_copies(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
):
    """The second pass has to delete the read-only files the first one wrote."""
    alpha_agent = tmp_path / "alpha" / "cr.md"
    beta_agent = tmp_path / "beta" / "cr.md"
    _write_agent(alpha_agent, "code-reviewer", "alpha")
    _write_agent(beta_agent, "code-reviewer", "beta")
    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", str(alpha_agent))
    await _insert_agent(migrated_db, second, "code-reviewer", str(beta_agent))

    from app.config import settings as real_settings

    workspace = tmp_path / "workspace"
    with patch.object(real_settings, "WORKSPACE_ROOT", workspace):
        await command_center_service.regenerate_workspace_links(migrated_db)
        # An edit to the project file must reach the workspace on the next pass —
        # a generated copy is only correct because it is regenerated.
        _write_agent(alpha_agent, "code-reviewer", "alpha edited")
        regen = await command_center_service.regenerate_workspace_links(migrated_db)

    copy = workspace / ".claude" / "agents" / "alpha--code-reviewer.md"
    assert regen["failed"] == []
    assert "alpha edited" in copy.read_text()


@pytest.mark.asyncio
async def test_a_file_that_lost_its_frontmatter_is_reported_not_linked(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
):
    """The DB says the name came from frontmatter, the file no longer has any:
    the alias cannot be written, so the row is marked and reported."""
    alpha_agent = tmp_path / "alpha" / "cr.md"
    beta_agent = tmp_path / "beta" / "cr.md"
    _write_agent(alpha_agent, "code-reviewer", "alpha")
    beta_agent.parent.mkdir(parents=True)
    beta_agent.write_text("# no frontmatter any more\n")

    first = await _insert_project(migrated_db, "alpha")
    second = await _insert_project(migrated_db, "beta")
    await _insert_agent(migrated_db, first, "code-reviewer", str(alpha_agent))
    beta_row = await _insert_agent(
        migrated_db, second, "code-reviewer", str(beta_agent)
    )

    from app.config import settings as real_settings

    workspace = tmp_path / "workspace"
    with patch.object(real_settings, "WORKSPACE_ROOT", workspace):
        regen = await command_center_service.regenerate_workspace_links(migrated_db)

    assert len(regen["failed"]) == 1
    assert "alias rewrite" in regen["failed"][0]["reason"]
    row = await (
        await migrated_db.execute(
            "SELECT verify_status FROM project_agents WHERE id = ?", (beta_row,)
        )
    ).fetchone()
    assert row[0] == "mismatch"
    linked = sorted(p.name for p in (workspace / ".claude" / "agents").iterdir())
    assert linked == ["alpha--code-reviewer.md"]
