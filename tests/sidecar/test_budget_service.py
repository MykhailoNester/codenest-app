"""Tests for budget spend — especially per-project burn via the attribution ledger."""

from __future__ import annotations

from datetime import UTC, datetime

import aiosqlite
import pytest
from fastapi import HTTPException

from app.services import budget_service

_NOW = datetime.now(UTC).replace(tzinfo=None).isoformat(sep=" ")
_OLD = "2000-01-01 00:00:00"


async def _project(db: aiosqlite.Connection, name: str) -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, status) VALUES (?, 'active')", (name,)
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


async def _session(
    db: aiosqlite.Connection,
    sid: str,
    cost: float,
    project_id: int | None = None,
    started_at: str = _NOW,
) -> None:
    await db.execute(
        "INSERT INTO agent_sessions "
        "(session_id, profile, status, started_at, last_event_at, cost_usd, project_id) "
        "VALUES (?, 'unknown', 'idle', ?, ?, ?, ?)",
        (sid, started_at, started_at, cost, project_id),
    )
    await db.commit()


async def _attribute(
    db: aiosqlite.Connection, sid: str, project_id: int, cost: float
) -> None:
    await db.execute(
        "INSERT INTO session_project_costs (session_id, project_id, cost_usd) "
        "VALUES (?, ?, ?)",
        (sid, project_id, cost),
    )
    await db.commit()


async def _budget(db: aiosqlite.Connection, **payload) -> dict:
    payload.setdefault("name", "b")
    payload.setdefault("period", "monthly")
    payload.setdefault("limit_usd", 100.0)
    return await budget_service.create_budget(db, payload)


# ─── validation ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_budget_scope_validation(
    migrated_db: aiosqlite.Connection,
) -> None:
    with pytest.raises(HTTPException):
        await _budget(migrated_db, scope_type="project")  # missing scope_id
    with pytest.raises(HTTPException):
        await _budget(migrated_db, scope_type="agent")  # missing scope_key
    with pytest.raises(HTTPException):
        await _budget(migrated_db, scope_type="workspace", scope_id=1)  # extra id
    with pytest.raises(HTTPException):
        await _budget(migrated_db, scope_type="project", scope_id=1, period="hourly")
    ok = await _budget(migrated_db, scope_type="workspace")
    assert ok["scope_type"] == "workspace" and ok["enabled"] is True


# ─── burn ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_workspace_burn_sums_all_sessions(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(migrated_db, "s1", 5.0)
    await _session(migrated_db, "s2", 2.5)
    budget = await _budget(migrated_db, scope_type="workspace")
    burn = await budget_service.burn_for_budget(migrated_db, budget)
    assert burn["spent_usd"] == 7.5


@pytest.mark.asyncio
async def test_project_burn_uses_attribution_ledger_not_session_bucket(
    migrated_db: aiosqlite.Connection,
) -> None:
    a = await _project(migrated_db, "A")
    b = await _project(migrated_db, "B")
    # One workspace session bucketed (coarsely) to A, costing 5 total, but the
    # attribution ledger splits it 2 -> A, 3 -> B.
    await _session(migrated_db, "s1", 5.0, project_id=a)
    await _attribute(migrated_db, "s1", a, 2.0)
    await _attribute(migrated_db, "s1", b, 3.0)

    budget_b = await _budget(migrated_db, scope_type="project", scope_id=b)
    burn_b = await budget_service.burn_for_budget(migrated_db, budget_b)
    assert burn_b["spent_usd"] == 3.0  # from ledger, not 0 (B != session bucket)

    budget_a = await _budget(migrated_db, scope_type="project", scope_id=a)
    burn_a = await budget_service.burn_for_budget(migrated_db, budget_a)
    assert burn_a["spent_usd"] == 2.0  # from ledger, not 5.0 (the session total)


@pytest.mark.asyncio
async def test_project_burn_ignores_session_bucket_without_attribution(
    migrated_db: aiosqlite.Connection,
) -> None:
    # A session coarsely bucketed to P but with NO attribution ledger rows
    # contributes 0 — project burn reads the ledger, not agent_sessions.project_id.
    p = await _project(migrated_db, "P")
    await _session(migrated_db, "s1", 5.0, project_id=p)  # no _attribute()
    budget = await _budget(migrated_db, scope_type="project", scope_id=p)
    burn = await budget_service.burn_for_budget(migrated_db, budget)
    assert burn["spent_usd"] == 0.0


@pytest.mark.asyncio
async def test_project_burn_respects_period(migrated_db: aiosqlite.Connection) -> None:
    p = await _project(migrated_db, "P")
    await _session(migrated_db, "old", 9.0, project_id=p, started_at=_OLD)
    await _attribute(migrated_db, "old", p, 9.0)
    budget = await _budget(migrated_db, scope_type="project", scope_id=p)
    burn = await budget_service.burn_for_budget(migrated_db, budget)
    assert burn["spent_usd"] == 0.0  # the spend is outside the current month


@pytest.mark.asyncio
async def test_hard_stop_blocks_project_over_limit(
    migrated_db: aiosqlite.Connection,
) -> None:
    p = await _project(migrated_db, "P")
    await _session(migrated_db, "s1", 2.0, project_id=p)
    await _attribute(migrated_db, "s1", p, 2.0)
    await _budget(
        migrated_db,
        scope_type="project",
        scope_id=p,
        limit_usd=1.0,
        hard_stop=True,
    )
    allow, reason = await budget_service.check_hard_stop(migrated_db, p, None)
    assert allow is False and reason is not None
    # A different project is unaffected.
    allow2, _ = await budget_service.check_hard_stop(migrated_db, p + 999, None)
    assert allow2 is True
