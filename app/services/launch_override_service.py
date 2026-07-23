"""Launch override service.

Manages per-source launch override rows in `launch_source_overrides`.
Cascade deletion (D2): callers in task_service / inbox_service must call
`delete_override` after deleting the source row.
"""

from __future__ import annotations

import aiosqlite

from app.models.launch import LaunchOverride, LaunchOverrideUpsert


async def get_override(
    db: aiosqlite.Connection,
    kind: str,
    source_id: int,
) -> LaunchOverride | None:
    """Return the saved override for (kind, source_id), or None."""
    cur = await db.execute(
        "SELECT * FROM launch_source_overrides WHERE source_kind = ? AND source_id = ?",
        (kind, source_id),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    return _row_to_override(row)


async def upsert_override(
    db: aiosqlite.Connection,
    kind: str,
    source_id: int,
    payload: LaunchOverrideUpsert,
) -> LaunchOverride:
    """Create or fully-replace the override for (kind, source_id).

    Uses UPSERT semantics: all supplied fields replace the stored values;
    updated_at is always bumped to CURRENT_TIMESTAMP.
    """
    await db.execute(
        """
        INSERT INTO launch_source_overrides
            (source_kind, source_id, project_id, provider_id, model,
             rows, cols, target, profile_id, extra_args, prompt_fanout,
             prompt_override, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(source_kind, source_id) DO UPDATE SET
            project_id    = excluded.project_id,
            provider_id   = excluded.provider_id,
            model         = excluded.model,
            rows          = excluded.rows,
            cols          = excluded.cols,
            target        = excluded.target,
            profile_id    = excluded.profile_id,
            extra_args    = excluded.extra_args,
            prompt_fanout = excluded.prompt_fanout,
            prompt_override = excluded.prompt_override,
            updated_at    = CURRENT_TIMESTAMP
        """,
        (
            kind,
            source_id,
            payload.project_id,
            payload.provider_id,
            payload.model,
            payload.rows,
            payload.cols,
            payload.target,
            payload.profile_id,
            payload.extra_args,
            payload.prompt_fanout,
            payload.prompt_override,
        ),
    )
    await db.commit()
    override = await get_override(db, kind, source_id)
    assert override is not None
    return override


async def delete_override(
    db: aiosqlite.Connection,
    kind: str,
    source_id: int,
) -> None:
    """Delete the override row for (kind, source_id) if it exists."""
    await db.execute(
        "DELETE FROM launch_source_overrides WHERE source_kind = ? AND source_id = ?",
        (kind, source_id),
    )
    await db.commit()


def _row_to_override(row: aiosqlite.Row) -> LaunchOverride:
    return LaunchOverride(
        source_kind=row["source_kind"],
        source_id=row["source_id"],
        project_id=row["project_id"],
        provider_id=row["provider_id"],
        model=row["model"],
        rows=row["rows"],
        cols=row["cols"],
        target=row["target"],
        profile_id=row["profile_id"],
        extra_args=row["extra_args"],
        prompt_fanout=row["prompt_fanout"],
        prompt_override=row["prompt_override"],
        updated_at=row["updated_at"],
    )
