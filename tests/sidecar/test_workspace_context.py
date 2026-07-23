"""Tests for workspace path-awareness (CLAUDE.md block, context, projects skill)."""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest

from app.config import settings
from app.services import workspace_context_service as wc


async def _add_project(db: aiosqlite.Connection, name: str, root: str) -> None:
    await db.execute(
        "INSERT INTO projects (name, status, path, root_path, is_workspace, is_active) "
        "VALUES (?, 'active', ?, ?, 0, 1)",
        (name, root, root),
    )
    await db.commit()


def test_build_projects_block() -> None:
    block = wc.build_projects_block([("a", "/p/a"), ("b", "/p/b")])
    assert block.startswith("<!-- BEGIN codenest:projects")
    assert block.rstrip().endswith("-->")
    assert "## Workspace Projects" in block
    assert "| a | /p/a |" in block and "| b | /p/b |" in block
    assert "no projects imported yet" in wc.build_projects_block([])


def test_merge_block_appends_then_replaces_idempotently() -> None:
    block1 = wc.build_projects_block([("a", "/p/a")])
    out1 = wc.merge_block("# My notes\n\nhello\n", block1)
    assert "# My notes" in out1 and "hello" in out1 and block1 in out1

    block2 = wc.build_projects_block([("a", "/p/a"), ("b", "/p/b")])
    out2 = wc.merge_block(out1, block2)
    assert "# My notes" in out2 and "hello" in out2  # surrounding preserved
    assert "| b | /p/b |" in out2
    assert out2.count("<!-- BEGIN codenest:projects") == 1  # replaced, not duplicated

    assert wc.merge_block(out2, block2) == out2  # idempotent


def test_merge_block_collapses_duplicate_blocks() -> None:
    block = wc.build_projects_block([("a", "/p/a")])
    doubled = f"{block}\n\nmiddle\n\n{block}\n"
    out = wc.merge_block(doubled, wc.build_projects_block([("b", "/p/b")]))
    assert out.count("<!-- BEGIN codenest:projects") == 1  # collapsed
    assert "| b | /p/b |" in out
    assert "middle" in out  # surrounding content preserved


def test_build_projects_block_escapes_pipes() -> None:
    block = wc.build_projects_block([("we|rd", "/p/a|b")])
    assert "we\\|rd" in block and "/p/a\\|b" in block


def test_build_session_context() -> None:
    ctx = wc.build_session_context([("alpha", "/p/alpha")])
    assert "alpha" in ctx and "/p/alpha" in ctx
    assert "no projects" in wc.build_session_context([])


@pytest.mark.asyncio
async def test_write_claude_md_creates_and_preserves(
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "WORKSPACE_ROOT", tmp_path)
    (tmp_path / "CLAUDE.md").write_text("# Hand written\n")
    await _add_project(migrated_db, "proj", "/x/proj")

    await wc.write_claude_md(migrated_db)
    text = (tmp_path / "CLAUDE.md").read_text()
    assert "# Hand written" in text
    assert "| proj | /x/proj |" in text

    # Re-run replaces the block in place (no duplicate markers).
    await wc.write_claude_md(migrated_db)
    assert (tmp_path / "CLAUDE.md").read_text().count(
        "<!-- BEGIN codenest:projects"
    ) == 1


@pytest.mark.asyncio
async def test_session_context_payload(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _add_project(migrated_db, "proj", "/x/proj")
    payload = await wc.session_context(migrated_db)
    assert {"name": "proj", "path": "/x/proj"} in payload["projects"]
    assert "/x/proj" in payload["additionalContext"]


def test_write_projects_skill(tmp_path: pathlib.Path) -> None:
    skills_root = tmp_path / "skills"
    skills_root.mkdir()
    wc.write_projects_skill(skills_root)
    skill = skills_root / "projects" / "SKILL.md"
    assert skill.exists()
    assert "name: projects" in skill.read_text()


def test_write_projects_skill_never_writes_through_a_symlink(
    tmp_path: pathlib.Path,
) -> None:
    """If a symlink occupies the projects slot, we must replace it, not write
    through it into an imported project (read-only invariant)."""
    skills_root = tmp_path / "skills"
    skills_root.mkdir()
    victim = tmp_path / "victim_project"
    victim.mkdir()
    (victim / "SKILL.md").write_text("ORIGINAL")
    (skills_root / "projects").symlink_to(victim)

    wc.write_projects_skill(skills_root)

    assert (victim / "SKILL.md").read_text() == "ORIGINAL"  # untouched
    assert not (skills_root / "projects").is_symlink()
    assert "name: projects" in (skills_root / "projects" / "SKILL.md").read_text()
