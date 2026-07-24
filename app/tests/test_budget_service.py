"""Tests for budget_service.

Covers calendar-period math, scope-aware spend aggregation, threshold
alert dedup, and hard-stop evaluation.
"""

from __future__ import annotations

import pathlib
from datetime import datetime, timedelta

import aiosqlite
import pytest
import pytest_asyncio

from app.services import budget_service, notification_service

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
    notification_service._subscribers.clear()
    yield conn
    await conn.close()


async def _insert_session(
    db: aiosqlite.Connection,
    session_id: str,
    cost: float,
    started_at: datetime,
    profile: str = "default",
    project_id: int | None = None,
) -> None:
    await db.execute(
        """INSERT INTO agent_sessions
               (session_id, profile, status, started_at, last_event_at,
                cost_usd, project_id)
           VALUES (?, ?, 'idle', ?, ?, ?, ?)""",
        (
            session_id,
            profile,
            started_at.isoformat(sep=" "),
            started_at.isoformat(sep=" "),
            cost,
            project_id,
        ),
    )
    if project_id is not None:
        # Project-scoped budgets aggregate the per-file attribution ledger
        # (session_project_costs, migration 062) rather than
        # agent_sessions.project_id, so a session attributed to a project must
        # appear there too. Attribute the full session cost to its project.
        await db.execute(
            """INSERT INTO session_project_costs (session_id, project_id, cost_usd)
               VALUES (?, ?, ?)""",
            (session_id, project_id, cost),
        )
    await db.commit()


# ─── Period math ──────────────────────────────────────────────────────────────


def test_daily_bounds_are_calendar_aligned():
    moment = datetime(2026, 5, 15, 14, 23, 59)  # noqa: DTZ001
    start, end = budget_service.period_bounds("daily", now=moment)
    assert start == "2026-05-15 00:00:00"
    assert end == "2026-05-16 00:00:00"


def test_weekly_bounds_anchor_on_monday():
    # 2026-05-15 is a Friday → expect Monday 2026-05-11 to next Monday 2026-05-18
    moment = datetime(2026, 5, 15, 12, 0, 0)  # noqa: DTZ001
    start, end = budget_service.period_bounds("weekly", now=moment)
    assert start.startswith("2026-05-11")
    assert end.startswith("2026-05-18")


def test_monthly_bounds_handle_december_rollover():
    moment = datetime(2026, 12, 17, 9, 0, 0)  # noqa: DTZ001
    start, end = budget_service.period_bounds("monthly", now=moment)
    assert start.startswith("2026-12-01")
    assert end.startswith("2027-01-01")


def test_monthly_bounds_for_february():
    moment = datetime(2026, 2, 5, 9, 0, 0)  # noqa: DTZ001
    start, end = budget_service.period_bounds("monthly", now=moment)
    assert start.startswith("2026-02-01")
    assert end.startswith("2026-03-01")


# ─── Spend evaluator ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_burn_only_counts_sessions_in_period(db):
    now = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)  # noqa: DTZ005
    yesterday = now - timedelta(days=2)
    await _insert_session(db, "s1", 0.5, now, profile="default")
    await _insert_session(db, "s2", 99.0, yesterday, profile="default")  # excluded
    budget = await budget_service.create_budget(
        db,
        {
            "name": "today",
            "scope_type": "workspace",
            "period": "daily",
            "limit_usd": 1.0,
        },
    )
    burn = await budget_service.burn_for_budget(db, budget, now=now)
    assert burn["spent_usd"] == pytest.approx(0.5)
    assert burn["percent"] == pytest.approx(50.0)


@pytest.mark.asyncio
async def test_project_scope_filters_other_projects(db):
    await db.execute("INSERT INTO projects (id, name, path) VALUES (1001, 'A', '/a')")
    await db.execute("INSERT INTO projects (id, name, path) VALUES (1002, 'B', '/b')")
    await db.commit()
    now = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)  # noqa: DTZ005
    await _insert_session(db, "a1", 5.0, now, project_id=1001)
    await _insert_session(db, "b1", 99.0, now, project_id=1002)
    budget = await budget_service.create_budget(
        db,
        {
            "name": "Project A monthly",
            "scope_type": "project",
            "scope_id": 1001,
            "period": "monthly",
            "limit_usd": 10.0,
        },
    )
    burn = await budget_service.burn_for_budget(db, budget, now=now)
    assert burn["spent_usd"] == pytest.approx(5.0)


# ─── Threshold dedup ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_thresholds_fire_once_per_period(db):
    now = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)  # noqa: DTZ005
    await _insert_session(db, "s1", 0.55, now)  # 55% → fires 50%
    await budget_service.create_budget(
        db,
        {
            "name": "Daily cap",
            "scope_type": "workspace",
            "period": "daily",
            "limit_usd": 1.0,
        },
    )
    fired = await budget_service.evaluate_alerts(db)
    assert fired == 1
    # Calling again with same spend should be a no-op (already fired).
    fired_again = await budget_service.evaluate_alerts(db)
    assert fired_again == 0
    # Push spend over 100% → 80% AND 100% should both fire on next eval.
    await _insert_session(db, "s2", 0.50, now)
    fired_more = await budget_service.evaluate_alerts(db)
    assert fired_more == 2

    cur = await db.execute("SELECT type, priority FROM notifications ORDER BY id")
    rows = list(await cur.fetchall())
    assert all(r["type"] == "budget_threshold" for r in rows)
    # 100% must be high-priority; 50/80 are normal.
    priorities = [r["priority"] for r in rows]
    assert priorities.count("high") == 1
    assert priorities.count("normal") == 2


# ─── Hard-stop evaluator ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hard_stop_allows_when_under_limit(db):
    now = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)  # noqa: DTZ005
    await _insert_session(db, "s1", 0.10, now)
    await budget_service.create_budget(
        db,
        {
            "name": "Daily",
            "scope_type": "workspace",
            "period": "daily",
            "limit_usd": 1.0,
            "hard_stop": True,
        },
    )
    allow, reason = await budget_service.check_hard_stop(db, None, None)
    assert allow is True
    assert reason is None


@pytest.mark.asyncio
async def test_hard_stop_blocks_when_over_limit(db):
    now = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)  # noqa: DTZ005
    await _insert_session(db, "s1", 2.00, now)
    await budget_service.create_budget(
        db,
        {
            "name": "Daily",
            "scope_type": "workspace",
            "period": "daily",
            "limit_usd": 1.0,
            "hard_stop": True,
        },
    )
    allow, reason = await budget_service.check_hard_stop(db, None, None)
    assert allow is False
    assert reason is not None and "Daily" in reason


@pytest.mark.asyncio
async def test_hard_stop_ignores_disabled_or_non_hard_stop(db):
    now = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)  # noqa: DTZ005
    await _insert_session(db, "s1", 5.00, now)
    # over limit but hard_stop=False
    await budget_service.create_budget(
        db,
        {
            "name": "Soft cap",
            "scope_type": "workspace",
            "period": "daily",
            "limit_usd": 1.0,
            "hard_stop": False,
        },
    )
    # over limit + hard_stop, but disabled
    soft = await budget_service.create_budget(
        db,
        {
            "name": "Disabled cap",
            "scope_type": "workspace",
            "period": "daily",
            "limit_usd": 1.0,
            "hard_stop": True,
        },
    )
    await budget_service.update_budget(db, soft["id"], {"enabled": False})
    allow, _ = await budget_service.check_hard_stop(db, None, None)
    assert allow is True


@pytest.mark.asyncio
async def test_hard_stop_project_scope_only_matches_that_project(db):
    await db.execute("INSERT INTO projects (id, name, path) VALUES (1001, 'A', '/a')")
    await db.execute("INSERT INTO projects (id, name, path) VALUES (1002, 'B', '/b')")
    await db.commit()
    now = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)  # noqa: DTZ005
    await _insert_session(db, "a1", 5.0, now, project_id=1001)
    await budget_service.create_budget(
        db,
        {
            "name": "A cap",
            "scope_type": "project",
            "scope_id": 1001,
            "period": "daily",
            "limit_usd": 1.0,
            "hard_stop": True,
        },
    )
    # Different project — should still be allowed.
    allow_b, _ = await budget_service.check_hard_stop(db, 1002, None)
    assert allow_b is True
    # Project A is blocked.
    allow_a, reason_a = await budget_service.check_hard_stop(db, 1001, None)
    assert allow_a is False
    assert reason_a is not None


# ─── Validation ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_budget_rejects_invalid_scope(db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await budget_service.create_budget(
            db,
            {
                "name": "Bad",
                "scope_type": "project",  # missing scope_id
                "period": "daily",
                "limit_usd": 1.0,
            },
        )

    with pytest.raises(HTTPException):
        await budget_service.create_budget(
            db,
            {
                "name": "Bad",
                "scope_type": "workspace",
                "period": "daily",
                "limit_usd": 0,  # must be > 0
            },
        )
