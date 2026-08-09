from datetime import date
from typing import Any

import aiosqlite
from fastapi import HTTPException

from . import notification_service
from .activity_service import log_activity

_SORT_CLAUSES = {
    "created_at_asc": "t.created_at ASC",
    "priority": "CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END",
    "project": "p.name ASC, t.created_at DESC",
}
_DEFAULT_SORT = "t.created_at DESC"

# Keep any generated `IN (...)` list below SQLITE_MAX_VARIABLE_NUMBER (999 on
# older SQLite builds), so a long-lived board with thousands of tasks can't
# blow the limit when fetching labels for all of them at once.
_LABEL_ID_CHUNK = 500


async def _labels_by_task(
    db: aiosqlite.Connection, task_ids: list[int]
) -> dict[int, list[dict[str, Any]]]:
    """Fetch active task_label rows for a batch of tasks in one (or a few) query.

    Returns ``{}`` immediately for an empty input — an empty ``IN ()`` is a SQL
    syntax error, and an empty task list means there is nothing to fetch.
    """
    by_task: dict[int, list[dict[str, Any]]] = {}
    if not task_ids:
        return by_task
    for start in range(0, len(task_ids), _LABEL_ID_CHUNK):
        chunk = task_ids[start : start + _LABEL_ID_CHUNK]
        placeholders = ",".join("?" for _ in chunk)
        async with db.execute(
            "SELECT a.task_id AS task_id, "
            "tx.id AS id, tx.slug AS slug, tx.display_name AS label, "
            "tx.color AS color, tx.sort_order AS sort_order "
            "FROM task_label_assignments a "
            "JOIN taxonomies tx ON tx.id = a.label_id "
            f"WHERE tx.kind = 'task_label' AND tx.is_active = 1 "
            f"AND a.task_id IN ({placeholders}) "
            "ORDER BY tx.sort_order, tx.id",
            chunk,
        ) as cur:
            rows = await cur.fetchall()
        for row in rows:
            by_task.setdefault(int(row["task_id"]), []).append(
                {
                    "id": row["id"],
                    "slug": row["slug"],
                    "label": row["label"],
                    "color": row["color"],
                    "sort_order": row["sort_order"],
                }
            )
    return by_task


async def get_all_tasks(
    db: aiosqlite.Connection, filters: dict | None = None
) -> list[dict[str, Any]]:
    query = (
        "SELECT t.*, m.name as assignee_name, p.name as project_name "
        "FROM tasks t "
        "LEFT JOIN members m ON t.assignee_id = m.id "
        "LEFT JOIN projects p ON t.project_id = p.id"
    )
    conditions = []
    params = []

    if filters:
        if "status" in filters:
            conditions.append("t.status = ?")
            params.append(filters["status"])
        if "assignee_id" in filters:
            conditions.append("t.assignee_id = ?")
            params.append(filters["assignee_id"])
        if "priority" in filters:
            conditions.append("t.priority = ?")
            params.append(filters["priority"])
        if "project_id" in filters:
            conditions.append("t.project_id = ?")
            params.append(filters["project_id"])

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    sort = filters.get("sort", "") if filters else ""
    query += " ORDER BY " + _SORT_CLAUSES.get(sort, _DEFAULT_SORT)

    rows = await db.execute(query, params)
    tasks = [dict(r) for r in await rows.fetchall()]
    by_task = await _labels_by_task(db, [int(t["id"]) for t in tasks])
    for t in tasks:
        t["labels"] = by_task.get(int(t["id"]), [])
    return tasks


async def get_task(db: aiosqlite.Connection, task_id: int) -> dict[str, Any] | None:
    row = await db.execute(
        "SELECT t.*, m.name as assignee_name, p.name as project_name "
        "FROM tasks t "
        "LEFT JOIN members m ON t.assignee_id = m.id "
        "LEFT JOIN projects p ON t.project_id = p.id "
        "WHERE t.id = ?",
        (task_id,),
    )
    result = await row.fetchone()
    if result is None:
        return None
    task = dict(result)
    by_task = await _labels_by_task(db, [task_id])
    task["labels"] = by_task.get(task_id, [])
    return task


async def create_task(db: aiosqlite.Connection, data: dict) -> int:
    if not data.get("project_id"):
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="project_id is required")
    cursor = await db.execute(
        "INSERT INTO tasks (title, description, status, priority, effort, assignee_id, source_item_id, project_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            data["title"],
            data.get("description"),
            data.get("status", "todo"),
            data.get("priority", "medium"),
            data.get("effort"),
            data.get("assignee_id"),
            data.get("source_item_id"),
            data.get("project_id"),
        ),
    )
    await db.commit()
    task_id = cursor.lastrowid
    assert task_id is not None
    await log_activity(
        db,
        "task",
        task_id,
        "created",
        new_value=data["title"],
        project_id=data.get("project_id"),
    )
    return task_id


async def update_task(db: aiosqlite.Connection, task_id: int, data: dict):
    current = await get_task(db, task_id)
    if not current:
        return

    if "project_id" in data and not data["project_id"]:
        from fastapi import HTTPException

        raise HTTPException(status_code=400, detail="project_id is required")

    fields = []
    params = []
    for key in (
        "title",
        "description",
        "status",
        "priority",
        "effort",
        "assignee_id",
        "project_id",
    ):
        if key in data:
            fields.append(f"{key} = ?")
            params.append(data[key])

    if not fields:
        return

    fields.append("updated_at = CURRENT_TIMESTAMP")

    if "status" in data:
        if data["status"] == "in-progress" and current["status"] != "in-progress":
            fields.append("started_date = ?")
            params.append(str(date.today()))  # noqa: DTZ011
        elif data["status"] == "done" and current["status"] != "done":
            fields.append("completed_date = ?")
            params.append(str(date.today()))  # noqa: DTZ011

    params.append(task_id)
    await db.execute(f"UPDATE tasks SET {', '.join(fields)} WHERE id = ?", params)
    await db.commit()

    if "assignee_id" in data and data["assignee_id"] != current["assignee_id"]:
        assignee_name = data["assignee_id"]
        if data["assignee_id"] is not None:
            m = await db.execute(
                "SELECT name FROM members WHERE id = ?", (data["assignee_id"],)
            )
            member = await m.fetchone()
            if member:
                assignee_name = member["name"]
        await notification_service.emit(
            db,
            type="task_assigned",
            title=f'Task "{current["title"]}" assigned to {assignee_name}',
            payload={
                "task_id": task_id,
                "task_title": current["title"],
                "assignee_id": data["assignee_id"],
            },
            target=str(assignee_name) if assignee_name is not None else None,
            priority="normal",
        )

    if "status" in data and data["status"] != current["status"]:
        await log_activity(
            db,
            "task",
            task_id,
            "status_changed",
            current["status"],
            data["status"],
            project_id=current["project_id"],
        )
        if data["status"] == "done":
            await _cascade_unblock(db, task_id)


async def change_task_status(db: aiosqlite.Connection, task_id: int, new_status: str):
    await update_task(db, task_id, {"status": new_status})


async def delete_task(db: aiosqlite.Connection, task_id: int):
    from app.services import launch_override_service

    task = await get_task(db, task_id)
    if task:
        await db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        await db.commit()
        await log_activity(
            db,
            "task",
            task_id,
            "deleted",
            old_value=task["title"],
            project_id=task["project_id"],
        )
        # D2 cascade: explicitly remove any saved per-source launch override.
        await launch_override_service.delete_override(db, "task", task_id)


async def add_blocker(
    db: aiosqlite.Connection, blocked_task_id: int, blocking_task_id: int
):
    await db.execute(
        "INSERT OR IGNORE INTO task_blockers (blocked_task_id, blocking_task_id) VALUES (?, ?)",
        (blocked_task_id, blocking_task_id),
    )
    await db.commit()
    blocked = await get_task(db, blocked_task_id)
    await log_activity(
        db,
        "task",
        blocked_task_id,
        "blocker_added",
        new_value=str(blocking_task_id),
        project_id=blocked["project_id"] if blocked else None,
    )


async def remove_blocker(db: aiosqlite.Connection, blocker_id: int):
    await db.execute("DELETE FROM task_blockers WHERE id = ?", (blocker_id,))
    await db.commit()


async def get_task_blockers(db: aiosqlite.Connection, task_id: int):
    rows = await db.execute(
        "SELECT tb.*, t.title as blocking_title, t.status as blocking_status "
        "FROM task_blockers tb JOIN tasks t ON tb.blocking_task_id = t.id "
        "WHERE tb.blocked_task_id = ? AND tb.resolved = 0",
        (task_id,),
    )
    return await rows.fetchall()


async def _cascade_unblock(db: aiosqlite.Connection, completed_task_id: int):
    await db.execute(
        "UPDATE task_blockers SET resolved = 1 WHERE blocking_task_id = ?",
        (completed_task_id,),
    )
    await db.commit()

    rows = await db.execute(
        "SELECT DISTINCT blocked_task_id FROM task_blockers WHERE blocking_task_id = ? AND resolved = 1",
        (completed_task_id,),
    )
    blocked_tasks = await rows.fetchall()

    for bt in blocked_tasks:
        blocked_id = bt["blocked_task_id"]
        row = await db.execute(
            "SELECT COUNT(*) as cnt FROM task_blockers WHERE blocked_task_id = ? AND resolved = 0",
            (blocked_id,),
        )
        r = await row.fetchone()
        if r is not None and r["cnt"] == 0:
            task = await get_task(db, blocked_id)
            if task and task["status"] == "blocked":
                await db.execute(
                    "UPDATE tasks SET status = 'todo', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (blocked_id,),
                )
                await db.commit()
                await log_activity(
                    db,
                    "task",
                    blocked_id,
                    "status_changed",
                    "blocked",
                    "todo",
                    actor=f"cascade from task #{completed_task_id}",
                    project_id=task["project_id"] if task else None,
                )
                await notification_service.emit(
                    db,
                    type="blocker_resolved",
                    title=f'Task "{task["title"]}" unblocked',
                    body="All blockers resolved — ready to start.",
                    payload={
                        "task_id": blocked_id,
                        "task_title": task["title"],
                    },
                    priority="normal",
                )


# --- Task labels (many-to-many via task_label_assignments) -----------------
#
# A task carries any number of `task_label` taxonomy rows. Cascade on task
# deletion is the FK (task_label_assignments.task_id ON DELETE CASCADE,
# migration 004), not an explicit DELETE here — the same pattern task_blockers
# already relies on above. That also covers raw `DELETE FROM tasks` paths
# (e.g. the factory reset) that never call delete_task.


async def _task_exists(db: aiosqlite.Connection, task_id: int) -> bool:
    async with db.execute("SELECT 1 FROM tasks WHERE id = ?", (task_id,)) as cur:
        return await cur.fetchone() is not None


async def _assert_task(db: aiosqlite.Connection, task_id: int) -> None:
    if not await _task_exists(db, task_id):
        raise HTTPException(status_code=404, detail="task not found")


async def _task_project_id(db: aiosqlite.Connection, task_id: int) -> int | None:
    async with db.execute(
        "SELECT project_id FROM tasks WHERE id = ?", (task_id,)
    ) as cur:
        row = await cur.fetchone()
    return row["project_id"] if row else None


async def _label_slug(db: aiosqlite.Connection, label_id: int) -> str:
    async with db.execute(
        "SELECT slug FROM taxonomies WHERE id = ?", (label_id,)
    ) as cur:
        row = await cur.fetchone()
    return row["slug"] if row else str(label_id)


async def _assert_label_ids(db: aiosqlite.Connection, label_ids: list[int]) -> None:
    """Every id must be an *active* task_label row.

    This is the invariant that stops a task being tagged with, say, the
    `high` priority id — priority ids and label ids live in the same
    `taxonomies` table — and stops a deactivated (hidden) label from being
    newly assigned.
    """
    if not label_ids:
        return
    placeholders = ",".join("?" for _ in label_ids)
    async with db.execute(
        "SELECT id FROM taxonomies WHERE kind = 'task_label' AND is_active = 1 "
        f"AND id IN ({placeholders})",
        label_ids,
    ) as cur:
        present = {row["id"] for row in await cur.fetchall()}
    missing = sorted(set(label_ids) - present)
    if missing:
        raise HTTPException(
            status_code=400, detail=f"not an active task_label id: {missing}"
        )


async def list_task_labels(
    db: aiosqlite.Connection, task_id: int
) -> list[dict[str, Any]]:
    await _assert_task(db, task_id)
    by_task = await _labels_by_task(db, [task_id])
    return by_task.get(task_id, [])


async def add_task_label(db: aiosqlite.Connection, task_id: int, label_id: int) -> None:
    await _assert_task(db, task_id)
    await _assert_label_ids(db, [label_id])
    await db.execute(
        "INSERT OR IGNORE INTO task_label_assignments (task_id, label_id) "
        "VALUES (?, ?)",
        (task_id, label_id),
    )
    await db.commit()
    await log_activity(
        db,
        "task",
        task_id,
        "label_added",
        new_value=await _label_slug(db, label_id),
        project_id=await _task_project_id(db, task_id),
    )


async def remove_task_label(
    db: aiosqlite.Connection, task_id: int, label_id: int
) -> None:
    """Remove one assignment. Removing an unassigned pair is a silent success
    so two clients can race the same untag — no `is_active` requirement, so a
    hidden assignment can still be explicitly dropped."""
    await _assert_task(db, task_id)
    slug = await _label_slug(db, label_id)
    await db.execute(
        "DELETE FROM task_label_assignments WHERE task_id = ? AND label_id = ?",
        (task_id, label_id),
    )
    await db.commit()
    await log_activity(
        db,
        "task",
        task_id,
        "label_removed",
        old_value=slug,
        project_id=await _task_project_id(db, task_id),
    )


async def set_task_labels(
    db: aiosqlite.Connection, task_id: int, label_ids: list[int]
) -> list[dict[str, Any]]:
    """Replace the whole label set for a task.

    Validates the entire requested list before mutating anything (same
    discipline as taxonomy_service.reorder) so a bad id leaves the existing
    set untouched. A deactivated label's assignment is never destroyed by the
    delete step below, even though it is invisible to the read path — the
    delete only targets assignments to *active* labels, and the picker this
    feeds is built from the active vocabulary anyway.
    """
    await _assert_task(db, task_id)
    # Dedupe, preserving order.
    deduped: list[int] = list(dict.fromkeys(label_ids))
    await _assert_label_ids(db, deduped)

    if deduped:
        keep_placeholders = ",".join("?" for _ in deduped)
        await db.execute(
            "DELETE FROM task_label_assignments "
            f"WHERE task_id = ? AND label_id NOT IN ({keep_placeholders}) "
            "AND label_id IN "
            "(SELECT id FROM taxonomies WHERE kind = 'task_label' AND is_active = 1)",
            (task_id, *deduped),
        )
    else:
        # Nothing to keep: clear every *active* assignment, leaving a
        # deactivated label's assignment untouched.
        await db.execute(
            "DELETE FROM task_label_assignments "
            "WHERE task_id = ? AND label_id IN "
            "(SELECT id FROM taxonomies WHERE kind = 'task_label' AND is_active = 1)",
            (task_id,),
        )
    for label_id in deduped:
        await db.execute(
            "INSERT OR IGNORE INTO task_label_assignments (task_id, label_id) "
            "VALUES (?, ?)",
            (task_id, label_id),
        )
    await db.commit()

    labels = await list_task_labels(db, task_id)
    slugs = ",".join(label["slug"] for label in labels)
    await log_activity(
        db,
        "task",
        task_id,
        "labels_set",
        new_value=slugs,
        project_id=await _task_project_id(db, task_id),
    )
    return labels
