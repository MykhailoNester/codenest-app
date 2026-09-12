"""Consumption over a window, split by the lane that measured it (#182).

Never blended: Lane A's flat-rate estimate over the sessions no vendor figure
displaced, and Lane B's totals over the sessions telemetry covered. Absent is
`None` (not observed), never 0.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Final

import aiosqlite

from . import lane_reconciler_service, otlp_receiver_service

WINDOWS: Final[dict[str, timedelta]] = {
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}

DEFAULT_WINDOW: Final[str] = "7d"

# The three `agent_sessions` columns the estimate card shows. A session with a
# Lane B claim on any of them is no longer an estimate and leaves that card.
ESTIMATE_FIELDS: Final[tuple[str, ...]] = ("cost_usd", "tokens_in", "tokens_out")

_SUPERSEDED = (
    "EXISTS (SELECT 1 FROM session_field_provenance p"
    " WHERE p.session_id = s.session_id AND p.lane = ?"
    f" AND p.field IN ({', '.join('?' for _ in ESTIMATE_FIELDS)}))"
)

_LANE_B_ARGS: Final[tuple[str, ...]] = (
    lane_reconciler_service.LANE_OTLP,
    *ESTIMATE_FIELDS,
)


def window_since(window: str, now: datetime | None = None) -> str:
    span = WINDOWS.get(window)
    if span is None:
        raise ValueError(f"unknown window {window!r}")
    moment = now or datetime.now(UTC).replace(tzinfo=None)
    return (moment - span).isoformat(timespec="seconds")


async def _estimate(db: aiosqlite.Connection, since: str) -> dict[str, Any]:
    async with db.execute(
        "SELECT COUNT(*) AS sessions,"
        " COALESCE(SUM(s.cost_usd), 0) AS cost_usd,"
        " COALESCE(SUM(s.tokens_in), 0) AS tokens_in,"
        " COALESCE(SUM(s.tokens_out), 0) AS tokens_out"
        " FROM agent_sessions s"
        f" WHERE s.started_at >= ? AND NOT {_SUPERSEDED}",
        (since, *_LANE_B_ARGS),
    ) as cur:
        row = await cur.fetchone()

    sessions = int(row["sessions"]) if row else 0
    if row is None or sessions == 0:
        return {
            "lane": lane_reconciler_service.LANE_HOOK,
            "observed": False,
            "sessions": 0,
            "cost_usd": None,
            "tokens_in": None,
            "tokens_out": None,
        }
    return {
        "lane": lane_reconciler_service.LANE_HOOK,
        "observed": True,
        "sessions": sessions,
        "cost_usd": float(row["cost_usd"]),
        "tokens_in": int(row["tokens_in"]),
        "tokens_out": int(row["tokens_out"]),
    }


async def _vendor(db: aiosqlite.Connection, since: str) -> dict[str, Any]:
    async with db.execute(
        "SELECT m.metric_key AS metric_key, SUM(m.value) AS total"
        " FROM otlp_metric_series m"
        " JOIN agent_sessions s ON s.session_id = m.session_id"
        " WHERE s.started_at >= ? GROUP BY m.metric_key",
        (since,),
    ) as cur:
        rows = await cur.fetchall()

    async with db.execute(
        "SELECT COUNT(DISTINCT m.session_id) AS sessions"
        " FROM otlp_metric_series m"
        " JOIN agent_sessions s ON s.session_id = m.session_id"
        " WHERE s.started_at >= ?",
        (since,),
    ) as cur:
        count_row = await cur.fetchone()

    # Absent key -> None. Summing a metric nothing exported would report a real
    # zero for a measurement that was never taken.
    totals: dict[str, float | None] = dict.fromkeys(
        sorted(otlp_receiver_service.METRIC_KEYS), None
    )
    for row in rows:
        if row["metric_key"] in totals:
            totals[row["metric_key"]] = float(row["total"] or 0.0)

    sessions = int(count_row["sessions"] if count_row else 0)
    return {
        "lane": otlp_receiver_service.LANE,
        "observed": sessions > 0,
        "sessions": sessions,
        **totals,
    }


async def _session_counts(db: aiosqlite.Connection, since: str) -> tuple[int, int]:
    async with db.execute(
        "SELECT COUNT(*) AS total,"
        f" COALESCE(SUM(CASE WHEN {_SUPERSEDED} THEN 1 ELSE 0 END), 0) AS superseded"
        " FROM agent_sessions s WHERE s.started_at >= ?",
        (*_LANE_B_ARGS, since),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return 0, 0
    return int(row["total"]), int(row["superseded"])


async def consumption(
    db: aiosqlite.Connection,
    window: str = DEFAULT_WINDOW,
    now: datetime | None = None,
) -> dict[str, Any]:
    since = window_since(window, now=now)
    estimate = await _estimate(db, since)
    vendor = await _vendor(db, since)
    total, superseded = await _session_counts(db, since)

    return {
        "window": window,
        "since": since,
        "sessions": {
            "total": total,
            "vendor_observed": vendor["sessions"],
            "not_observed": total - vendor["sessions"],
            "superseded": superseded,
        },
        "estimate": estimate,
        "vendor": vendor,
    }
