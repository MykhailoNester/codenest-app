"""Notification service.

Writes notification rows to the DB and broadcasts to in-process SSE subscribers.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import aiosqlite

_subscribers: set[asyncio.Queue[dict]] = set()


def subscribe() -> asyncio.Queue[dict]:
    q: asyncio.Queue[dict] = asyncio.Queue(maxsize=200)
    _subscribers.add(q)
    return q


def unsubscribe(q: asyncio.Queue[dict]) -> None:
    _subscribers.discard(q)


def _publish(message: dict) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            _subscribers.discard(q)


async def emit(
    db: aiosqlite.Connection,
    type: str,
    title: str,
    body: str | None = None,
    payload: dict | None = None,
    target: str | None = None,
    priority: str = "normal",
) -> int:
    payload_json = json.dumps(payload) if payload is not None else None
    cursor = await db.execute(
        """INSERT INTO notifications (type, title, body, payload_json, target, priority)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (type, title, body, payload_json, target, priority),
    )
    await db.commit()
    notification_id = cursor.lastrowid
    row = await db.execute(
        "SELECT * FROM notifications WHERE id = ?", (notification_id,)
    )
    record = await row.fetchone()
    if record is not None:
        _publish(dict(record))
    assert notification_id is not None
    return notification_id


async def list_notifications(
    db: aiosqlite.Connection,
    unread_only: bool = False,
    limit: int = 50,
) -> list[dict]:
    limit = min(limit, 200)
    if unread_only:
        rows = await db.execute(
            "SELECT * FROM notifications WHERE read_at IS NULL "
            "ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
    else:
        rows = await db.execute(
            "SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
    return [dict(r) for r in await rows.fetchall()]


async def list_recent_unread(
    db: aiosqlite.Connection,
    window_minutes: int = 60,
    limit: int = 200,
) -> list[dict]:
    """Return unread notifications from the last *window_minutes* minutes.

    Used by the SSE backlog-replay path so a client that connects after a
    burst of notifications still receives them as individual ``notification``
    events without re-fetching the full list.
    """
    limit = min(limit, 200)
    rows = await db.execute(
        "SELECT * FROM notifications "
        "WHERE read_at IS NULL "
        "  AND created_at >= datetime('now', ? || ' minutes') "
        "ORDER BY created_at ASC LIMIT ?",
        (f"-{window_minutes}", limit),
    )
    return [dict(r) for r in await rows.fetchall()]


async def mark_read(db: aiosqlite.Connection, notification_id: int) -> dict | None:
    now = datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")
    await db.execute(
        "UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL",
        (now, notification_id),
    )
    await db.commit()
    row = await db.execute(
        "SELECT * FROM notifications WHERE id = ?", (notification_id,)
    )
    r = await row.fetchone()
    return dict(r) if r else None


async def mark_all_read(db: aiosqlite.Connection) -> int:
    now = datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")
    cursor = await db.execute(
        "UPDATE notifications SET read_at = ? WHERE read_at IS NULL", (now,)
    )
    await db.commit()
    return cursor.rowcount


async def delete_notification(db: aiosqlite.Connection, notification_id: int) -> bool:
    cursor = await db.execute(
        "DELETE FROM notifications WHERE id = ?", (notification_id,)
    )
    await db.commit()
    return cursor.rowcount > 0
