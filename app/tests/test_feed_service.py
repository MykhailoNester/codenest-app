"""Tests for feed_service.

Covers UNION ordering, filter composition, cursor pagination across
mixed-source rows sharing the same created_at, and CSV serialization.
"""

from __future__ import annotations

import io
import pathlib

import aiosqlite
import pytest
import pytest_asyncio

from app.services import feed_service


MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await db.executescript(mig.read_text())


@pytest_asyncio.fixture
async def db(tmp_path):
    conn = await aiosqlite.connect(str(tmp_path / "test.db"))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    yield conn
    await conn.close()


async def _activity(
    db, *, when, action="created", actor="system", project_id=None, summary="x"
):
    await db.execute(
        "INSERT INTO activity_log "
        "(entity_type, entity_id, action, new_value, actor, project_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("task", 1, action, summary, actor, project_id, when),
    )
    await db.commit()


async def _session(
    db,
    *,
    session_id,
    when,
    profile="default",
    project_id=None,
    ended=False,
):
    await db.execute(
        "INSERT INTO agent_sessions "
        "(session_id, profile, status, started_at, last_event_at, project_id, ended_at) "
        "VALUES (?, ?, 'idle', ?, ?, ?, ?)",
        (session_id, profile, when, when, project_id, when if ended else None),
    )
    await db.commit()


# ─── UNION basics ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_union_returns_both_sources_in_time_order(db):
    await _activity(db, when="2026-05-10 10:00:00")
    await _session(db, session_id="s-1", when="2026-05-10 12:00:00")
    await _activity(db, when="2026-05-10 09:00:00")
    result = await feed_service.list_feed(db)
    items = result["items"]
    assert [r["source"] for r in items] == ["agent_session", "activity", "activity"]
    # Newest first
    assert items[0]["created_at"] == "2026-05-10 12:00:00"
    assert items[-1]["created_at"] == "2026-05-10 09:00:00"
    assert result["next_cursor"] is None


@pytest.mark.asyncio
async def test_namespaced_ids(db):
    await _activity(db, when="2026-05-10 10:00:00")
    await _session(db, session_id="abc-123", when="2026-05-10 11:00:00")
    items = (await feed_service.list_feed(db))["items"]
    assert items[0]["id"] == "s:abc-123:started"
    assert items[1]["id"].startswith("a:")


@pytest.mark.asyncio
async def test_ended_session_emits_both_started_and_ended(db):
    # H2 fix: an ended session must surface as two audit rows so the
    # 'started' signal isn't lost once 'ended_at' is set.
    await _session(db, session_id="s-1", when="2026-05-10 10:00:00", ended=True)
    items = (await feed_service.list_feed(db))["items"]
    actions = sorted(r["action"] for r in items)
    assert actions == ["ended", "started"]
    ids = sorted(r["id"] for r in items)
    assert ids == ["s:s-1:ended", "s:s-1:started"]


# ─── Filters ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_filter_by_source(db):
    await _activity(db, when="2026-05-10 10:00:00")
    await _session(db, session_id="s-1", when="2026-05-10 11:00:00")
    items = (await feed_service.list_feed(db, source="agent_session"))["items"]
    assert len(items) == 1
    assert items[0]["source"] == "agent_session"


@pytest.mark.asyncio
async def test_filter_by_project_id(db):
    await db.execute("INSERT INTO projects (id, name, path) VALUES (1001, 'A', '/a')")
    await db.execute("INSERT INTO projects (id, name, path) VALUES (1002, 'B', '/b')")
    await db.commit()
    await _activity(db, when="2026-05-10 10:00:00", project_id=1001)
    await _activity(db, when="2026-05-10 10:30:00", project_id=1002)
    await _session(db, session_id="s-1", when="2026-05-10 11:00:00", project_id=1001)
    items = (await feed_service.list_feed(db, project_id=1001))["items"]
    assert len(items) == 2
    assert all(r["project_id"] == 1001 for r in items)


@pytest.mark.asyncio
async def test_filter_by_actor(db):
    await _activity(db, when="2026-05-10 10:00:00", actor="alice")
    await _activity(db, when="2026-05-10 11:00:00", actor="bob")
    items = (await feed_service.list_feed(db, actor="alice"))["items"]
    assert len(items) == 1
    assert items[0]["actor"] == "alice"


@pytest.mark.asyncio
async def test_filter_by_time_window(db):
    await _activity(db, when="2026-05-01 10:00:00")
    await _activity(db, when="2026-05-10 10:00:00")
    await _activity(db, when="2026-05-20 10:00:00")
    items = (
        await feed_service.list_feed(
            db, from_iso="2026-05-05 00:00:00", to_iso="2026-05-15 00:00:00"
        )
    )["items"]
    assert len(items) == 1
    assert items[0]["created_at"] == "2026-05-10 10:00:00"


@pytest.mark.asyncio
async def test_filter_by_q_escapes_like_metachars(db):
    await _activity(db, when="2026-05-10 10:00:00", summary="50% reached")
    await _activity(db, when="2026-05-10 11:00:00", summary="something else")
    items = (await feed_service.list_feed(db, q="50%"))["items"]
    # Without proper escape, the % would wildcard and match both.
    assert len(items) == 1
    assert items[0]["summary"] == "50% reached"


@pytest.mark.asyncio
async def test_invalid_source_raises_400(db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await feed_service.list_feed(db, source="bogus")


# ─── Cursor pagination ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cursor_pagination_is_stable_across_same_timestamp(db):
    # Two rows share the same created_at — cursor must use (created_at, id)
    # to avoid skipping or duplicating either.
    await _activity(db, when="2026-05-10 10:00:00", summary="first")
    await _activity(db, when="2026-05-10 10:00:00", summary="second")
    await _activity(db, when="2026-05-10 09:00:00", summary="third")

    page1 = await feed_service.list_feed(db, limit=2)
    assert len(page1["items"]) == 2
    cursor = page1["next_cursor"]
    assert cursor is not None

    page2 = await feed_service.list_feed(
        db,
        limit=2,
        before_created_at=cursor["before_created_at"],
        before_id=cursor["before_id"],
    )
    assert len(page2["items"]) == 1
    # No overlap between page 1 ids and page 2 ids.
    ids1 = {r["id"] for r in page1["items"]}
    ids2 = {r["id"] for r in page2["items"]}
    assert ids1.isdisjoint(ids2)
    assert page2["next_cursor"] is None


# ─── CSV ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stream_csv_includes_header_and_rows(db):
    await _activity(db, when="2026-05-10 10:00:00", summary="value with, comma")
    await _session(db, session_id="s-1", when="2026-05-10 11:00:00")

    chunks: list[str] = []
    async for chunk in feed_service.stream_csv(db):
        chunks.append(chunk)
    text = "".join(chunks)

    # Parse the output back to verify quoting/escaping was correct.
    import csv

    rows = list(csv.reader(io.StringIO(text)))
    assert rows[0] == list(feed_service.COLUMNS)
    assert len(rows) == 3  # header + 2 data rows
    # Comma-containing summary must round-trip correctly via csv quoting.
    body_rows = rows[1:]
    summaries = [r[feed_service.COLUMNS.index("summary")] for r in body_rows]
    assert "value with, comma" in summaries


@pytest.mark.asyncio
async def test_stream_csv_respects_filters(db):
    await _activity(db, when="2026-05-10 10:00:00", actor="alice")
    await _activity(db, when="2026-05-10 11:00:00", actor="bob")
    chunks = [c async for c in feed_service.stream_csv(db, actor="alice")]
    text = "".join(chunks)
    import csv

    rows = list(csv.reader(io.StringIO(text)))
    assert len(rows) == 2  # header + 1 row
    assert rows[1][feed_service.COLUMNS.index("actor")] == "alice"
