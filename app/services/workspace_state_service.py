"""Async helpers for the workspace_state singleton key/value table.

The workspace_state table (migration 058) is a flat k/v store for persistent
Command Center configuration.  Values are always TEXT; callers are responsible
for serialising/deserialising typed data (JSON, ISO-8601 timestamps, etc.).

Usage::

    from app.services import workspace_state_service
    await workspace_state_service.set(db, "last_bootstrap_at", now_iso)
    value = await workspace_state_service.get(db, "last_bootstrap_at")
"""

from __future__ import annotations

from datetime import datetime, timezone

import aiosqlite


async def get(db: aiosqlite.Connection, key: str) -> str | None:
    """Return the stored value for *key*, or ``None`` if the key is absent."""
    cur = await db.execute("SELECT value FROM workspace_state WHERE key = ?", (key,))
    row = await cur.fetchone()
    return row[0] if row else None


async def set(db: aiosqlite.Connection, key: str, value: str) -> None:
    """Upsert *key* → *value*, updating ``updated_at`` to the current UTC time."""
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        "INSERT INTO workspace_state (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, value, now),
    )
    await db.commit()
