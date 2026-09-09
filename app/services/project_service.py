import aiosqlite
from fastapi import HTTPException


async def update_project(
    db: aiosqlite.Connection, project_id: int, patch: dict
) -> None:
    """Partial update for a project row.

    Accepted keys: ``name``, ``description``, ``tech_stack``, ``status``,
    ``path``.  Providing a ``path`` that is not absolute (i.e., does not start
    with ``/``) raises a 400 error.
    """
    project = await get_project(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    allowed = {
        "name",
        "description",
        "tech_stack",
        "status",
        "path",
        "default_provider_id",
        "profile_id",
    }
    updates: list[str] = []
    params: list = []

    for key in allowed:
        if key not in patch:
            continue
        value = patch[key]
        if key == "path" and value is not None and not str(value).startswith("/"):
            raise HTTPException(
                status_code=400,
                detail=f"path must be absolute (start with '/'), got: {value!r}",
            )
        updates.append(f"{key} = ?")
        params.append(value)

    if not updates:
        return

    params.append(project_id)
    await db.execute(
        f"UPDATE projects SET {', '.join(updates)} WHERE id = ?",
        params,
    )
    await db.commit()


async def get_all_projects(db: aiosqlite.Connection):
    rows = await db.execute("SELECT * FROM projects ORDER BY name")
    return await rows.fetchall()


async def get_project(db: aiosqlite.Connection, project_id: int):
    row = await db.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
    return await row.fetchone()


async def resolve_default_profile_id(db: aiosqlite.Connection) -> int | None:
    """Return the stored default_profile_id from app_settings, or None.

    Public because every path that creates a project row needs it:
    ``create_project`` here, ``project_import_service.import_project`` and
    ``cwd_resolver_service``'s auto-discovery. A project that skips it is a
    project the workspace default profile silently does not apply to.
    """
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


async def create_project(db: aiosqlite.Connection, data: dict) -> int:
    profile_id = data.get("profile_id")
    if profile_id is None:
        profile_id = await resolve_default_profile_id(db)
    cursor = await db.execute(
        "INSERT INTO projects (name, description, tech_stack, status, path, profile_id) VALUES (?, ?, ?, ?, ?, ?)",
        (
            data["name"],
            data.get("description"),
            data.get("tech_stack"),
            data.get("status", "active"),
            data.get("path"),
            profile_id,
        ),
    )
    await db.commit()
    project_id = cursor.lastrowid
    assert project_id is not None
    return project_id


async def delete_project(db: aiosqlite.Connection, project_id: int) -> None:
    """Delete a project, preserving its historical tasks and workflow items.

    Tasks and workflow items belonging to the deleted project are reassigned
    to the special 'Unassigned' project so historical records survive.  The
    project row itself, plus any tables that don't carry historical value
    (e.g. launch_presets via FK cascade), are removed.
    """
    project = await get_project(db, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    if project["name"] == "Unassigned":
        raise HTTPException(
            status_code=400,
            detail="The 'Unassigned' project is the reassignment target and cannot be deleted.",
        )

    # Resolve the Unassigned project id (created by migration 011).
    cur = await db.execute("SELECT id FROM projects WHERE name = 'Unassigned'")
    row = await cur.fetchone()
    unassigned_id = row["id"] if row else None

    if unassigned_id is not None:
        await db.execute(
            "UPDATE tasks SET project_id = ? WHERE project_id = ?",
            (unassigned_id, project_id),
        )
        await db.execute(
            "UPDATE workflow_items SET project_id = ? WHERE project_id = ?",
            (unassigned_id, project_id),
        )
    else:
        # Fallback: orphan-but-keep when no Unassigned bucket exists.
        await db.execute(
            "UPDATE tasks SET project_id = NULL WHERE project_id = ?",
            (project_id,),
        )
        await db.execute(
            "UPDATE workflow_items SET project_id = NULL WHERE project_id = ?",
            (project_id,),
        )

    # agent_sessions also references projects via project_id (added in a later
    # migration); preserve those rows by nullifying the link.
    await db.execute(
        "UPDATE agent_sessions SET project_id = NULL WHERE project_id = ?",
        (project_id,),
    )

    await db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
    await db.commit()


async def get_project_stats_bulk(db: aiosqlite.Connection) -> dict:
    rows = await db.execute(
        "SELECT project_id, status, COUNT(*) as cnt FROM tasks WHERE project_id IS NOT NULL GROUP BY project_id, status"
    )
    task_counts_raw: dict[int, dict] = {}
    for r in await rows.fetchall():
        pid = r["project_id"]
        if pid not in task_counts_raw:
            task_counts_raw[pid] = {}
        task_counts_raw[pid][r["status"]] = r["cnt"]

    rows = await db.execute(
        "SELECT project_id, COUNT(*) as cnt FROM workflow_items WHERE project_id IS NOT NULL AND status = 'inbox' GROUP BY project_id"
    )
    inbox_counts = {r["project_id"]: r["cnt"] for r in await rows.fetchall()}

    result: dict[int, dict] = {}
    for pid in set(task_counts_raw) | set(inbox_counts):
        tc = task_counts_raw.get(pid, {})
        result[pid] = {
            "task_counts": tc,
            "inbox_count": inbox_counts.get(pid, 0),
            "total_tasks": sum(tc.values()),
        }
    return result


async def get_project_stats(db: aiosqlite.Connection, project_id: int) -> dict:
    rows = await db.execute(
        "SELECT status, COUNT(*) as cnt FROM tasks WHERE project_id = ? GROUP BY status",
        (project_id,),
    )
    task_counts = {row["status"]: row["cnt"] for row in await rows.fetchall()}

    row = await db.execute(
        "SELECT COUNT(*) as cnt FROM workflow_items WHERE project_id = ? AND status = 'inbox'",
        (project_id,),
    )
    r = await row.fetchone()
    inbox_count = r["cnt"] if r is not None else 0

    return {
        "task_counts": task_counts,
        "inbox_count": inbox_count,
        "total_tasks": sum(task_counts.values()),
    }
