import aiosqlite
from datetime import date
from .activity_service import log_activity
from . import notification_service


_SORT_CLAUSES = {
    "created_at_asc": "t.created_at ASC",
    "priority": "CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END",
    "project": "p.name ASC, t.created_at DESC",
}
_DEFAULT_SORT = "t.created_at DESC"


async def get_all_tasks(db: aiosqlite.Connection, filters: dict | None = None):
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
    return await rows.fetchall()


async def get_task(db: aiosqlite.Connection, task_id: int):
    row = await db.execute(
        "SELECT t.*, m.name as assignee_name, p.name as project_name "
        "FROM tasks t "
        "LEFT JOIN members m ON t.assignee_id = m.id "
        "LEFT JOIN projects p ON t.project_id = p.id "
        "WHERE t.id = ?",
        (task_id,),
    )
    return await row.fetchone()


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
            params.append(str(date.today()))
        elif data["status"] == "done" and current["status"] != "done":
            fields.append("completed_date = ?")
            params.append(str(date.today()))

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
