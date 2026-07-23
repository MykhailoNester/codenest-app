"""Active-workspace accessor.

v1 ships exactly one workspace (``id=1``), modelled as a first-class row in the
``workspaces`` table (migration 061). Modelling it as a row — rather than
leaving it implicit in ``workspace_state`` / the synthetic ``projects`` row —
lets a future multi-workspace release add a switcher and per-workspace scoping
(via the ``projects.workspace_id`` reference) without reshaping the schema.
Until then every project implicitly belongs to workspace 1.

The workspace's on-disk root is *not* stored in the table — it is derived from
``settings.WORKSPACE_ROOT`` (resolved by the Tauri shell) so the path has a
single source of truth.
"""

from __future__ import annotations

import aiosqlite

from app.config import settings

DEFAULT_WORKSPACE_ID = 1

_SELECT_ACTIVE = (
    "SELECT id, slug, label, created_at, updated_at FROM workspaces WHERE id = ?"
)


async def ensure_singleton(db: aiosqlite.Connection) -> None:
    """Insert the singleton workspace row if it is missing (idempotent self-heal).

    Migration 061 seeds this row, so under normal operation this is a no-op. It
    exists only so ``get_active`` can recover if the row is somehow absent.
    """
    await db.execute(
        "INSERT OR IGNORE INTO workspaces (id, slug, label) VALUES (?, 'default', 'Command Center')",
        (DEFAULT_WORKSPACE_ID,),
    )
    await db.commit()


async def get_active(db: aiosqlite.Connection) -> dict:
    """Return the active workspace as a dict, with ``root_path`` derived from settings."""
    cur = await db.execute(_SELECT_ACTIVE, (DEFAULT_WORKSPACE_ID,))
    row = await cur.fetchone()
    if row is None:
        await ensure_singleton(db)
        cur = await db.execute(_SELECT_ACTIVE, (DEFAULT_WORKSPACE_ID,))
        row = await cur.fetchone()
    if row is None:
        raise RuntimeError("workspaces singleton row missing after ensure_singleton")
    data = dict(row)
    data["root_path"] = str(settings.WORKSPACE_ROOT)
    return data
