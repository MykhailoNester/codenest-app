"""Cost budgets, quotas, and alerts.

A *budget* caps AI spend for a scope (workspace | project | agent) within
a calendar-aligned period (daily | weekly | monthly). Three pieces:

1. CRUD over the ``budgets`` table.
2. A spend evaluator that computes burn for one budget over its current
   period. Workspace/agent scopes aggregate ``agent_sessions.cost_usd``;
   project scope aggregates the per-file attribution ledger
   (``session_project_costs``) so workspace-root sessions count toward the
   projects they actually touched.
3. An alert evaluator called from ``agent_service.record_stop`` that
   emits a notification each time spend crosses 50/80/100% within the
   period, deduped via ``budget_threshold_alerts``.

Hard-stop (``hard_stop=1``) is consulted by ``hook_session_start`` to
block new sessions once a matching budget is at or above 100%.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Literal

import aiosqlite
from fastapi import HTTPException

from . import notification_service

ScopeType = Literal["workspace", "project", "agent"]
Period = Literal["daily", "weekly", "monthly"]

_THRESHOLDS: tuple[int, ...] = (50, 80, 100)
_VALID_SCOPE: frozenset[str] = frozenset({"workspace", "project", "agent"})
_VALID_PERIOD: frozenset[str] = frozenset({"daily", "weekly", "monthly"})


# ─── Period math ──────────────────────────────────────────────────────────────


def period_bounds(period: Period, now: datetime | None = None) -> tuple[str, str]:
    """Return (start_iso, end_iso) for the calendar period containing ``now``.

    Bounds are inclusive-start / exclusive-end ISO timestamps in **UTC**
    naive form so they line up with ``agent_sessions.started_at``, which
    ``agent_service`` writes via ``datetime.utcnow().isoformat(...)``.

    - daily: UTC midnight today → UTC midnight tomorrow
    - weekly: UTC Monday 00:00 → next UTC Monday 00:00
    - monthly: UTC 1st of this month 00:00 → UTC 1st of next month 00:00
    """
    moment = now or datetime.utcnow()
    today = moment.date()
    if period == "daily":
        start = datetime.combine(today, datetime.min.time())
        end = start + timedelta(days=1)
    elif period == "weekly":
        monday = today - timedelta(days=today.weekday())
        start = datetime.combine(monday, datetime.min.time())
        end = start + timedelta(days=7)
    elif period == "monthly":
        first = today.replace(day=1)
        if first.month == 12:
            next_first = date(first.year + 1, 1, 1)
        else:
            next_first = date(first.year, first.month + 1, 1)
        start = datetime.combine(first, datetime.min.time())
        end = datetime.combine(next_first, datetime.min.time())
    else:  # pragma: no cover - validated upstream
        raise ValueError(f"unknown period {period!r}")
    return start.isoformat(sep=" "), end.isoformat(sep=" ")


# ─── Validation ───────────────────────────────────────────────────────────────


def _validate_scope(scope_type: str, scope_id: Any, scope_key: Any) -> None:
    if scope_type not in _VALID_SCOPE:
        raise HTTPException(400, f"scope_type must be one of {sorted(_VALID_SCOPE)}")
    if scope_type == "project":
        if scope_id is None or not isinstance(scope_id, int):
            raise HTTPException(400, "project scope requires integer scope_id")
        if scope_key is not None:
            raise HTTPException(400, "project scope must not set scope_key")
    elif scope_type == "agent":
        if not isinstance(scope_key, str) or not scope_key.strip():
            raise HTTPException(400, "agent scope requires non-empty scope_key")
        if scope_id is not None:
            raise HTTPException(400, "agent scope must not set scope_id")
    else:  # workspace
        if scope_id is not None or scope_key is not None:
            raise HTTPException(400, "workspace scope must not set scope_id/scope_key")


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    d["hard_stop"] = bool(d.get("hard_stop", 0))
    d["enabled"] = bool(d.get("enabled", 0))
    return d


# ─── CRUD ─────────────────────────────────────────────────────────────────────


async def list_budgets(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    async with db.execute("SELECT * FROM budgets ORDER BY scope_type, name, id") as cur:
        rows = await cur.fetchall()
    return [_row_to_dict(r) for r in rows]


async def get_budget(db: aiosqlite.Connection, budget_id: int) -> dict[str, Any]:
    async with db.execute("SELECT * FROM budgets WHERE id = ?", (budget_id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "budget not found")
    return _row_to_dict(row)


async def create_budget(
    db: aiosqlite.Connection, payload: dict[str, Any]
) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "name is required")
    scope_type = str(payload.get("scope_type", ""))
    scope_id = payload.get("scope_id")
    scope_key = payload.get("scope_key")
    _validate_scope(scope_type, scope_id, scope_key)
    period = str(payload.get("period", ""))
    if period not in _VALID_PERIOD:
        raise HTTPException(400, f"period must be one of {sorted(_VALID_PERIOD)}")
    try:
        limit_usd = float(payload.get("limit_usd", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "limit_usd must be a number") from None
    if limit_usd <= 0:
        raise HTTPException(400, "limit_usd must be > 0")
    hard_stop = 1 if bool(payload.get("hard_stop", False)) else 0
    enabled = 0 if payload.get("enabled") is False else 1
    cur = await db.execute(
        """INSERT INTO budgets
               (name, scope_type, scope_id, scope_key, period, limit_usd,
                hard_stop, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (name, scope_type, scope_id, scope_key, period, limit_usd, hard_stop, enabled),
    )
    await db.commit()
    return await get_budget(db, int(cur.lastrowid or 0))


_ALLOWED_PATCH = frozenset({"name", "limit_usd", "hard_stop", "enabled", "period"})


async def update_budget(
    db: aiosqlite.Connection, budget_id: int, payload: dict[str, Any]
) -> dict[str, Any]:
    await get_budget(db, budget_id)  # 404 if missing
    sets: list[str] = []
    params: list[Any] = []
    for key, value in payload.items():
        if key not in _ALLOWED_PATCH:
            continue
        if key == "limit_usd":
            try:
                fval = float(value)
            except (TypeError, ValueError):
                raise HTTPException(400, "limit_usd must be a number") from None
            if fval <= 0:
                raise HTTPException(400, "limit_usd must be > 0")
            sets.append("limit_usd = ?")
            params.append(fval)
        elif key == "period":
            if value not in _VALID_PERIOD:
                raise HTTPException(
                    400, f"period must be one of {sorted(_VALID_PERIOD)}"
                )
            sets.append("period = ?")
            params.append(value)
        elif key in {"hard_stop", "enabled"}:
            sets.append(f"{key} = ?")
            params.append(1 if bool(value) else 0)
        else:  # name
            sval = str(value).strip()
            if not sval:
                raise HTTPException(400, "name must be non-empty")
            sets.append("name = ?")
            params.append(sval)
    if sets:
        sets.append("updated_at = CURRENT_TIMESTAMP")
        params.append(budget_id)
        await db.execute(f"UPDATE budgets SET {', '.join(sets)} WHERE id = ?", params)
        await db.commit()
    return await get_budget(db, budget_id)


async def delete_budget(db: aiosqlite.Connection, budget_id: int) -> None:
    await get_budget(db, budget_id)
    await db.execute("DELETE FROM budgets WHERE id = ?", (budget_id,))
    await db.commit()


# ─── Spend / burn computation ─────────────────────────────────────────────────


async def _spend_for(
    db: aiosqlite.Connection,
    scope_type: str,
    scope_id: int | None,
    scope_key: str | None,
    start_iso: str,
    end_iso: str,
) -> float:
    """Sum cost matching the scope within [start, end), bucketed by session start.

    Project scope reads the per-file attribution ledger (``session_project_costs``,
    migration 062) rather than ``agent_sessions.project_id`` so a workspace-root
    session's cost counts toward the projects it actually touched — not just its
    coarse session bucket. Workspace/agent scopes use the canonical session
    total. All three bucket a session's cost by its ``started_at``.
    """
    if scope_type == "project":
        sql = (
            "SELECT COALESCE(SUM(spc.cost_usd), 0) AS total "
            "FROM session_project_costs spc "
            "JOIN agent_sessions s ON s.session_id = spc.session_id "
            "WHERE spc.project_id = ? AND s.started_at >= ? AND s.started_at < ?"
        )
        params: list[Any] = [scope_id, start_iso, end_iso]
    else:
        where = ["s.started_at >= ?", "s.started_at < ?"]
        params = [start_iso, end_iso]
        if scope_type == "agent":
            where.append("s.profile = ?")
            params.append(scope_key)
        sql = (
            "SELECT COALESCE(SUM(s.cost_usd), 0) AS total "
            f"FROM agent_sessions s WHERE {' AND '.join(where)}"
        )
    async with db.execute(sql, params) as cur:
        row = await cur.fetchone()
    return float(row["total"] if row else 0.0)


async def burn_for_budget(
    db: aiosqlite.Connection, budget: dict[str, Any], now: datetime | None = None
) -> dict[str, Any]:
    """Compute current-period burn for one budget."""
    start_iso, end_iso = period_bounds(budget["period"], now=now)
    spent = await _spend_for(
        db,
        budget["scope_type"],
        budget["scope_id"],
        budget["scope_key"],
        start_iso,
        end_iso,
    )
    limit = float(budget["limit_usd"])
    percent = (spent / limit * 100.0) if limit > 0 else 0.0
    return {
        "budget_id": budget["id"],
        "period_start": start_iso,
        "period_end": end_iso,
        "spent_usd": round(spent, 4),
        "limit_usd": limit,
        "percent": round(percent, 2),
    }


async def burn_summary(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    """Burn snapshot for every enabled budget."""
    budgets = [b for b in await list_budgets(db) if b["enabled"]]
    out: list[dict[str, Any]] = []
    for b in budgets:
        burn = await burn_for_budget(db, b)
        out.append({**b, **burn})
    return out


# ─── Alert evaluator (called from agent_service.record_stop) ──────────────────


async def evaluate_alerts(
    db: aiosqlite.Connection,
    project_id: int | None = None,
    profile: str | None = None,
) -> int:
    """Emit threshold notifications for budgets relevant to a write.

    Filters enabled budgets in SQL to the ones whose scope can be affected
    by an event for ``(project_id, profile)``. Pass both as ``None`` to
    evaluate every enabled budget — useful for tests and for batch jobs;
    the hot path (a single stop hook) should always pass the session's
    project/profile so we don't re-aggregate unrelated scopes.
    """
    if project_id is None and profile is None:
        async with db.execute("SELECT * FROM budgets WHERE enabled = 1") as cur:
            rows = await cur.fetchall()
    else:
        async with db.execute(
            "SELECT * FROM budgets WHERE enabled = 1 "
            "  AND ("
            "        scope_type = 'workspace'"
            "    OR (scope_type = 'project' AND scope_id = ?)"
            "    OR (scope_type = 'agent' AND scope_key = ?)"
            "  )",
            (project_id, profile),
        ) as cur:
            rows = await cur.fetchall()

    fired = 0
    for row in rows:
        budget = _row_to_dict(row)
        burn = await burn_for_budget(db, budget)
        percent = burn["percent"]
        crossed = [t for t in _THRESHOLDS if percent >= t]
        if not crossed:
            continue
        period_start = burn["period_start"]
        # INSERT OR IGNORE on the composite-PK ledger is the atomic dedup:
        # only the writer that wins the PK race fires the notification. Two
        # concurrent stop-hooks can each call evaluate_alerts and neither
        # will double-emit, nor will an IntegrityError abort the loop.
        for threshold in crossed:
            cur = await db.execute(
                "INSERT OR IGNORE INTO budget_threshold_alerts "
                "(budget_id, period_start, threshold) VALUES (?, ?, ?)",
                (budget["id"], period_start, threshold),
            )
            await db.commit()
            if cur.rowcount != 1:
                continue
            await notification_service.emit(
                db,
                type="budget_threshold",
                title=f"Budget '{budget['name']}' at {threshold}%",
                body=(
                    f"${burn['spent_usd']:.2f} of ${burn['limit_usd']:.2f} "
                    f"spent this {budget['period']} period."
                ),
                payload={
                    "budget_id": budget["id"],
                    "threshold": threshold,
                    "spent_usd": burn["spent_usd"],
                    "limit_usd": burn["limit_usd"],
                    "period": budget["period"],
                    "period_start": period_start,
                },
                priority="high" if threshold == 100 else "normal",
            )
            fired += 1
    return fired


# ─── Hard-stop evaluator (called from hook_session_start) ─────────────────────


async def check_hard_stop(
    db: aiosqlite.Connection,
    project_id: int | None,
    profile: str | None,
) -> tuple[bool, str | None]:
    """Return ``(allow, reason)`` for a candidate session start.

    Returns the *first* enabled hard-stop budget at or above 100% whose
    scope matches the candidate. Filters in SQL so a session-start hook
    never aggregates over budgets that obviously can't apply.
    """
    async with db.execute(
        "SELECT * FROM budgets "
        "WHERE enabled = 1 AND hard_stop = 1 "
        "  AND ("
        "        scope_type = 'workspace'"
        "    OR (scope_type = 'project' AND scope_id = ?)"
        "    OR (scope_type = 'agent' AND scope_key = ?)"
        "  )",
        (project_id, profile),
    ) as cur:
        rows = await cur.fetchall()
    for row in rows:
        budget = _row_to_dict(row)
        burn = await burn_for_budget(db, budget)
        if burn["percent"] >= 100.0:
            return (
                False,
                (
                    f"Budget '{budget['name']}' exceeded "
                    f"(${burn['spent_usd']:.2f} / ${burn['limit_usd']:.2f} "
                    f"this {budget['period']} period)."
                ),
            )
    return (True, None)
