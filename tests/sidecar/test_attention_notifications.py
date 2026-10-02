"""The Notifications fold (#270).

The Notifications page is gone and its queue is derived into `attention_items`.
A fold that quietly drops something is worse than two pages, so these pin what
survived it and what deliberately did not:

  * **Only the unread half is folded.** A notification you have already read is
    by definition not waiting on you. The bell in the chrome keeps the full
    history; this queue keeps only what is outstanding.
  * **`priority` decides what gets a row of its own.** The emitters already
    grade their own output — `session_failed` and `cost_threshold` pass
    `high`, the announcements of ordinary progress pass `normal` — so the fold
    uses that grading rather than a list of type strings it would have to keep
    in step with every future emitter.
  * **The rest aggregates.** One `notification_backlog` row, the way
    `_produce_inbox_backlog` does it: forty rows of "a session finished" is
    forty rows of the same sentence.
  * **Reading closes the row.** No producer closes anything explicitly; the
    ordinary sweep does it, so marking a notification read must be enough and
    nothing in the fold may delete a notification.
  * **The ceiling does not hide anything.** What spills past
    `_NOTIFICATION_MAX_INDIVIDUAL` is still counted by the backlog row.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite
import pytest

from app.services import attention_service as svc

pytestmark = pytest.mark.asyncio

NOW = datetime(2026, 9, 10, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)


async def _notification(
    db: aiosqlite.Connection,
    notification_id: int,
    *,
    type: str = "session_failed",
    title: str = "Session ended with errors",
    body: str | None = None,
    payload: str | None = None,
    priority: str = "high",
    read: bool = False,
    created_at: datetime | None = None,
) -> None:
    await db.execute(
        "INSERT INTO notifications "
        "(id, type, title, body, payload_json, priority, read_at, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            notification_id,
            type,
            title,
            body,
            payload,
            priority,
            svc._sql_ts(NOW) if read else None,
            svc._sql_ts(created_at or NOW - timedelta(minutes=5)),
        ),
    )


async def _items(db: aiosqlite.Connection, kind: str) -> list[dict[str, Any]]:
    rows = await svc.list_items(db)
    return [row for row in rows if row["kind"] == kind]


async def test_an_unread_high_priority_notification_becomes_a_row(
    migrated_db,
) -> None:
    db = migrated_db
    await _notification(
        db,
        1,
        body="Session abc1 — reason: error",
        payload='{"session_id": "abc1", "reason": "error"}',
    )
    await db.commit()

    await svc.refresh(db, now=NOW)
    items = await _items(db, "notification_unread")
    assert len(items) == 1
    assert items[0]["title"] == "Session ended with errors"
    assert items[0]["detail"] == "Session abc1 — reason: error"
    # Severity is `queued` even for a `high` notification: an announcement that
    # something already happened blocks nothing and stops nothing moving, which
    # is what the other two severities mean on this page.
    assert items[0]["severity"] == "queued"
    # The subject pointer is lifted out of the payload so the page's generic
    # jump rules reach the session without a notification-shaped special case.
    assert items[0]["session_id"] == "abc1"
    assert items[0]["dedup_key"] == "notification_unread:1"


async def test_a_read_notification_is_not_folded(migrated_db) -> None:
    db = migrated_db
    await _notification(db, 1, read=True)
    await db.commit()

    await svc.refresh(db, now=NOW)
    assert await _items(db, "notification_unread") == []
    assert await _items(db, "notification_backlog") == []


async def test_reading_a_notification_resolves_its_row(migrated_db) -> None:
    """The fold's replacement for the deleted page's Dismiss.

    Dismiss deleted the notification. Marking it read takes it off this queue
    and leaves the record where the bell can still show it — and it is the
    *producer* that closes the row, via the ordinary sweep, so nothing in the
    fold needs a delete path at all.
    """
    db = migrated_db
    await _notification(db, 1)
    await db.commit()
    await svc.refresh(db, now=NOW)
    assert len(await _items(db, "notification_unread")) == 1

    await db.execute(
        "UPDATE notifications SET read_at = ? WHERE id = 1", (svc._sql_ts(NOW),)
    )
    await db.commit()
    summary = await svc.refresh(db, now=NOW + timedelta(minutes=1))

    assert await _items(db, "notification_unread") == []
    assert summary["auto_resolved"] == 1
    cur = await db.execute(
        "SELECT state, resolution FROM attention_items WHERE kind = 'notification_unread'"
    )
    row = await cur.fetchone()
    assert row["state"] == "resolved"
    assert row["resolution"] == svc.RESOLUTION_CONDITION_CLEARED
    # The notification itself is untouched — the fold never deletes one.
    cur = await db.execute("SELECT COUNT(*) AS n FROM notifications")
    assert (await cur.fetchone())["n"] == 1


async def test_normal_priority_notifications_aggregate(migrated_db) -> None:
    db = migrated_db
    for i in range(1, 5):
        await _notification(
            db,
            i,
            type="session_completed",
            title=f"Session {i} completed",
            priority="normal",
            created_at=NOW - timedelta(hours=3),
        )
    await db.commit()

    await svc.refresh(db, now=NOW)
    assert await _items(db, "notification_unread") == []
    backlog = await _items(db, "notification_backlog")
    assert len(backlog) == 1
    assert backlog[0]["title"] == "4 unread notification(s)"
    assert backlog[0]["detail"] == "oldest waiting 3h"
    assert backlog[0]["dedup_key"] == "notification_backlog"


async def test_the_ceiling_spills_into_the_backlog_rather_than_hiding(
    migrated_db,
) -> None:
    """A machine failing sessions all week must not push the page over, and it
    must not lose the overflow either."""
    db = migrated_db
    total = svc._NOTIFICATION_MAX_INDIVIDUAL + 3
    for i in range(1, total + 1):
        await _notification(db, i, created_at=NOW - timedelta(minutes=i))
    await db.commit()

    await svc.refresh(db, now=NOW)
    individual = await _items(db, "notification_unread")
    assert len(individual) == svc._NOTIFICATION_MAX_INDIVIDUAL
    backlog = await _items(db, "notification_backlog")
    assert len(backlog) == 1
    assert backlog[0]["title"] == "3 unread notification(s)"
    # Newest first past the ceiling: the most recent failure is the one still
    # worth looking at.
    assert "notification_unread:1" in {row["dedup_key"] for row in individual}
    assert f"notification_unread:{total}" not in {
        row["dedup_key"] for row in individual
    }


async def test_a_malformed_payload_still_produces_an_item(migrated_db) -> None:
    """Enrichment is never a precondition — the module header's rule."""
    db = migrated_db
    await _notification(db, 1, payload="{not json")
    await db.commit()

    await svc.refresh(db, now=NOW)
    items = await _items(db, "notification_unread")
    assert len(items) == 1
    assert items[0]["session_id"] is None
    assert items[0]["task_id"] is None


async def test_the_hook_notification_kind_is_a_different_thing(migrated_db) -> None:
    """`Notification` the hook event and `notifications` the table share a word
    and nothing else. The hook kind is ingested and must not be swept by the
    fold's producer, which emits no keys for it."""
    db = migrated_db
    await db.execute(
        "INSERT INTO agent_sessions (session_id, profile, status, started_at, "
        "last_event_at) VALUES ('s1', 'test', 'idle', ?, ?)",
        (svc._sql_ts(NOW), svc._sql_ts(NOW)),
    )
    await svc.record_hook_item(
        db,
        "Notification",
        {"session_id": "s1", "message": "waiting for your input"},
        now=NOW,
    )
    await db.commit()

    await svc.refresh(db, now=NOW)
    assert len(await _items(db, "notification")) == 1
    assert await _items(db, "notification_unread") == []
    assert "notification" not in svc.DERIVED_KINDS
    assert "notification_unread" in svc.DERIVED_KINDS
