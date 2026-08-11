from typing import Any

import aiosqlite

# JSON list default + cap, mirroring feed_service.DEFAULT_LIMIT / MAX_LIMIT —
# same clamp-instead-of-reject convention for the same kind of parameter.
DEFAULT_ENTITY_LIMIT = 50
MAX_ENTITY_LIMIT = 200

_ENTITY_COLUMNS = (
    "id, entity_type, entity_id, action, old_value, new_value, actor, created_at"
)


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


async def list_for_entity(
    db: aiosqlite.Connection,
    entity_type: str,
    entity_id: int,
    limit: int = DEFAULT_ENTITY_LIMIT,
) -> list[dict[str, Any]]:
    """Newest-first ``activity_log`` rows for one entity.

    ``created_at`` is the naive-UTC SQLite ``CURRENT_TIMESTAMP`` string as
    stored — callers localise it, this function never touches the clock.
    ``idx_activity_entity(entity_type, entity_id)`` (baseline migration)
    covers this WHERE exactly. ``limit`` is clamped rather than rejected, the
    same convention ``feed_service.list_feed`` uses for its own limit.
    """
    capped = max(1, min(int(limit), MAX_ENTITY_LIMIT))
    async with db.execute(
        f"SELECT {_ENTITY_COLUMNS} FROM activity_log "
        "WHERE entity_type = ? AND entity_id = ? "
        "ORDER BY created_at DESC, id DESC LIMIT ?",
        (entity_type, entity_id, capped),
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]
