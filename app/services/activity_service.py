import aiosqlite


async def log_activity(
    db: aiosqlite.Connection,
    entity_type: str,
    entity_id: int,
    action: str,
    old_value: str | None = None,
    new_value: str | None = None,
    actor: str = "system",
    project_id: int | None = None,
):
    await db.execute(
        "INSERT INTO activity_log "
        "(entity_type, entity_id, action, old_value, new_value, actor, project_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (entity_type, entity_id, action, old_value, new_value, actor, project_id),
    )
    await db.commit()
