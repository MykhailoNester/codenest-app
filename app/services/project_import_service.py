"""Import a scanned project into the DB and regenerate workspace links."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import aiosqlite

from app.services import command_center_service, project_scanner_service

logger = logging.getLogger(__name__)


async def _resolve_default_profile_id(db: aiosqlite.Connection) -> int | None:
    """Return the stored default_profile_id from app_settings, or None."""
    row = await (
        await db.execute(
            "SELECT value_json FROM app_settings WHERE key = 'default_profile_id'"
        )
    ).fetchone()
    if not row:
        return None
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return None


async def import_project(
    db: aiosqlite.Connection,
    *,
    root_path: str,
    name: str | None = None,
    tech_stack: str | None = None,
    enable_agents: bool = True,
    enable_skills: bool = False,
    enable_commands: bool = False,
    profile_id: int | None = None,
) -> dict:
    """Scan a project, write project + project_agents rows, regenerate workspace links.

    ``profile_id`` defaults to the stored ``default_profile_id`` app_setting
    (set by bootstrap) when not explicitly provided by the caller.
    """
    scan = project_scanner_service.scan_project(root_path)
    project_name = (name or scan.project_name).strip()
    if not project_name:
        raise ValueError("project name cannot be empty")

    # Reject duplicate root_path (UNIQUE index from migration 055)
    existing = await (
        await db.execute(
            "SELECT id FROM projects WHERE root_path = ?", (scan.root_path,)
        )
    ).fetchone()
    if existing:
        raise ValueError(f"project already imported at {scan.root_path}")

    if profile_id is None:
        profile_id = await _resolve_default_profile_id(db)

    now_iso = datetime.now(timezone.utc).isoformat()
    cur = await db.execute(
        """INSERT INTO projects
           (name, description, tech_stack, status, path, root_path, git_remote,
            is_workspace, is_active, imported_at, profile_id)
           VALUES (?, NULL, ?, 'active', ?, ?, ?, 0, 1, ?, ?)""",
        (
            project_name,
            tech_stack,
            scan.root_path,
            scan.root_path,
            scan.git_remote,
            now_iso,
            profile_id,
        ),
    )
    project_id = cur.lastrowid

    agents_created = 0
    if enable_agents:
        for a in scan.agents:
            # Use canonical_path as a temporary link_path placeholder; it is
            # unique per agent (it's an absolute path to the source file) so it
            # never violates the UNIQUE index on link_path.
            # regenerate_workspace_links will replace this with the real symlink path.
            # Auto-enable on import (D3): newly discovered agents are enabled=1 so
            # their symlinks are created immediately after import.
            await db.execute(
                """INSERT INTO project_agents
                   (project_id, name, frontmatter_name_raw, description, model,
                    canonical_path, link_path, link_type, enabled, has_name_mismatch,
                    last_scanned_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'symlink', 1, ?, ?)""",
                (
                    project_id,
                    a.name,
                    a.frontmatter_name_raw,
                    a.description,
                    a.model,
                    a.canonical_path,
                    a.canonical_path,
                    int(a.has_name_mismatch),
                    now_iso,
                ),
            )
            agents_created += 1

    skills_created = 0
    if enable_skills:
        for s in scan.skills:
            # Auto-enable on import (D3): newly discovered skills are enabled=1.
            await db.execute(
                """INSERT INTO project_skills
                   (project_id, name, description, canonical_path, link_path,
                    enabled, last_scanned_at)
                   VALUES (?, ?, ?, ?, ?, 1, ?)""",
                (
                    project_id,
                    s.name,
                    s.description,
                    s.canonical_path,
                    s.canonical_path,
                    now_iso,
                ),
            )
            skills_created += 1

    commands_created = 0
    if enable_commands:
        for c in scan.commands:
            # Auto-enable on import (D3): newly discovered commands are enabled=1.
            await db.execute(
                """INSERT INTO project_commands
                   (project_id, name, description, argument_hint, canonical_path,
                    link_path, enabled, last_scanned_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?)""",
                (
                    project_id,
                    c.name,
                    c.description,
                    c.argument_hint,
                    c.canonical_path,
                    c.canonical_path,
                    now_iso,
                ),
            )
            commands_created += 1

    await db.commit()

    regen = await command_center_service.regenerate_workspace_links(db, reason="import")

    return {
        "project_id": project_id,
        "profile_id": profile_id,
        "agents_created": agents_created,
        "skills_created": skills_created,
        "commands_created": commands_created,
        "links_created": regen["total"],
        "links_failed": regen["failed"],
        "warnings": scan.warnings,
    }


async def rescan_project(db: aiosqlite.Connection, project_id: int) -> dict:
    """Re-walk a project's .claude/ directory; add new assets, mark removed ones disabled.

    Covers all three buckets — agents, skills and commands — which makes it the
    backfill for anything a past import left out (see the commands branch below).
    """
    row = await (
        await db.execute(
            "SELECT root_path, name FROM projects WHERE id = ? AND is_workspace = 0",
            (project_id,),
        )
    ).fetchone()
    if not row:
        raise ValueError(f"project {project_id} not found or is the workspace project")
    root_path, _proj_name = row[0], row[1]

    scan = project_scanner_service.scan_project(root_path)
    now_iso = datetime.now(timezone.utc).isoformat()

    cur = await db.execute(
        "SELECT id, name FROM project_agents WHERE project_id = ?", (project_id,)
    )
    existing = {r[1]: r[0] for r in await cur.fetchall()}
    scanned_names = {a.name for a in scan.agents}

    added = 0
    updated = 0
    disabled = 0
    for a in scan.agents:
        if a.name in existing:
            await db.execute(
                """UPDATE project_agents SET
                       frontmatter_name_raw = ?, description = ?, model = ?,
                       canonical_path = ?, has_name_mismatch = ?, last_scanned_at = ?
                   WHERE id = ?""",
                (
                    a.frontmatter_name_raw,
                    a.description,
                    a.model,
                    a.canonical_path,
                    int(a.has_name_mismatch),
                    now_iso,
                    existing[a.name],
                ),
            )
            updated += 1
        else:
            # Auto-enable newly discovered agents on rescan (D3).
            await db.execute(
                """INSERT INTO project_agents
                   (project_id, name, frontmatter_name_raw, description, model,
                    canonical_path, link_path, link_type, enabled, has_name_mismatch,
                    last_scanned_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'symlink', 1, ?, ?)""",
                (
                    project_id,
                    a.name,
                    a.frontmatter_name_raw,
                    a.description,
                    a.model,
                    a.canonical_path,
                    a.canonical_path,
                    int(a.has_name_mismatch),
                    now_iso,
                ),
            )
            added += 1

    for name, agent_id in existing.items():
        if name not in scanned_names:
            await db.execute(
                "UPDATE project_agents SET enabled = 0, last_scanned_at = ? WHERE id = ?",
                (now_iso, agent_id),
            )
            disabled += 1

    # Skills
    cur = await db.execute(
        "SELECT id, name FROM project_skills WHERE project_id = ?", (project_id,)
    )
    existing_skills = {r[1]: r[0] for r in await cur.fetchall()}
    scanned_skill_names = {s.name for s in scan.skills}

    skills_added = 0
    skills_updated = 0
    skills_disabled = 0
    for s in scan.skills:
        if s.name in existing_skills:
            await db.execute(
                """UPDATE project_skills SET
                       description = ?, canonical_path = ?, last_scanned_at = ?
                   WHERE id = ?""",
                (s.description, s.canonical_path, now_iso, existing_skills[s.name]),
            )
            skills_updated += 1
        else:
            # Auto-enable newly discovered skills on rescan (D3).
            await db.execute(
                """INSERT INTO project_skills
                   (project_id, name, description, canonical_path, link_path,
                    enabled, last_scanned_at)
                   VALUES (?, ?, ?, ?, ?, 1, ?)""",
                (
                    project_id,
                    s.name,
                    s.description,
                    s.canonical_path,
                    s.canonical_path,
                    now_iso,
                ),
            )
            skills_added += 1

    for name, skill_id in existing_skills.items():
        if name not in scanned_skill_names:
            await db.execute(
                "UPDATE project_skills SET enabled = 0, last_scanned_at = ? WHERE id = ?",
                (now_iso, skill_id),
            )
            skills_disabled += 1

    # Commands
    cur = await db.execute(
        "SELECT id, name FROM project_commands WHERE project_id = ?", (project_id,)
    )
    existing_commands = {r[1]: r[0] for r in await cur.fetchall()}
    scanned_command_names = {c.name for c in scan.commands}

    commands_added = 0
    commands_updated = 0
    commands_disabled = 0
    for c in scan.commands:
        if c.name in existing_commands:
            await db.execute(
                """UPDATE project_commands SET
                       description = ?, argument_hint = ?, canonical_path = ?,
                       last_scanned_at = ?
                   WHERE id = ?""",
                (
                    c.description,
                    c.argument_hint,
                    c.canonical_path,
                    now_iso,
                    existing_commands[c.name],
                ),
            )
            commands_updated += 1
        else:
            # Auto-enable newly discovered commands on rescan (D3).
            #
            # This is also the backfill path for a project imported before
            # commands were enabled at import (`enable_commands` defaulted to
            # false, so every project imported by onboarding has zero command
            # rows): a rescan finds them, inserts them enabled, and the very next
            # `regenerate_workspace_links` below links them into the workspace.
            await db.execute(
                """INSERT INTO project_commands
                   (project_id, name, description, argument_hint, canonical_path,
                    link_path, enabled, last_scanned_at)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?)""",
                (
                    project_id,
                    c.name,
                    c.description,
                    c.argument_hint,
                    c.canonical_path,
                    c.canonical_path,
                    now_iso,
                ),
            )
            commands_added += 1

    for name, command_id in existing_commands.items():
        if name not in scanned_command_names:
            await db.execute(
                "UPDATE project_commands SET enabled = 0, last_scanned_at = ? WHERE id = ?",
                (now_iso, command_id),
            )
            commands_disabled += 1

    await db.execute(
        "UPDATE projects SET last_scanned_at = ? WHERE id = ?",
        (now_iso, project_id),
    )
    await db.commit()

    regen = await command_center_service.regenerate_workspace_links(db, reason="rescan")

    return {
        "project_id": project_id,
        "agents_added": added,
        "agents_updated": updated,
        "agents_disabled": disabled,
        "skills_added": skills_added,
        "skills_updated": skills_updated,
        "skills_disabled": skills_disabled,
        "commands_added": commands_added,
        "commands_updated": commands_updated,
        "commands_disabled": commands_disabled,
        "links_regenerated": regen["total"],
        "warnings": scan.warnings,
    }
