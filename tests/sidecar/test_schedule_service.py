"""Unit tests for app/services/schedule_service.py (Phase 1 execution bridge).

Covers:
- reap_orphaned_runs: running and queued rows are set to failed on startup.
- tick overlap guard: skips when a running/queued run already exists.
- tick staleness guard: records `missed` when the due slot is >24h old.
- tick happy path: inserts a `queued` run and advances next_fire_at.
- Run lifecycle transitions: start_run, finish_run, timeout_run, cancel_run.
- claim_pending_dispatches: returns queued rows with schedule config.
- fire_manual: respects overlap guard; returns schedule + run dict.
- prune_transcript_blobs: deletes transcripts only; preserves artifacts.
"""

from __future__ import annotations

import pathlib
from datetime import datetime, timedelta
from typing import Any

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import HTTPException

import app.services.schedule_service as svc


@pytest_asyncio.fixture(autouse=True)
async def _seed_default_provider(migrated_db: aiosqlite.Connection) -> None:
    """Seed provider id=1 for the schedule tests.

    The shared ``migrated_db`` fixture is a pure, freshly-migrated DB (the
    providers table ships empty, per the E0.1 clean-slate invariant). The
    helpers in this module default to ``provider_id=1``, so every test here
    needs that row to exist to satisfy the FK / required-provider check.
    """
    await migrated_db.execute(
        "INSERT OR IGNORE INTO providers (id, name, display_name, command_template) "
        "VALUES (1, 'test-provider', 'Test Provider', 'claude')"
    )
    await migrated_db.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _make_cron_schedule(
    db: aiosqlite.Connection,
    *,
    cron_expr: str = "0 9 * * *",
    enabled: bool = True,
    next_fire_at: str | None = None,
    provider_id: int = 1,
) -> dict[str, Any]:
    """Insert a minimal cron schedule and return the row dict."""
    return await svc.create_schedule(
        db,
        name="test-schedule",
        kind="cron",
        cron_expr=cron_expr,
        event_name=None,
        agent_name="vega-research",
        prompt="Do something.",
        enabled=enabled,
        provider_id=provider_id,
        # Override next_fire_at after insert if provided.
    )


async def _override_next_fire_at(
    db: aiosqlite.Connection, schedule_id: int, dt: datetime
) -> None:
    await db.execute(
        "UPDATE schedules SET next_fire_at = ? WHERE id = ?",
        (dt.isoformat(sep=" ", timespec="seconds"), schedule_id),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# reap_orphaned_runs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reap_running_rows(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    # Insert a running row directly.
    await migrated_db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, fired_at) "
        "VALUES (?, 'cron', 'scheduled', 'running', CURRENT_TIMESTAMP)",
        (sid,),
    )
    await migrated_db.commit()

    reaped = await svc.reap_orphaned_runs(migrated_db)
    assert reaped == 1

    async with migrated_db.execute(
        "SELECT status FROM schedule_runs WHERE schedule_id = ?", (sid,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None and row["status"] == "failed"


@pytest.mark.asyncio
async def test_reap_queued_rows(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    await migrated_db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, fired_at) "
        "VALUES (?, 'cron', 'scheduled', 'queued', CURRENT_TIMESTAMP)",
        (sid,),
    )
    await migrated_db.commit()

    reaped = await svc.reap_orphaned_runs(migrated_db)
    assert reaped == 1


@pytest.mark.asyncio
async def test_reap_ignores_succeeded_rows(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    await migrated_db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, fired_at) "
        "VALUES (?, 'cron', 'scheduled', 'succeeded', CURRENT_TIMESTAMP)",
        (sid,),
    )
    await migrated_db.commit()

    reaped = await svc.reap_orphaned_runs(migrated_db)
    assert reaped == 0


@pytest.mark.asyncio
async def test_reap_multiple_rows(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    for status in ("running", "queued", "running"):
        await migrated_db.execute(
            "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, fired_at) "
            "VALUES (?, 'cron', 'scheduled', ?, CURRENT_TIMESTAMP)",
            (sid, status),
        )
    await migrated_db.commit()

    reaped = await svc.reap_orphaned_runs(migrated_db)
    assert reaped == 3


# ---------------------------------------------------------------------------
# sweep_stale_runs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_times_out_overdue_running_row(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    # started_at well past the default max_runtime + grace.
    overdue = (
        datetime.now()  # noqa: DTZ005
        - timedelta(
            seconds=svc._DEFAULT_MAX_RUNTIME_SEC + svc._STALE_RUN_GRACE_SEC + 60
        )
    ).isoformat(sep=" ", timespec="seconds")
    await migrated_db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, "
        "fired_at, started_at) VALUES (?, 'cron', 'manual', 'running', ?, ?)",
        (sid, overdue, overdue),
    )
    await migrated_db.commit()

    swept = await svc.sweep_stale_runs(migrated_db)
    assert swept == 1

    async with migrated_db.execute(
        "SELECT status FROM schedule_runs WHERE schedule_id = ?", (sid,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None and row["status"] == "timed_out"


@pytest.mark.asyncio
async def test_sweep_ignores_recent_running_row(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    recent = datetime.now().isoformat(sep=" ", timespec="seconds")  # noqa: DTZ005
    await migrated_db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, "
        "fired_at, started_at) VALUES (?, 'cron', 'manual', 'running', ?, ?)",
        (sid, recent, recent),
    )
    await migrated_db.commit()

    swept = await svc.sweep_stale_runs(migrated_db)
    assert swept == 0


@pytest.mark.asyncio
async def test_sweep_respects_per_schedule_max_runtime(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    # Pin a short max_runtime; a run started 200s ago is overdue (30 + grace).
    await migrated_db.execute(
        "UPDATE schedules SET max_runtime_sec = 30 WHERE id = ?", (sid,)
    )
    started = (datetime.now() - timedelta(seconds=200)).isoformat(  # noqa: DTZ005
        sep=" ", timespec="seconds"
    )
    await migrated_db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, "
        "fired_at, started_at) VALUES (?, 'cron', 'manual', 'running', ?, ?)",
        (sid, started, started),
    )
    await migrated_db.commit()

    swept = await svc.sweep_stale_runs(migrated_db)
    assert swept == 1


# ---------------------------------------------------------------------------
# interval schedules
# ---------------------------------------------------------------------------


async def _make_interval_schedule(
    db: aiosqlite.Connection,
    *,
    interval_seconds: int = 7200,
    provider_id: int = 1,
) -> dict[str, Any]:
    return await svc.create_schedule(
        db,
        name="every-n",
        kind="interval",
        cron_expr=None,
        event_name=None,
        agent_name="",
        prompt="Do something.",
        interval_seconds=interval_seconds,
        provider_id=provider_id,
    )


@pytest.mark.asyncio
async def test_create_interval_anchors_from_now(
    migrated_db: aiosqlite.Connection,
) -> None:
    sched = await _make_interval_schedule(migrated_db, interval_seconds=7200)
    assert sched["kind"] == "interval"
    assert sched["interval_seconds"] == 7200
    assert sched["cron_expr"] is None
    assert sched["anchor_at"] is not None
    nfa = datetime.fromisoformat(sched["next_fire_at"])
    delta = (nfa - datetime.now()).total_seconds()  # noqa: DTZ005
    # ~2h from creation (not aligned to a wall-clock boundary).
    assert 7100 < delta <= 7205


@pytest.mark.asyncio
async def test_create_interval_rejects_too_small(
    migrated_db: aiosqlite.Connection,
) -> None:
    with pytest.raises(HTTPException):
        await _make_interval_schedule(migrated_db, interval_seconds=30)


@pytest.mark.asyncio
async def test_tick_interval_advances_by_interval(
    migrated_db: aiosqlite.Connection,
) -> None:
    sched = await _make_interval_schedule(migrated_db, interval_seconds=3600)
    sid = sched["id"]
    # Force due: next_fire_at 10s in the past.
    past = (datetime.now() - timedelta(seconds=10)).isoformat(  # noqa: DTZ005
        sep=" ", timespec="seconds"
    )
    await migrated_db.execute(
        "UPDATE schedules SET next_fire_at = ? WHERE id = ?", (past, sid)
    )
    await migrated_db.commit()

    fired = await svc.tick(migrated_db)
    assert fired == 1

    runs = await svc.list_runs(migrated_db, sid)
    assert any(r["status"] == "queued" for r in runs)

    sched2 = await svc.get_schedule(migrated_db, sid)
    nfa = datetime.fromisoformat(sched2["next_fire_at"])
    # Advanced ~1 interval from the past slot → roughly an hour out, in the future.
    assert nfa > datetime.now()  # noqa: DTZ005
    assert (nfa - datetime.now()).total_seconds() > 3000  # noqa: DTZ005


# ---------------------------------------------------------------------------
# tick — happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tick_fires_due_schedule(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    # Set next_fire_at to 1 hour ago so it's definitely due.
    past = datetime.now() - timedelta(hours=1)  # noqa: DTZ005
    await _override_next_fire_at(migrated_db, sid, past)

    fired = await svc.tick(migrated_db)
    assert fired == 1

    async with migrated_db.execute(
        "SELECT status FROM schedule_runs WHERE schedule_id = ?", (sid,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None and row["status"] == "queued"


@pytest.mark.asyncio
async def test_tick_does_not_fire_future_schedule(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    # next_fire_at in the future.
    future = datetime.now() + timedelta(hours=2)  # noqa: DTZ005
    await _override_next_fire_at(migrated_db, sid, future)

    fired = await svc.tick(migrated_db)
    assert fired == 0


@pytest.mark.asyncio
async def test_tick_advances_next_fire_at(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db, cron_expr="0 9 * * *")
    sid = schedule["id"]
    past = datetime.now() - timedelta(hours=1)  # noqa: DTZ005
    await _override_next_fire_at(migrated_db, sid, past)

    await svc.tick(migrated_db)

    async with migrated_db.execute(
        "SELECT next_fire_at FROM schedules WHERE id = ?", (sid,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    nfa = datetime.fromisoformat(str(row["next_fire_at"]))
    # The new next_fire_at must be in the future.
    assert nfa > datetime.now()  # noqa: DTZ005


# ---------------------------------------------------------------------------
# tick — overlap guard
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tick_overlap_guard_skips(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    past = datetime.now() - timedelta(hours=1)  # noqa: DTZ005
    await _override_next_fire_at(migrated_db, sid, past)

    # Insert an already-running row.
    await migrated_db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, fired_at) "
        "VALUES (?, 'cron', 'scheduled', 'running', CURRENT_TIMESTAMP)",
        (sid,),
    )
    await migrated_db.commit()

    fired = await svc.tick(migrated_db)
    assert fired == 0

    # A `skipped` row should have been inserted.
    async with migrated_db.execute(
        "SELECT status FROM schedule_runs WHERE schedule_id = ? AND status = 'skipped'",
        (sid,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None


@pytest.mark.asyncio
async def test_tick_overlap_guard_with_queued_row(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    past = datetime.now() - timedelta(hours=1)  # noqa: DTZ005
    await _override_next_fire_at(migrated_db, sid, past)

    # Insert an already-queued row (not yet claimed by the shell).
    await migrated_db.execute(
        "INSERT INTO schedule_runs (schedule_id, trigger_kind, trigger, status, fired_at) "
        "VALUES (?, 'cron', 'scheduled', 'queued', CURRENT_TIMESTAMP)",
        (sid,),
    )
    await migrated_db.commit()

    fired = await svc.tick(migrated_db)
    assert fired == 0


# ---------------------------------------------------------------------------
# tick — staleness guard
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tick_staleness_guard_records_missed(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    # Set next_fire_at to > 24 h ago.
    very_old = datetime.now() - timedelta(hours=25)  # noqa: DTZ005
    await _override_next_fire_at(migrated_db, sid, very_old)

    fired = await svc.tick(migrated_db)
    assert fired == 0  # missed, not fired

    async with migrated_db.execute(
        "SELECT status FROM schedule_runs WHERE schedule_id = ?", (sid,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None and row["status"] == "missed"


@pytest.mark.asyncio
async def test_tick_staleness_guard_advances_next_fire(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    very_old = datetime.now() - timedelta(hours=48)  # noqa: DTZ005
    await _override_next_fire_at(migrated_db, sid, very_old)

    await svc.tick(migrated_db)

    async with migrated_db.execute(
        "SELECT next_fire_at FROM schedules WHERE id = ?", (sid,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    nfa = datetime.fromisoformat(str(row["next_fire_at"]))
    assert nfa > datetime.now()  # noqa: DTZ005


# ---------------------------------------------------------------------------
# Run lifecycle — start_run
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_run_transitions_to_running(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="queued")
    run_id = run["id"]

    result = await svc.start_run(migrated_db, run_id)
    assert result["status"] == "running"
    assert result["started_at"] is not None


@pytest.mark.asyncio
async def test_start_run_only_acts_on_queued(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    # Insert a run that is already 'running' (not queued).
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="running")
    run_id = run["id"]

    # start_run should be a no-op (WHERE status='queued' doesn't match).
    result = await svc.start_run(migrated_db, run_id)
    # The row is still 'running' (not changed to something else).
    assert result["status"] == "running"


# ---------------------------------------------------------------------------
# Run lifecycle — finish_run
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_finish_run_success(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="running")
    await migrated_db.execute(
        "UPDATE schedule_runs SET started_at = CURRENT_TIMESTAMP WHERE id = ?",
        (run["id"],),
    )
    await migrated_db.commit()

    result = await svc.finish_run(
        migrated_db,
        run["id"],
        exit_code=0,
        transcript_path="/tmp/run.log",
        tokens_in=100,
        tokens_out=200,
        cost_usd=0.01,
        summary_text="Done.",
    )
    assert result["status"] == "succeeded"
    assert result["exit_code"] == 0
    assert result["tokens_in"] == 100
    assert result["tokens_out"] == 200
    assert result["cost_usd"] == pytest.approx(0.01)
    assert result["summary_text"] == "Done."
    assert result["finished_at"] is not None


@pytest.mark.asyncio
async def test_finish_run_failure(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="running")

    result = await svc.finish_run(migrated_db, run["id"], exit_code=1)
    assert result["status"] == "failed"
    assert result["exit_code"] == 1


@pytest.mark.asyncio
async def test_finish_run_computes_duration(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="running")
    # Backdate started_at by 5 seconds.
    started = datetime.now() - timedelta(seconds=5)  # noqa: DTZ005
    await migrated_db.execute(
        "UPDATE schedule_runs SET started_at = ? WHERE id = ?",
        (started.isoformat(sep=" ", timespec="seconds"), run["id"]),
    )
    await migrated_db.commit()

    result = await svc.finish_run(migrated_db, run["id"], exit_code=0)
    assert result["duration_ms"] is not None
    assert result["duration_ms"] >= 5000


# ---------------------------------------------------------------------------
# Run lifecycle — timeout_run
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_run(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="running")

    result = await svc.timeout_run(migrated_db, run["id"])
    assert result["status"] == "timed_out"
    assert result["exit_code"] == -1
    assert result["finished_at"] is not None


@pytest.mark.asyncio
async def test_timeout_run_only_acts_on_running(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="queued")

    result = await svc.timeout_run(migrated_db, run["id"])
    # WHERE status='running' doesn't match queued → no state change.
    assert result["status"] == "queued"


# ---------------------------------------------------------------------------
# Run lifecycle — cancel_run
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_queued_run(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="queued")

    result = await svc.cancel_run(migrated_db, run["id"])
    assert result["status"] == "cancelled"
    assert result["finished_at"] is not None


@pytest.mark.asyncio
async def test_cancel_running_run(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="running")

    result = await svc.cancel_run(migrated_db, run["id"])
    assert result["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_succeeded_run_is_noop(migrated_db: aiosqlite.Connection) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    run = await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="queued")
    await migrated_db.execute(
        "UPDATE schedule_runs SET status = 'succeeded' WHERE id = ?", (run["id"],)
    )
    await migrated_db.commit()

    result = await svc.cancel_run(migrated_db, run["id"])
    # WHERE status IN ('queued','running') doesn't match → no change.
    assert result["status"] == "succeeded"


# ---------------------------------------------------------------------------
# claim_pending_dispatches
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_pending_dispatches_returns_queued(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="queued")

    items = await svc.claim_pending_dispatches(migrated_db)
    assert len(items) == 1
    item = items[0]
    assert item["run_id"] is not None
    assert item["schedule_id"] == sid
    assert item["agent_name"] == "vega-research"
    assert item["prompt"] == "Do something."


@pytest.mark.asyncio
async def test_claim_pending_dispatches_excludes_non_queued(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="running")
    await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="succeeded")
    await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="failed")

    items = await svc.claim_pending_dispatches(migrated_db)
    assert items == []


@pytest.mark.asyncio
async def test_claim_pending_dispatches_limit(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    for _ in range(5):
        await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="queued")

    items = await svc.claim_pending_dispatches(migrated_db, limit=3)
    assert len(items) == 3


# ---------------------------------------------------------------------------
# fire_manual
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fire_manual_returns_schedule_and_run(
    migrated_db: aiosqlite.Connection,
) -> None:
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]

    result = await svc.fire_manual(migrated_db, sid)
    assert "schedule" in result
    assert "run" in result
    assert result["run"]["status"] == "queued"
    assert result["run"]["trigger_kind"] == "manual"


@pytest.mark.asyncio
async def test_fire_manual_overlap_guard(migrated_db: aiosqlite.Connection) -> None:
    from fastapi import HTTPException

    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    # Insert an already-running row.
    await svc._insert_run(migrated_db, sid, "cron", "scheduled", status="running")

    with pytest.raises(HTTPException) as exc_info:
        await svc.fire_manual(migrated_db, sid)
    assert exc_info.value.status_code == 409


@pytest.mark.asyncio
async def test_fire_manual_not_found(migrated_db: aiosqlite.Connection) -> None:
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        await svc.fire_manual(migrated_db, 9999)
    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_fire_manual_reanchors_interval_schedule(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Manually firing an interval schedule resets next_fire_at to now+interval.

    "Run now" should restart the cadence so the next automatic fire is a full
    interval away — not the stale slot left over from the original anchor.
    """
    schedule = await _make_interval_schedule(migrated_db, interval_seconds=7200)
    sid = schedule["id"]
    # Simulate a countdown that's nearly elapsed (next fire only 10 min out).
    near = datetime.now() + timedelta(seconds=600)  # noqa: DTZ005
    await _override_next_fire_at(migrated_db, sid, near)

    before = datetime.now()  # noqa: DTZ005
    result = await svc.fire_manual(migrated_db, sid)
    after = datetime.now()  # noqa: DTZ005

    nfa = datetime.fromisoformat(result["schedule"]["next_fire_at"])
    # Re-anchored to ~now + 2h, not the old 10-minute slot.
    assert nfa >= before + timedelta(seconds=7200) - timedelta(seconds=5)
    assert nfa <= after + timedelta(seconds=7200) + timedelta(seconds=5)


@pytest.mark.asyncio
async def test_fire_manual_leaves_cron_next_fire_untouched(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Manually firing a cron schedule must not shift its wall-clock slot."""
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    before = (await svc.get_schedule(migrated_db, sid))["next_fire_at"]
    await svc.fire_manual(migrated_db, sid)
    after = (await svc.get_schedule(migrated_db, sid))["next_fire_at"]
    assert before == after


# ---------------------------------------------------------------------------
# A4 — provider-required + artifact_dir contract
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_schedule_requires_provider(
    migrated_db: aiosqlite.Connection,
) -> None:
    """create_schedule with provider_id=None raises HTTP 400."""
    with pytest.raises(HTTPException) as exc_info:
        await svc.create_schedule(
            migrated_db,
            name="no-provider",
            kind="cron",
            cron_expr="0 9 * * *",
            event_name=None,
            agent_name="vega-research",
            prompt="Do something.",
            provider_id=None,
        )
    assert exc_info.value.status_code == 400
    assert "provider" in exc_info.value.detail.lower()


@pytest.mark.asyncio
async def test_artifact_dir_round_trip(
    migrated_db: aiosqlite.Connection,
) -> None:
    """artifact_dir is persisted on create and returned by get_schedule."""
    schedule = await svc.create_schedule(
        migrated_db,
        name="artifact-sched",
        kind="cron",
        cron_expr="0 10 * * *",
        event_name=None,
        agent_name="",
        prompt="Write a report.",
        provider_id=1,
        result_kind="artifact",
        artifact_dir="/custom/output/dir",
    )
    assert schedule["artifact_dir"] == "/custom/output/dir"

    fetched = await svc.get_schedule(migrated_db, schedule["id"])
    assert fetched["artifact_dir"] == "/custom/output/dir"


@pytest.mark.asyncio
async def test_update_schedule_sets_artifact_dir(
    migrated_db: aiosqlite.Connection,
) -> None:
    """update_schedule can set artifact_dir via PATCH."""
    schedule = await _make_cron_schedule(migrated_db)
    sid = schedule["id"]
    assert schedule.get("artifact_dir") is None

    updated = await svc.update_schedule(
        migrated_db, sid, {"artifact_dir": "/tmp/custom-artifacts"}
    )
    assert updated["artifact_dir"] == "/tmp/custom-artifacts"


@pytest.mark.asyncio
async def test_claim_pending_dispatches_artifact_target_path(
    migrated_db: aiosqlite.Connection,
) -> None:
    """claim_pending_dispatches returns artifact_target_path for artifact runs and None for transcript runs."""
    # Artifact schedule
    artifact_sched = await svc.create_schedule(
        migrated_db,
        name="My Artifact Report",
        kind="cron",
        cron_expr="0 8 * * *",
        event_name=None,
        agent_name="",
        prompt="Produce a report.",
        provider_id=1,
        result_kind="artifact",
    )
    artifact_sid = artifact_sched["id"]
    artifact_run = await svc._insert_run(
        migrated_db, artifact_sid, "cron", "scheduled", status="queued"
    )
    artifact_run_id = artifact_run["id"]

    # Transcript schedule
    transcript_sched = await svc.create_schedule(
        migrated_db,
        name="transcript-job",
        kind="cron",
        cron_expr="0 9 * * *",
        event_name=None,
        agent_name="",
        prompt="Do something.",
        provider_id=1,
        result_kind="transcript",
    )
    transcript_sid = transcript_sched["id"]
    await svc._insert_run(
        migrated_db, transcript_sid, "cron", "scheduled", status="queued"
    )

    items = await svc.claim_pending_dispatches(migrated_db)
    assert len(items) == 2

    artifact_item = next(i for i in items if i["schedule_id"] == artifact_sid)
    transcript_item = next(i for i in items if i["schedule_id"] == transcript_sid)

    # Artifact: path must end in -run<run_id>.md
    atp = artifact_item["artifact_target_path"]
    assert atp is not None
    assert atp.endswith(f"-run{artifact_run_id}.md")

    # Transcript: no artifact path
    assert transcript_item["artifact_target_path"] is None


# ---------------------------------------------------------------------------
# prune_transcript_blobs
# ---------------------------------------------------------------------------


async def _make_finished_run(
    db: aiosqlite.Connection,
    *,
    transcript_path: str | None = None,
    artifact_path: str | None = None,
    age_days: float = 0,
) -> dict[str, Any]:
    """Insert a succeeded run with explicit file paths and a backdated finished_at."""
    schedule = await _make_cron_schedule(db)
    run = await svc._insert_run(
        db, schedule["id"], "cron", "scheduled", status="running"
    )
    run_id = run["id"]

    finished = datetime.now() - timedelta(days=age_days)  # noqa: DTZ005
    finished_str = finished.isoformat(sep=" ", timespec="seconds")
    await db.execute(
        """
        UPDATE schedule_runs
        SET status = 'succeeded', finished_at = ?,
            transcript_path = ?, artifact_path = ?
        WHERE id = ?
        """,
        (finished_str, transcript_path, artifact_path, run_id),
    )
    await db.commit()
    return {"id": run_id, "schedule_id": schedule["id"]}


@pytest.mark.asyncio
async def test_prune_deletes_transcript_not_artifact(
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
) -> None:
    """Transcript file is deleted and its column NULLed; artifact file and column are untouched."""
    runs_dir = tmp_path / "schedule-runs"
    runs_dir.mkdir()
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()

    transcript_file = runs_dir / "run1.log"
    transcript_file.write_text("raw log")
    artifact_file = artifact_dir / "run1.md"
    artifact_file.write_text("# Deliverable")

    run = await _make_finished_run(
        migrated_db,
        transcript_path=str(transcript_file),
        artifact_path=str(artifact_file),
        age_days=35,  # older than default 30-day retention
    )
    run_id = run["id"]

    result = await svc.prune_transcript_blobs(
        migrated_db,
        runs_dir=runs_dir,
        retention_days=30,
    )

    assert result["files_deleted"] == 1
    assert result["rows_cleared"] == 1

    # Transcript file is gone.
    assert not transcript_file.exists()

    # Artifact file still exists.
    assert artifact_file.exists()
    assert artifact_file.read_text() == "# Deliverable"

    # DB: transcript_path NULLed, artifact_path unchanged.
    async with migrated_db.execute(
        "SELECT transcript_path, artifact_path FROM schedule_runs WHERE id = ?",
        (run_id,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["transcript_path"] is None
    assert row["artifact_path"] == str(artifact_file)


@pytest.mark.asyncio
async def test_prune_skips_recent_run(
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
) -> None:
    """Runs finished within the retention window are not pruned."""
    runs_dir = tmp_path / "schedule-runs"
    runs_dir.mkdir()

    transcript_file = runs_dir / "recent.log"
    transcript_file.write_text("still fresh")

    await _make_finished_run(
        migrated_db,
        transcript_path=str(transcript_file),
        age_days=5,  # well within 30-day window
    )

    result = await svc.prune_transcript_blobs(
        migrated_db,
        runs_dir=runs_dir,
        retention_days=30,
    )

    assert result["files_deleted"] == 0
    assert result["rows_cleared"] == 0
    assert transcript_file.exists()


@pytest.mark.asyncio
async def test_prune_safety_guard_outside_runs_dir(
    migrated_db: aiosqlite.Connection,
    tmp_path: pathlib.Path,
) -> None:
    """A transcript_path pointing outside runs_dir is NOT unlinked but the column IS cleared."""
    runs_dir = tmp_path / "schedule-runs"
    runs_dir.mkdir()

    # This file lives outside runs_dir — simulates a corrupt or injected path.
    outside_dir = tmp_path / "elsewhere"
    outside_dir.mkdir()
    outside_file = outside_dir / "secret.log"
    outside_file.write_text("should not be deleted")

    run = await _make_finished_run(
        migrated_db,
        transcript_path=str(outside_file),
        age_days=35,
    )
    run_id = run["id"]

    result = await svc.prune_transcript_blobs(
        migrated_db,
        runs_dir=runs_dir,
        retention_days=30,
    )

    # No file should have been deleted.
    assert result["files_deleted"] == 0
    # But the column is still cleared so it won't show up in future prune passes.
    assert result["rows_cleared"] == 1
    assert outside_file.exists()
    assert outside_file.read_text() == "should not be deleted"

    async with migrated_db.execute(
        "SELECT transcript_path FROM schedule_runs WHERE id = ?",
        (run_id,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["transcript_path"] is None
