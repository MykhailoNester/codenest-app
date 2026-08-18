"""Project `.claude/commands/` — discovery, persistence and the catalog row (#47).

The bug this pins: the scanner had been finding a project's command files all
along, but nothing ever wrote them down (`enable_commands` defaulted to false at
import), so `project_commands` was empty on every install and the composer's `/`
menu could only ever offer its three built-ins. And what *was* discovered carried
no meta, so a row could say nothing but a name.

Three links in that chain, one section each: the scan reads the frontmatter, the
import and rescan persist it, and `list_invocables` hands it to the composer.
"""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest

from app.config import settings as real_settings
from app.services import project_import_service, project_scanner_service
from app.services.command_center_service import list_invocables

SHIP = """---
description: "Autonomous delivery pipeline, two lanes. Triage routes each ticket."
argument-hint: <#24 #25 … or tasks in prose> [--dry-run]
allowed-tools: Bash(git status:*), Read
---

Deliver these tasks autonomously.
"""

BARE = """No frontmatter at all — still a command the CLI resolves by its stem.
"""

SKILL = """---
name: projects
description: List the workspace's imported projects.
---

# Projects
"""


def _project_dir(tmp_path: pathlib.Path, name: str = "repo") -> pathlib.Path:
    root = tmp_path / name
    (root / ".claude" / "commands").mkdir(parents=True)
    (root / ".claude" / "commands" / "ship.md").write_text(SHIP)
    (root / ".claude" / "commands" / "bare.md").write_text(BARE)
    skill = root / ".claude" / "skills" / "projects"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(SKILL)
    return root


# ---------------------------------------------------------------------------
# The scan
# ---------------------------------------------------------------------------


def test_scan_reads_command_frontmatter(tmp_path: pathlib.Path) -> None:
    scan = project_scanner_service.scan_project(_project_dir(tmp_path))

    by_name = {c.name: c for c in scan.commands}
    assert set(by_name) == {"ship", "bare"}
    assert by_name["ship"].description.startswith("Autonomous delivery pipeline")
    assert by_name["ship"].argument_hint == "<#24 #25 … or tasks in prose> [--dry-run]"


def test_scan_keeps_a_command_that_declares_no_meta(tmp_path: pathlib.Path) -> None:
    """A command resolves by its file stem, so missing frontmatter is not fatal —
    unlike an agent, whose *name* is the frontmatter."""
    scan = project_scanner_service.scan_project(_project_dir(tmp_path))

    bare = next(c for c in scan.commands if c.name == "bare")
    assert bare.description is None
    assert bare.argument_hint is None
    assert scan.warnings == []


def test_scan_reads_a_skill_description(tmp_path: pathlib.Path) -> None:
    scan = project_scanner_service.scan_project(_project_dir(tmp_path))

    assert [s.name for s in scan.skills] == ["projects"]
    assert scan.skills[0].description == "List the workspace's imported projects."


# ---------------------------------------------------------------------------
# Import and rescan
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_import_persists_commands_with_their_meta(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(real_settings, "WORKSPACE_ROOT", tmp_path / "workspace")
        result = await project_import_service.import_project(
            migrated_db,
            root_path=str(_project_dir(tmp_path)),
            enable_commands=True,
        )

    assert result["commands_created"] == 2
    rows = {
        r["name"]: r
        for r in await (
            await migrated_db.execute(
                "SELECT name, description, argument_hint, enabled FROM project_commands"
            )
        ).fetchall()
    }
    assert rows["ship"]["description"].startswith("Autonomous delivery pipeline")
    assert rows["ship"]["argument_hint"].startswith("<#24")
    assert rows["ship"]["enabled"] == 1
    assert rows["bare"]["description"] is None


@pytest.mark.asyncio
async def test_rescan_backfills_a_project_imported_without_commands(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    """The upgrade path: every already-imported project has zero command rows,
    and a rescan is what fills them in without a re-import."""
    root = _project_dir(tmp_path)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(real_settings, "WORKSPACE_ROOT", tmp_path / "workspace")
        imported = await project_import_service.import_project(
            migrated_db,
            root_path=str(root),
            enable_commands=False,
        )
        assert imported["commands_created"] == 0

        rescan = await project_import_service.rescan_project(
            migrated_db, imported["project_id"]
        )

    assert rescan["commands_added"] == 2
    row = await (
        await migrated_db.execute(
            "SELECT description, enabled FROM project_commands WHERE name = 'ship'"
        )
    ).fetchone()
    assert row["enabled"] == 1
    assert row["description"].startswith("Autonomous delivery pipeline")


@pytest.mark.asyncio
async def test_rescan_refreshes_edited_frontmatter(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    root = _project_dir(tmp_path)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(real_settings, "WORKSPACE_ROOT", tmp_path / "workspace")
        imported = await project_import_service.import_project(
            migrated_db, root_path=str(root), enable_commands=True
        )
        (root / ".claude" / "commands" / "ship.md").write_text(
            "---\ndescription: Ships it, differently now.\n---\n"
        )
        rescan = await project_import_service.rescan_project(
            migrated_db, imported["project_id"]
        )

    assert rescan["commands_updated"] == 2
    row = await (
        await migrated_db.execute(
            "SELECT description, argument_hint FROM project_commands WHERE name = 'ship'"
        )
    ).fetchone()
    assert row["description"] == "Ships it, differently now."
    # The hint was removed from the file, so it is removed from the row — a
    # rescan reports what is on disk now, not the union with what used to be.
    assert row["argument_hint"] is None


# ---------------------------------------------------------------------------
# The catalog row the composer reads
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_catalog_carries_the_command_meta_in_both_scopes(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    root = _project_dir(tmp_path)
    workspace = tmp_path / "workspace"
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(real_settings, "WORKSPACE_ROOT", workspace)
        await project_import_service.import_project(
            migrated_db, root_path=str(root), enable_commands=True, enable_skills=True
        )

        # A pane rooted in the workspace resolves the shared `.claude/`…
        shared = await list_invocables(migrated_db)
        # …and one rooted in the project resolves the project's own.
        own = await list_invocables(migrated_db, cwd=str(root))

    for result in (shared, own):
        ship = next(c for c in result["commands"] if c["name"] == "ship")
        assert ship["invoke_token"] == "/ship"
        assert ship["description"].startswith("Autonomous delivery pipeline")
        assert ship["argument_hint"].startswith("<#24")
        assert ship["alias"] == "repo:ship"
        bare = next(c for c in result["commands"] if c["name"] == "bare")
        assert bare["description"] is None
        assert bare["argument_hint"] is None
        # #44 left the skill description as a TODO for this ticket. Selected by
        # owning project, because the workspace also links its own built-in
        # `projects` skill and this project happens to ship that very name.
        skill = next(s for s in result["skills"] if s["project_name"] == "repo")
        assert skill["description"] == "List the workspace's imported projects."
