import aiosqlite
from datetime import date
from .activity_service import log_activity


async def get_all_members(db: aiosqlite.Connection):
    rows = await db.execute(
        "SELECT * FROM members ORDER BY CASE status WHEN 'active' THEN 1 WHEN 'planned' THEN 2 WHEN 'inactive' THEN 3 END, name"
    )
    return await rows.fetchall()


async def get_member(db: aiosqlite.Connection, member_id: int):
    row = await db.execute("SELECT * FROM members WHERE id = ?", (member_id,))
    return await row.fetchone()


async def create_member(db: aiosqlite.Connection, data: dict) -> int:
    cursor = await db.execute(
        "INSERT INTO members (name, role, type, department, status, agent_file, joined_date, subtype) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            data["name"],
            data["role"],
            data.get("type", "agent"),
            data.get("department"),
            data.get("status", "active"),
            data.get("agent_file"),
            data.get("joined_date", str(date.today())),
            data.get("subtype", "persona"),
        ),
    )
    await db.commit()
    member_id = cursor.lastrowid
    assert member_id is not None
    # members have no project_id today, so the audit-feed row
    # keeps project_id NULL. Update here if member scoping is added later.
    await log_activity(db, "member", member_id, "created", new_value=data["name"])
    return member_id


async def update_member(db: aiosqlite.Connection, member_id: int, data: dict):
    current = await get_member(db, member_id)
    if not current:
        return

    fields = []
    params = []
    for key in (
        "name",
        "role",
        "type",
        "subtype",
        "department",
        "status",
        "agent_file",
        "notes",
        "joined_date",
    ):
        if key in data:
            fields.append(f"{key} = ?")
            params.append(data[key])

    if not fields:
        return

    fields.append("updated_at = CURRENT_TIMESTAMP")
    params.append(member_id)
    await db.execute(f"UPDATE members SET {', '.join(fields)} WHERE id = ?", params)
    await db.commit()

    if "status" in data and data["status"] != current["status"]:
        await log_activity(
            db, "member", member_id, "status_changed", current["status"], data["status"]
        )
