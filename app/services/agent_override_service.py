"""Per-agent launch override service.

Agents are keyed by name in this codebase (no numeric id), so they get
their own override table rather than re-using ``launch_source_overrides``
whose ``source_id`` is INTEGER. The launch-seed service consults this
table after task/inbox overrides — task-specific picks win, agent-level
picks fall through.
"""

from __future__ import annotations

import aiosqlite

from app.models.launch import AgentOverride, AgentOverrideUpsert


def _row_to_override(row: aiosqlite.Row) -> AgentOverride:
    pid_raw = row["provider_id"]
    return AgentOverride(
        agent_name=str(row["agent_name"]),
        provider_id=int(pid_raw) if pid_raw is not None else None,
        model=row["model"],
        updated_at=row["updated_at"],
    )


async def get_override(
    db: aiosqlite.Connection, agent_name: str
) -> AgentOverride | None:
    cur = await db.execute(
        "SELECT * FROM agent_launch_overrides WHERE agent_name = ?",
        (agent_name,),
    )
    row = await cur.fetchone()
    return _row_to_override(row) if row else None


async def upsert_override(
    db: aiosqlite.Connection,
    agent_name: str,
    payload: AgentOverrideUpsert,
) -> AgentOverride:
    """Merge-style upsert: a ``None`` field in the payload preserves the
    existing column value rather than nulling it. This avoids accidental
    data loss when callers send only one of provider_id / model."""
    existing = await get_override(db, agent_name)
    new_provider_id = (
        payload.provider_id
        if payload.provider_id is not None
        else (existing.provider_id if existing else None)
    )
    new_model = (
        payload.model
        if payload.model is not None
        else (existing.model if existing else None)
    )
    await db.execute(
        """
        INSERT INTO agent_launch_overrides (agent_name, provider_id, model, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(agent_name) DO UPDATE SET
            provider_id = excluded.provider_id,
            model       = excluded.model,
            updated_at  = CURRENT_TIMESTAMP
        """,
        (agent_name, new_provider_id, new_model),
    )
    await db.commit()
    stored = await get_override(db, agent_name)
    assert stored is not None
    return stored


async def delete_override(db: aiosqlite.Connection, agent_name: str) -> None:
    await db.execute(
        "DELETE FROM agent_launch_overrides WHERE agent_name = ?",
        (agent_name,),
    )
    await db.commit()
