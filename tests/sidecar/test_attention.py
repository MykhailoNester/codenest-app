"""Tests for the attention queue (epic #153 / #162).

The queue's whole value is that a human can trust it, which makes its failure
modes asymmetric: an item it invents is noise the user learns to scroll past,
and an item it drops is the thing that made the page worth opening. These pin
the parts that could be quietly wrong rather than the happy path:

  * **The measured-database shape.** The criterion the ticket calls CRITICAL:
    against the database as it was measured on 2026-09-10, `refresh` must
    return 0 blocking, 0 stalled and 4 queued. See
    `test_measured_database_shape` for exactly what that seed is and what each
    number is made of.
  * **Upsert-then-recur.** A condition that is still true must bump
    `seen_count` on one row; the same condition after it was resolved must mint
    a NEW row with `seen_count = 1`. Those two behaviours come from one partial
    unique index and it is easy to write an index that gives you one of them.
  * **Enrichment is not a precondition.** There are zero `TodoWrite` rows in
    the whole events table, so a producer that required a todo list would never
    fire once. The stalled producer must produce with none.
  * **`backlog` is excluded from `task_blocked`.** The only task status anyone
    would be tempted to fold in, and the one that would put the entire Work
    board on this page.
  * **The inbox aggregates.** 22 pending items are one row, not 22.
  * **Auto-resolution is per producer.** A producer that raises nothing must
    close only its own items.

Session timestamps are written in `agent_service._now()`'s `T`-separated
spelling on purpose — that is what the live table holds, and a comparison
against a space-separated bound is wrong for it unless the query normalises.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import aiosqlite
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import attention as attention_router
from app.services import attention_service as svc

pytestmark = pytest.mark.asyncio

# Naive UTC, the spelling every timestamp in this database uses.
NOW = datetime(2026, 9, 10, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)


def _hook_ts(moment: datetime) -> str:
    """`agent_service._now()`'s spelling — T-separated, naive UTC."""
    return moment.isoformat(timespec="seconds")


async def _session(
    db: aiosqlite.Connection,
    session_id: str,
    *,
    status: str,
    last_event_at: datetime,
    project_id: int | None = None,
    current_tool: str | None = None,
    pane_id: str | None = None,
) -> None:
    await db.execute(
        "INSERT INTO agent_sessions (session_id, profile, status, started_at, "
        "last_event_at, project_id, current_tool, pane_id) "
        "VALUES (?, 'test', ?, ?, ?, ?, ?, ?)",
        (
            session_id,
            status,
            _hook_ts(last_event_at - timedelta(hours=1)),
            _hook_ts(last_event_at),
            project_id,
            current_tool,
            pane_id,
        ),
    )


async def _project(db: aiosqlite.Connection, project_id: int, name: str) -> None:
    """Insert a project. Ids start at 2: the baseline schema seeds id 1 as the
    "Unassigned" catch-all, and re-inserting it is a UNIQUE failure."""
    await db.execute(
        "INSERT INTO projects (id, name) VALUES (?, ?)", (project_id, name)
    )


async def _task(
    db: aiosqlite.Connection, task_id: int, *, status: str, project_id: int
) -> None:
    await db.execute(
        "INSERT INTO tasks (id, title, status, project_id) VALUES (?, ?, ?, ?)",
        (task_id, f"task {task_id}", status, project_id),
    )


async def _inbox(db: aiosqlite.Connection, count: int, *, status: str) -> None:
    for i in range(count):
        await db.execute(
            "INSERT INTO workflow_items (title, status) VALUES (?, ?)",
            (f"item {i}", status),
        )


# ─── The measured database ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_measured_database_shape(migrated_db) -> None:
    """CRITICAL criterion: the queue's answer on the database as measured.

    The seed is the 2026-09-10 measurement, item for item: no schedules, no
    schedule runs, no budget threshold alerts, no `TodoWrite` events anywhere,
    no task in `blocked`, and eight sessions that are still live in the schema
    and between six and thirteen days stale in fact.

    The "eight live sessions" split four `active` / four `idle` is the part of
    the shape the measurement summary does not spell out, and it is what the
    expected 4 is made of — `live` in that sentence covers both statuses, and
    the two mean different things to this producer. An `active` session was
    mid-turn when it went quiet (`agent_service` only moves a session to
    `idle` when a Stop hook arrives), so its work is unfinished and it produces
    an item; an `idle` one finished its turn and is waiting for a human, which
    is not a condition worth reporting. Were all eight `active`, the honest
    answer would be 8, not 4.

    Why the four land in `queued` and the stalled count is 0: every one of them
    is days past `_ABANDONED_HOURS`. Unfinished work that old is worth seeing
    and is not worth interrupting anyone about — see the service header.

    And 0 blocking is not an accident of this seed: P1 ships no blocking
    producer at all, because every blocking source in the design is a P2 hook.
    """
    db = migrated_db
    await _project(db, 2, "codenest-app")
    for i in range(4):
        await _session(
            db,
            f"active-{i}",
            status="active",
            last_event_at=NOW - timedelta(days=6 + i),
            project_id=2,
            current_tool="Edit",
        )
    for i in range(4):
        await _session(
            db,
            f"idle-{i}",
            status="idle",
            last_event_at=NOW - timedelta(days=10 + i),
            project_id=2,
        )
    await db.commit()

    # The rest of the measured shape, asserted rather than assumed: a seed that
    # quietly grew a schedule or an inbox row would change the expected counts
    # without changing this test's intent.
    for table in (
        "schedules",
        "schedule_runs",
        "budget_threshold_alerts",
        "workflow_items",
    ):
        # Table names come from the tuple above, never from input.
        cur = await db.execute(f"SELECT COUNT(*) AS n FROM {table}")
        assert (await cur.fetchone())["n"] == 0
    cur = await db.execute(
        "SELECT COUNT(*) AS n FROM agent_events WHERE tool_name = 'TodoWrite'"
    )
    assert (await cur.fetchone())["n"] == 0
    cur = await db.execute("SELECT COUNT(*) AS n FROM tasks WHERE status = 'blocked'")
    assert (await cur.fetchone())["n"] == 0

    counts = await svc.refresh(db, now=NOW)

    assert counts["blocking"] == 0
    assert counts["stalled"] == 0
    assert counts["queued"] == 4
    assert counts["open"] == 4

    items = await svc.list_items(db, state="open")
    assert [item["kind"] for item in items] == ["session_stalled"] * 4
    # The four are the `active` sessions and none of the `idle` ones, oldest
    # first — the design's order, and the reason a queue is not a log.
    assert [item["session_id"] for item in items] == [
        "active-3",
        "active-2",
        "active-1",
        "active-0",
    ]


@pytest.mark.asyncio
async def test_stalled_needs_no_todo_list(migrated_db) -> None:
    """The todo list is enrichment, never a precondition.

    A session inside the abandonment ceiling, with no `TodoWrite` event in the
    database at all, must still produce a `stalled` item. A producer that
    required one could never fire on any database that exists.
    """
    db = migrated_db
    await _session(
        db,
        "recent",
        status="active",
        last_event_at=NOW - timedelta(minutes=45),
        current_tool="Bash",
    )
    await db.commit()

    counts = await svc.refresh(db, now=NOW)
    assert counts["stalled"] == 1
    assert counts["queued"] == 0
    items = await svc.list_items(db, state="open")
    assert items[0]["kind"] == "session_stalled"
    assert "45m" in items[0]["title"]
    assert "last tool Bash" in items[0]["detail"]


@pytest.mark.asyncio
async def test_idle_window_bounds(migrated_db) -> None:
    """Under 30 minutes is still working; over 24 hours is not urgent."""
    db = migrated_db
    await _session(
        db, "busy", status="active", last_event_at=NOW - timedelta(minutes=5)
    )
    await _session(
        db, "stalled", status="active", last_event_at=NOW - timedelta(hours=2)
    )
    await _session(
        db, "abandoned", status="active", last_event_at=NOW - timedelta(days=3)
    )
    await db.commit()

    counts = await svc.refresh(db, now=NOW)
    assert counts["stalled"] == 1
    assert counts["queued"] == 1
    keys = {item["dedup_key"] for item in await svc.list_items(db, state="open")}
    assert keys == {"session_stalled:stalled", "session_stalled:abandoned"}


# ─── Upsert-then-recur ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recurring_condition_bumps_seen_count(migrated_db) -> None:
    """The same condition on three passes is one row seen three times."""
    db = migrated_db
    await _session(db, "s1", status="active", last_event_at=NOW - timedelta(hours=2))
    await db.commit()

    for _ in range(3):
        await svc.refresh(db, now=NOW)

    items = await svc.list_items(db, state="open")
    assert len(items) == 1
    assert items[0]["seen_count"] == 3
    # The age the page sorts on is the condition's, not this pass's.
    assert items[0]["first_seen_at"] <= items[0]["last_seen_at"]


@pytest.mark.asyncio
async def test_resolved_then_recurring_mints_a_new_row(migrated_db) -> None:
    """A condition that came back is a new occurrence, not the old one reopened.

    This is the half of the partial unique index that an index on `state =
    'open'` alone would get wrong in the other direction — and flipping the old
    row back to `open` would erase the fact that it had ended and restate its
    age as hours rather than minutes.
    """
    db = migrated_db
    await _session(db, "s1", status="active", last_event_at=NOW - timedelta(hours=2))
    await db.commit()
    await svc.refresh(db, now=NOW)

    # The session wakes up: the condition clears and the item auto-resolves.
    await db.execute(
        "UPDATE agent_sessions SET last_event_at = ? WHERE session_id = 's1'",
        (_hook_ts(NOW),),
    )
    await db.commit()
    await svc.refresh(db, now=NOW)
    assert (await svc.counts(db, now=NOW))["open"] == 0

    # ...and goes quiet again.
    later = NOW + timedelta(hours=4)
    await svc.refresh(db, now=later)

    cur = await db.execute(
        "SELECT state, seen_count FROM attention_items "
        "WHERE dedup_key = 'session_stalled:s1' ORDER BY id"
    )
    rows = [dict(r) for r in await cur.fetchall()]
    assert len(rows) == 2, "a resolved-then-recurring condition mints a new row"
    assert rows[0]["state"] == "resolved"
    assert rows[1]["state"] == "open"
    assert rows[1]["seen_count"] == 1


@pytest.mark.asyncio
async def test_muted_item_is_not_duplicated_or_counted(migrated_db) -> None:
    """Muting takes an item off the page without letting it come back twice.

    The partial index covers `state <> 'resolved'` rather than `state =
    'open'` precisely so that a refresh cannot mint a second, open row for the
    condition the user just silenced.
    """
    db = migrated_db
    await _session(db, "s1", status="active", last_event_at=NOW - timedelta(hours=2))
    await db.commit()
    await svc.refresh(db, now=NOW)

    await db.execute(
        "UPDATE attention_items SET state = 'muted', muted_until = ? "
        "WHERE dedup_key = 'session_stalled:s1'",
        (svc._sql_ts(NOW + timedelta(hours=4)),),
    )
    await db.commit()

    counts = await svc.refresh(db, now=NOW + timedelta(hours=1))
    assert counts["open"] == 0
    assert counts["muted"] == 1
    cur = await db.execute("SELECT COUNT(*) AS n FROM attention_items")
    assert (await cur.fetchone())["n"] == 1

    # Past `muted_until` it comes back on its own, or mute would be permanent.
    counts = await svc.refresh(db, now=NOW + timedelta(hours=5))
    assert counts["open"] == 1
    assert counts["muted"] == 0


# ─── The other producers ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_task_blocked_is_per_task_and_excludes_backlog(migrated_db) -> None:
    db = migrated_db
    await _project(db, 2, "p")
    await _task(db, 1, status="blocked", project_id=2)
    await _task(db, 2, status="blocked", project_id=2)
    await _task(db, 3, status="backlog", project_id=2)
    await _task(db, 4, status="todo", project_id=2)
    await db.commit()

    counts = await svc.refresh(db, now=NOW)
    assert counts["queued"] == 2
    keys = {
        item["dedup_key"]
        for item in await svc.list_items(db, state="open")
        if item["kind"] == "task_blocked"
    }
    assert keys == {"task_blocked:1", "task_blocked:2"}


@pytest.mark.asyncio
async def test_inbox_backlog_is_one_row_not_twenty_two(migrated_db) -> None:
    db = migrated_db
    await _inbox(db, 20, status="inbox")
    await _inbox(db, 2, status="review")
    await _inbox(db, 5, status="ready")  # triaged — not waiting on a decision
    await db.commit()

    await svc.refresh(db, now=NOW)
    items = [
        item
        for item in await svc.list_items(db, state="open")
        if item["kind"] == "inbox_backlog"
    ]
    assert len(items) == 1
    assert "22" in items[0]["title"]


@pytest.mark.asyncio
async def test_schedule_failed_reads_only_the_latest_run(migrated_db) -> None:
    """A schedule that failed then succeeded is not on the queue.

    And a schedule failing nightly is one row, not fourteen — which is also
    what lets the item resolve itself when the next run works.
    """
    db = migrated_db
    await db.execute(
        "INSERT INTO schedules (id, name, kind, cron_expr) "
        "VALUES (1, 'nightly', 'cron', '0 3 * * *')"
    )
    await db.execute(
        "INSERT INTO schedules (id, name, kind, cron_expr) "
        "VALUES (2, 'hourly', 'cron', '0 * * * *')"
    )
    await db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, status, fired_at, "
        "detail) VALUES (1, 'cron', 'failed', '2026-09-09 03:00:00', 'exit 2')"
    )
    await db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, status, fired_at) "
        "VALUES (1, 'cron', 'failed', '2026-09-10 03:00:00')"
    )
    await db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, status, fired_at) "
        "VALUES (2, 'cron', 'failed', '2026-09-10 10:00:00')"
    )
    await db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, status, fired_at) "
        "VALUES (2, 'cron', 'succeeded', '2026-09-10 11:00:00')"
    )
    await db.commit()

    counts = await svc.refresh(db, now=NOW)
    assert counts["stalled"] == 1
    items = [
        item
        for item in await svc.list_items(db, state="open")
        if item["kind"] == "schedule_failed"
    ]
    assert [item["dedup_key"] for item in items] == ["schedule_failed:1"]
    assert items[0]["seen_count"] == 1, "two failed runs of one schedule are one row"


@pytest.mark.asyncio
async def test_budget_threshold_uses_the_current_period_and_highest_crossing(
    migrated_db,
) -> None:
    db = migrated_db
    await db.execute(
        "INSERT INTO budgets (id, name, scope_type, period, limit_usd) "
        "VALUES (1, 'daily cap', 'workspace', 'daily', 40.0)"
    )
    today_start, _end = __import__(
        "app.services.budget_service", fromlist=["period_bounds"]
    ).period_bounds("daily", NOW)
    for threshold in (50, 80, 100):
        await db.execute(
            "INSERT INTO budget_threshold_alerts (budget_id, period_start, threshold) "
            "VALUES (1, ?, ?)",
            (today_start, threshold),
        )
    # Last month's 100% crossing is history, not attention.
    await db.execute(
        "INSERT INTO budget_threshold_alerts (budget_id, period_start, threshold) "
        "VALUES (1, '2026-08-01T00:00:00', 100)"
    )
    await db.commit()

    counts = await svc.refresh(db, now=NOW)
    assert counts["stalled"] == 1
    items = [
        item
        for item in await svc.list_items(db, state="open")
        if item["kind"] == "budget_threshold"
    ]
    assert len(items) == 1
    assert "100%" in items[0]["title"]


# ─── Sweeping ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sweep_is_scoped_to_the_producer(migrated_db) -> None:
    """Unblocking a task must not close a stalled session's item.

    The sweep resolves "what my kind produced last time and does not produce
    now". Scoped per kind, so one producer returning nothing can never empty
    somebody else's items.
    """
    db = migrated_db
    await _project(db, 2, "p")
    await _task(db, 1, status="blocked", project_id=2)
    await _session(db, "s1", status="active", last_event_at=NOW - timedelta(hours=2))
    await db.commit()
    counts = await svc.refresh(db, now=NOW)
    assert counts["open"] == 2

    await db.execute("UPDATE tasks SET status = 'todo' WHERE id = 1")
    await db.commit()
    counts = await svc.refresh(db, now=NOW)

    assert counts["open"] == 1
    assert counts["auto_resolved"] == 1
    items = await svc.list_items(db, state="open")
    assert items[0]["kind"] == "session_stalled"
    resolved = await svc.list_items(db, state="resolved")
    assert resolved[0]["kind"] == "task_blocked"
    assert resolved[0]["resolution"] == "condition_cleared"


@pytest.mark.asyncio
async def test_refresh_is_idempotent_on_an_empty_database(migrated_db) -> None:
    """A freshly migrated database has nothing to say, twice."""
    db = migrated_db
    first = await svc.refresh(db, now=NOW)
    second = await svc.refresh(db, now=NOW)
    assert first["open"] == 0
    assert second == first
    cur = await db.execute("SELECT COUNT(*) AS n FROM attention_items")
    assert (await cur.fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_table_has_no_lane_column(migrated_db) -> None:
    """An attention item is derived, not lane-sourced. See migration 013.

    Pinned as a test because the other four tables this epic adds all carry a
    lane, so "add the lane column for consistency" is the single most likely
    well-intentioned change to this schema.
    """
    cur = await migrated_db.execute("PRAGMA table_info(attention_items)")
    columns = {row["name"] for row in await cur.fetchall()}
    assert "lane" not in columns
    # The five P2-forward columns exist now so P2's hook writers need no
    # second migration against a populated table.
    assert {
        "hook_event",
        "requires_response",
        "response_json",
        "responded_at",
        "expires_at",
    } <= columns
    assert {"state", "dedup_key", "seen_count", "resolution", "muted_until"} <= columns


# ─── HTTP API ────────────────────────────────────────────────────────────────


@pytest.fixture
def client(migrated_db: aiosqlite.Connection):
    """A TestClient whose handlers see the migrated test connection.

    The router imports `get_db` by value, so the seam is `database._db` — the
    process-wide connection `get_db` returns when one already exists. The same
    approach `test_event_retention` and `test_session_kind` use.
    """
    original = db_module._db
    db_module._db = migrated_db
    try:
        application = FastAPI()
        application.include_router(attention_router.router)
        yield TestClient(application, raise_server_exceptions=True)
    finally:
        db_module._db = original


async def test_get_recomputes_before_it_reads(
    client: TestClient, migrated_db: aiosqlite.Connection
) -> None:
    """The page's freshness promise is a recompute-on-read, not a background
    tick, so a GET must see a condition that appeared since the last call."""
    body = client.get("/api/v1/attention").json()
    assert body["items"] == []
    assert body["counts"]["open"] == 0

    await _session(
        migrated_db,
        "http-1",
        status="active",
        last_event_at=svc._utcnow() - timedelta(hours=2),
    )
    await migrated_db.commit()

    body = client.get("/api/v1/attention").json()
    assert body["counts"]["stalled"] == 1
    assert body["items"][0]["dedup_key"] == "session_stalled:http-1"


async def test_get_rejects_an_unknown_state(client: TestClient) -> None:
    """The state is a filter on a three-value vocabulary, not free text."""
    assert client.get("/api/v1/attention?state=everything").status_code == 422
