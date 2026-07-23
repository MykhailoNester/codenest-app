"""Workspace path-awareness: managed CLAUDE.md block, SessionStart context,
and the built-in ``projects`` skill.

A workspace-root session needs to know where each imported project lives on
disk. Three layers provide that:

1. A managed block in ``<workspace>/CLAUDE.md`` (name → absolute path) that
   Claude loads automatically. The app owns only the delimited block; any
   hand-written content around it is preserved. Regenerated on import / remove
   / rescan (i.e. whenever workspace links are regenerated).
2. ``build_session_context`` — the same registry as a string the SessionStart
   hook injects as ``additionalContext`` (live, survives a stale file).
3. A built-in ``projects`` skill for explicit "work on project X" actions.

Paths only — never per-project AI config; each project owns its own setup.
"""

from __future__ import annotations

import re
from pathlib import Path

import aiosqlite

from app.config import settings

_BEGIN = "<!-- BEGIN codenest:projects (managed — do not edit) -->"
_END = "<!-- END codenest:projects -->"
# Full managed-block span, used to replace/collapse on rewrite.
_BLOCK_RE = re.compile(re.escape(_BEGIN) + r".*?" + re.escape(_END), re.DOTALL)

# Reserved skill name for the built-in projects skill. command_center_service's
# link builder seeds this into its seen-set so a project skill named "projects"
# is disambiguated and can never symlink over the built-in.
PROJECTS_SKILL_NAME = "projects"

_PROJECTS_SKILL = """\
---
name: projects
description: List the workspace's imported projects and resolve a project name to its absolute path. Use when the user refers to a project by name (e.g. "work on web-app") and you need its location on disk.
---

# Workspace projects

This is the Codenest command-center workspace. The imported projects and their
absolute paths are listed in the "Workspace Projects" table in the workspace
`CLAUDE.md` (already in your context).

When the user names a project:

1. Find its row in that table and use the absolute path.
2. `cd` into that path (or use it as a prefix) for any file work on that project.

If the table is missing or stale, the command center also injects the current
project list at session start.
"""


async def _imported_projects(db: aiosqlite.Connection) -> list[tuple[str, str]]:
    """Return ``(name, root_path)`` for active, non-workspace projects."""
    cur = await db.execute(
        "SELECT name, root_path FROM projects "
        "WHERE is_workspace = 0 AND is_active = 1 "
        "AND root_path IS NOT NULL AND root_path != '' "
        "ORDER BY name COLLATE NOCASE"
    )
    return [(str(r["name"]), str(r["root_path"])) for r in await cur.fetchall()]


def build_projects_block(projects: list[tuple[str, str]]) -> str:
    """Build the managed CLAUDE.md section (delimited by the marker comments)."""
    lines = [
        _BEGIN,
        "## Workspace Projects",
        "",
        "| Project | Path |",
        "|---------|------|",
    ]
    if projects:
        # Escape pipes so a name/path containing "|" can't break the table.
        lines += [f"| {_cell(name)} | {_cell(path)} |" for name, path in projects]
    else:
        lines.append("| _(no projects imported yet)_ | |")
    lines.append(_END)
    return "\n".join(lines)


def _cell(value: str) -> str:
    return value.replace("|", "\\|")


def merge_block(existing: str, block: str) -> str:
    """Replace the managed block in ``existing``, or append it, preserving the rest.

    Robust to malformed input: multiple managed blocks are collapsed to one (the
    first is replaced in place, the rest removed), so this is idempotent and
    self-healing. Orphan markers (only one of BEGIN/END, or END-before-BEGIN)
    form no span and fall through to append.
    """
    if _BLOCK_RE.search(existing):
        replaced_first = {"done": False}

        def _sub(_match: re.Match[str]) -> str:
            if replaced_first["done"]:
                return ""  # drop duplicate blocks
            replaced_first["done"] = True
            return block

        return _BLOCK_RE.sub(_sub, existing)
    base = existing.rstrip("\n")
    prefix = f"{base}\n\n" if base else ""
    return f"{prefix}{block}\n"


def build_session_context(projects: list[tuple[str, str]]) -> str:
    """Return the SessionStart ``additionalContext`` string for the registry."""
    if not projects:
        return "Codenest command-center workspace: no projects imported yet."
    lines = [
        "Codenest command-center workspace. Imported projects and their absolute paths:"
    ]
    lines += [f"- {name}: {path}" for name, path in projects]
    lines.append(
        "When the user names one of these projects, use its path above for file work."
    )
    return "\n".join(lines)


async def write_claude_md(db: aiosqlite.Connection) -> None:
    """Write/refresh the managed Workspace Projects block in workspace CLAUDE.md."""
    block = build_projects_block(await _imported_projects(db))
    path = settings.WORKSPACE_ROOT / "CLAUDE.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(merge_block(existing, block), encoding="utf-8")


def write_projects_skill(skills_root: Path) -> None:
    """Write the built-in ``projects`` skill into ``skills_root/projects/``.

    ``skills_root`` is a workspace ``.claude/skills`` directory (typically the
    regen staging copy). The name is reserved by command_center_service so a
    project skill can never symlink over it; we also defensively replace a
    symlink if one is somehow present, so we never write *through* a link into
    an imported project (read-only invariant).
    """
    skill_dir = skills_root / PROJECTS_SKILL_NAME
    if skill_dir.is_symlink():
        skill_dir.unlink()
    skill_dir.mkdir(parents=True, exist_ok=True)
    target = skill_dir / "SKILL.md"
    if target.is_symlink():
        target.unlink()
    target.write_text(_PROJECTS_SKILL, encoding="utf-8")


async def session_context(db: aiosqlite.Connection) -> dict:
    """Payload for the SessionStart context endpoint."""
    projects = await _imported_projects(db)
    return {
        "additionalContext": build_session_context(projects),
        "projects": [{"name": n, "path": p} for n, p in projects],
    }


async def regenerate(db: aiosqlite.Connection) -> None:
    """Refresh the managed CLAUDE.md block. Called after workspace-link regen.

    The built-in projects skill is staged into the ``.claude`` swap by
    command_center_service (via :func:`write_projects_skill`) so it survives the
    atomic rename; CLAUDE.md lives at the workspace root and is refreshed here.
    """
    await write_claude_md(db)
