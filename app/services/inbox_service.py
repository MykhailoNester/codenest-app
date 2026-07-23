from typing import Any

import aiosqlite
from datetime import date
from fastapi import HTTPException
from .activity_service import log_activity
from .task_service import create_task

_SORT_CLAUSES = {
    "created_at_asc": "created_at ASC",
    "project": "project_id ASC, id",
    "priority_asc": "CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END ASC",
}
_DEFAULT_SORT = (
    "CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, id"
)


async def get_all_items(
    db: aiosqlite.Connection,
    status_filter: str = "",
    project_id: int | None = None,
    sort: str = "",
):
    conditions: list[str] = []
    params: list[Any] = []

    if status_filter:
        conditions.append("status = ?")
        params.append(status_filter)
    if project_id is not None:
        conditions.append("project_id = ?")
        params.append(project_id)

    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    order = " ORDER BY " + _SORT_CLAUSES.get(sort, _DEFAULT_SORT)

    rows = await db.execute(f"SELECT * FROM workflow_items{where}{order}", params)
    return await rows.fetchall()


async def get_item(db: aiosqlite.Connection, item_id: int):
    row = await db.execute("SELECT * FROM workflow_items WHERE id = ?", (item_id,))
    return await row.fetchone()


async def create_item(db: aiosqlite.Connection, data: dict) -> int:
    cursor = await db.execute(
        "INSERT INTO workflow_items (title, description, source, type, priority, status, action_text, project_id, submitted_date) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            data["title"],
            data.get("description"),
            data.get("source"),
            data.get("type", "action"),
            data.get("priority", "medium"),
            data.get("status", "inbox"),
            data.get("action_text"),
            data.get("project_id"),
            str(date.today()),
        ),
    )
    await db.commit()
    item_id = cursor.lastrowid
    assert item_id is not None
    await log_activity(
        db,
        "workflow_item",
        item_id,
        "created",
        new_value=data["title"],
        project_id=data.get("project_id"),
    )
    return item_id


async def update_item(db: aiosqlite.Connection, item_id: int, data: dict):
    current = await get_item(db, item_id)
    if not current:
        return

    fields = []
    params = []
    for key in (
        "title",
        "description",
        "source",
        "type",
        "priority",
        "status",
        "action_text",
        "project_id",
    ):
        if key in data:
            fields.append(f"{key} = ?")
            params.append(data[key])

    if "status" in data and data["status"] in ("review", "ready", "done"):
        fields.append("reviewed_date = ?")
        params.append(str(date.today()))

    if not fields:
        return

    fields.append("updated_at = CURRENT_TIMESTAMP")
    params.append(item_id)
    await db.execute(
        f"UPDATE workflow_items SET {', '.join(fields)} WHERE id = ?", params
    )
    await db.commit()

    if "status" in data and data["status"] != current["status"]:
        await log_activity(
            db,
            "workflow_item",
            item_id,
            "status_changed",
            current["status"],
            data["status"],
            project_id=current["project_id"],
        )


async def delete_item(db: aiosqlite.Connection, item_id: int):
    from app.services import launch_override_service

    item = await get_item(db, item_id)
    if item:
        await db.execute("DELETE FROM workflow_items WHERE id = ?", (item_id,))
        await db.commit()
        await log_activity(
            db,
            "workflow_item",
            item_id,
            "deleted",
            old_value=item["title"],
            project_id=item["project_id"],
        )
        # D2 cascade: explicitly remove any saved per-source launch override.
        await launch_override_service.delete_override(db, "inbox", item_id)


def _build_description(item: Any, notes: str | None) -> str:
    base = item["description"] or item["action_text"] or ""
    if notes:
        return f"{base}\n\n**Notes:** {notes}" if base else f"**Notes:** {notes}"
    return base


async def promote_to_task(db: aiosqlite.Connection, item_id: int, options: dict) -> int:
    item = await get_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail=f"Inbox item {item_id} not found")

    project_id = options.get("project_id") or item["project_id"]
    if not project_id:
        raise HTTPException(
            status_code=400, detail="project_id is required to promote an item"
        )

    task_id = await create_task(
        db,
        {
            "title": item["title"],
            "description": _build_description(item, options.get("notes")),
            "status": "todo",
            "priority": options.get("priority", item["priority"]),
            "assignee_id": options.get("assignee_id"),
            "source_item_id": item_id,
            "project_id": project_id,
        },
    )

    await db.execute(
        "UPDATE workflow_items SET status = 'done', task_id = ?, reviewed_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (task_id, str(date.today()), item_id),
    )
    await db.commit()
    await log_activity(
        db,
        "workflow_item",
        item_id,
        "promoted",
        new_value=f"task #{task_id}",
        project_id=project_id,
    )

    return task_id
