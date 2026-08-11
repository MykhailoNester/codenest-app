"""Tests for the per-task agent-runs read: the ``source_kind``/``source_id``
filter added to ``agent_runs_service.list_runs``,
``agent_runs_service.list_for_source``, ``task_service.list_task_runs``, and
``GET /api/v1/tasks/{id}/runs``.

The `migrated_db` fixture ships with the `Unassigned` project (id 1) from the
baseline seed and zero tasks/runs; every test seeds its own task(s) and
run(s) via `_make_task`/`_insert_run`.
"""

from __future__ import annotations

import datetime
import uuid

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import tasks as tasks_router
from app.services import agent_runs_service, task_service


def _gen_uuid() -> str:
    return str(uuid.uuid4())


async def _make_task(db: aiosqlite.Connection, title: str = "t") -> int:
    return await task_service.create_task(db, {"title": title, "project_id": 1})


async def _provider_id(db: aiosqlite.Connection) -> int:
    """Return the id of a test provider, inserting one if the DB is clean-slate."""
    row = await db.execute(
        "SELECT id FROM providers WHERE name = 'test-anthropic' LIMIT 1"
    )
    r = await row.fetchone()
    if r is not None:
        return r["id"]
    cur = await db.execute(
        "INSERT INTO providers (name, display_name, command_template, is_enabled) "
        "VALUES (?, ?, ?, 1)",
        ("test-anthropic", "Test Anthropic", "claude {extra_args}"),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


async def _insert_run(
    db: aiosqlite.Connection,
    *,
    source_kind: str | None,
    source_id: int | None,
    session_id: str | None = None,
    started_at: str | None = None,
) -> int:
    """Insert an ``agent_runs`` row directly, for full control over
    ``started_at`` (`persist_on_launch` always stamps "now")."""
    run_id = await agent_runs_service.persist_on_launch(
        db,
        session_id=session_id,
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=source_kind,
        source_id=source_id,
    )
    if started_at is not None:
        await db.execute(
            "UPDATE agent_runs SET started_at = ? WHERE id = ?",
            (started_at, run_id),
        )
        await db.commit()
    return run_id


async def _insert_agent_session(
    db: aiosqlite.Connection,
    *,
    session_id: str,
    profile: str = "work",
    status: str = "active",
    cost_usd: float = 0.0,
    total_tool_calls: int = 0,
    initial_prompt: str | None = None,
) -> None:
    """Insert a minimal `agent_sessions` row for test fixtures (mirrors
    `test_agent_runs.py`'s helper of the same name, plus the enrichment
    columns this card's join reads)."""
    now = datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")
    await db.execute(
        """
        INSERT INTO agent_sessions
            (session_id, profile, status, started_at, last_event_at,
             cost_usd, total_tool_calls, initial_prompt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            profile,
            status,
            now,
            now,
            cost_usd,
            total_tool_calls,
            initial_prompt,
        ),
    )
    await db.commit()


@pytest_asyncio.fixture
async def tasks_app(
    migrated_db: aiosqlite.Connection,
) -> tuple[TestClient, aiosqlite.Connection]:
    original_db = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(tasks_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db
    db_module._db = original_db


@pytest.mark.asyncio
async def test_only_this_tasks_runs_are_returned(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    """The acceptance-critical exclusion: another task's run and a run with
    no source at all must both be absent."""
    client, db = tasks_app
    a = await _make_task(db, "a")
    b = await _make_task(db, "b")
    run_a = await _insert_run(db, source_kind="task", source_id=a)
    await _insert_run(db, source_kind="task", source_id=b)
    await _insert_run(db, source_kind=None, source_id=None)

    resp = client.get(f"/api/v1/tasks/{a}/runs")
    assert resp.status_code == 200
    rows = resp.json()
    assert [row["id"] for row in rows] == [run_a]


@pytest.mark.asyncio
async def test_observe_only_sessions_are_excluded(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    """Observe-only sessions (unlinked `agent_sessions` rows) select literal
    NULL for source_kind/source_id, so a source filter must never surface
    them — pins Design decision 2."""
    client, db = tasks_app
    tid = await _make_task(db)
    await _insert_run(db, source_kind="task", source_id=tid)

    ext_session_id = _gen_uuid()
    await _insert_agent_session(db, session_id=ext_session_id, status="active")
    # Sanity: this session shows up in the unfiltered union (the fixture is
    # the one `test_agent_runs.py` pins at :525-536).
    unfiltered = await agent_runs_service.list_runs(db)
    assert any(r["session_id"] == ext_session_id for r in unfiltered)

    resp = client.get(f"/api/v1/tasks/{tid}/runs")
    assert resp.status_code == 200
    rows = resp.json()
    assert all(row["session_id"] != ext_session_id for row in rows)
    assert all(row["row_kind"] == "run" for row in rows)


@pytest.mark.asyncio
async def test_newest_first(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    tid = await _make_task(db)
    r1 = await _insert_run(
        db, source_kind="task", source_id=tid, started_at="2026-01-01 00:00:00"
    )
    r2 = await _insert_run(
        db, source_kind="task", source_id=tid, started_at="2026-01-02 00:00:00"
    )
    r3 = await _insert_run(
        db, source_kind="task", source_id=tid, started_at="2026-01-03 00:00:00"
    )

    resp = client.get(f"/api/v1/tasks/{tid}/runs")
    assert [row["id"] for row in resp.json()] == [r3, r2, r1]


@pytest.mark.asyncio
async def test_row_carries_join_columns(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    """Pins 'no second query needed': every column the card reads is already
    on the existing `list_runs` join."""
    client, db = tasks_app
    tid = await _make_task(db)
    pid = await _provider_id(db)
    session_id = _gen_uuid()
    run_id = await agent_runs_service.persist_on_launch(
        db,
        session_id=session_id,
        provider_id=pid,
        project_id=None,
        pane_id=_gen_uuid(),
        model="claude-opus",
        prompt_preview="Investigate the flaky test",
        source_kind="task",
        source_id=tid,
        profile="work",
    )
    assert run_id > 0
    await _insert_agent_session(
        db,
        session_id=session_id,
        cost_usd=0.42,
        total_tool_calls=18,
        initial_prompt="The session's own initial prompt",
    )

    resp = client.get(f"/api/v1/tasks/{tid}/runs")
    row = resp.json()[0]
    assert row["session_cost_usd"] == 0.42
    assert row["session_total_tool_calls"] == 18
    assert row["session_initial_prompt"] == "The session's own initial prompt"
    assert row["provider_name"] == "test-anthropic"
    assert row["provider_color"] is None or isinstance(row["provider_color"], str)
    assert row["model"] == "claude-opus"
    assert row["prompt_preview"] == "Investigate the flaky test"
    assert row["started_at"]
    assert "ended_at" in row
    assert row["profile"] == "work"


@pytest.mark.asyncio
async def test_zero_tool_calls_is_not_null(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    tid = await _make_task(db)
    session_id = _gen_uuid()
    await agent_runs_service.persist_on_launch(
        db,
        session_id=session_id,
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind="task",
        source_id=tid,
    )
    await _insert_agent_session(db, session_id=session_id, total_tool_calls=0)

    resp = client.get(f"/api/v1/tasks/{tid}/runs")
    row = resp.json()[0]
    assert row["session_total_tool_calls"] == 0
    assert row["session_total_tool_calls"] is not None


@pytest.mark.asyncio
async def test_limit_honoured_and_clamped(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    tid = await _make_task(db)
    for i in range(210):
        await _insert_run(
            db,
            source_kind="task",
            source_id=tid,
            started_at=f"2026-01-02 00:{i % 60:02d}:{i // 60:02d}",
        )

    resp = client.get(f"/api/v1/tasks/{tid}/runs", params={"limit": 2})
    assert len(resp.json()) == 2

    resp = client.get(f"/api/v1/tasks/{tid}/runs", params={"limit": 0})
    assert len(resp.json()) == 1

    resp = client.get(f"/api/v1/tasks/{tid}/runs", params={"limit": 9999})
    assert len(resp.json()) == agent_runs_service.MAX_SOURCE_LIMIT


@pytest.mark.asyncio
async def test_unknown_task_returns_404(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, _ = tasks_app
    resp = client.get("/api/v1/tasks/9999/runs")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "task not found"}


@pytest.mark.asyncio
async def test_task_with_no_runs_returns_empty_array(
    tasks_app: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = tasks_app
    tid = await _make_task(db)
    resp = client.get(f"/api/v1/tasks/{tid}/runs")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_unfiltered_list_runs_is_unchanged(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Regression guard for the union branch: an unfiltered `list_runs` call
    must still include an observe-only session."""
    ext_session_id = _gen_uuid()
    await _insert_agent_session(migrated_db, session_id=ext_session_id, status="active")

    rows = await agent_runs_service.list_runs(migrated_db)
    obs_rows = [r for r in rows if r["row_kind"] == "observe"]
    assert any(r["session_id"] == ext_session_id for r in obs_rows)


@pytest.mark.asyncio
async def test_list_task_runs_404s_via_service(
    migrated_db: aiosqlite.Connection,
) -> None:
    with pytest.raises(HTTPException) as exc:
        await task_service.list_task_runs(migrated_db, 999_999)
    assert exc.value.status_code == 404
