"""Dashboard trends router.

Exposes GET /api/v1/dashboard/trends?days=7

Returns per-day arrays for the last N days (default 7, max 30):
  - tasks_done: tasks completed each day
  - cost_usd:   agent spend from agent_sessions
  - agent_runs: dashboard-launched agent runs from agent_runs

All series are zero-filled so the frontend always receives exactly `days`
data points in ascending date order.  Read-only: no commits needed.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app.database import get_db

router = APIRouter()


def _date_series(days: int) -> list[str]:
    """Return an ascending list of ISO date strings for the last *days* days."""
    today = date.today()
    return [(today - timedelta(days=days - 1 - i)).isoformat() for i in range(days)]


@router.get("/api/v1/dashboard/trends")
async def dashboard_trends(
    days: int = Query(default=7, ge=1, le=30),
) -> JSONResponse:
    db = await get_db()

    dates = _date_series(days)
    # Build zero-filled maps keyed by ISO date string.
    tasks_map: dict[str, int] = {d: 0 for d in dates}
    cost_map: dict[str, float] = {d: 0.0 for d in dates}
    runs_map: dict[str, int] = {d: 0 for d in dates}

    # ── tasks completed per day ───────────────────────────────────────────────
    tasks_rows = await db.execute(
        """
        SELECT date(completed_date, 'localtime') AS day, COUNT(*) AS cnt
        FROM tasks
        WHERE status = 'done'
          AND completed_date >= date('now', ? || ' days', 'localtime')
        GROUP BY day
        """,
        (-(days - 1),),
    )
    for row in await tasks_rows.fetchall():
        if row["day"] in tasks_map:
            tasks_map[row["day"]] = int(row["cnt"])

    # ── cost per day (agent_sessions) ─────────────────────────────────────────
    cost_rows = await db.execute(
        """
        SELECT date(started_at, 'localtime') AS day,
               COALESCE(SUM(cost_usd), 0) AS total
        FROM agent_sessions
        WHERE started_at >= datetime('now', ? || ' days', 'localtime')
        GROUP BY day
        """,
        (-(days - 1),),
    )
    for row in await cost_rows.fetchall():
        if row["day"] in cost_map:
            cost_map[row["day"]] = float(row["total"])

    # ── agent runs per day (agent_runs) ───────────────────────────────────────
    runs_rows = await db.execute(
        """
        SELECT date(started_at, 'localtime') AS day, COUNT(*) AS cnt
        FROM agent_runs
        WHERE started_at >= datetime('now', ? || ' days', 'localtime')
        GROUP BY day
        """,
        (-(days - 1),),
    )
    for row in await runs_rows.fetchall():
        if row["day"] in runs_map:
            runs_map[row["day"]] = int(row["cnt"])

    result: dict[str, Any] = {
        "dates": dates,
        "tasks_done": [tasks_map[d] for d in dates],
        "cost_usd": [cost_map[d] for d in dates],
        "agent_runs": [runs_map[d] for d in dates],
    }
    return JSONResponse(result)
