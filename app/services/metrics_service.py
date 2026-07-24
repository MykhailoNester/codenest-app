"""Cost and activity aggregation metrics service.

Aggregates agent_sessions rows by project, agent, profile, or day within a
rolling time range. Results are cached per unique query key for 60 seconds.

NOTE (include_daily=True, N+1): when group_by != 'day', the service runs one
extra SQL query per group bucket to fetch the daily series. At current scale
(< 20 projects) the overhead is negligible; a future optimisation can replace
this with a single GROUP BY (project_id, date) query.
"""

from __future__ import annotations

import time
from typing import Any, Literal

import aiosqlite

# ─── Cache ───────────────────────────────────────────────────────────────────

_cache: dict[str, tuple[float, Any]] = {}
_TTL = 60.0


def _cache_key(group_by: str, range_: str, **filters: object) -> str:
    return f"{group_by}:{range_}:{sorted(filters.items())}"


def _cache_get(key: str) -> Any | None:
    entry = _cache.get(key)
    if entry and (time.monotonic() - entry[0]) < _TTL:
        return entry[1]
    return None


def _cache_set(key: str, value: Any) -> None:
    _cache[key] = (time.monotonic(), value)


# ─── Range helpers ────────────────────────────────────────────────────────────

_RANGE_MAP: dict[str, str] = {
    "7d": "-7 days",
    "30d": "-30 days",
    "90d": "-90 days",
}


async def _resolve_profile_name(
    db: aiosqlite.Connection, profile_id: int
) -> str | None:
    """Return the profile name for a given profile_id, or None if unresolvable.

    Falls back gracefully when the profiles table is unavailable.
    """
    try:
        row = await db.execute("SELECT name FROM profiles WHERE id = ?", (profile_id,))
        result = await row.fetchone()
        return result["name"] if result else None
    except Exception:  # noqa: BLE001
        # profiles table not available; filter is ignored
        return None


# ─── Cost metrics ─────────────────────────────────────────────────────────────


async def get_cost_metrics(
    db: aiosqlite.Connection,
    group_by: Literal["project", "agent", "profile", "day"],
    range_: Literal["7d", "30d", "90d"],
    project_id: int | None = None,
    agent: str | None = None,
    profile_id: int | None = None,
    include_daily: bool = False,
) -> dict[str, Any]:
    """Return cost aggregations grouped by the given dimension.

    Returns a dict with:
    - groups: list of CostBucket dicts
    - grand_total: {total_cost_usd, total_tokens_in, total_tokens_out, run_count}
    """
    key = _cache_key(
        group_by,
        range_,
        project_id=project_id,
        agent=agent,
        profile_id=profile_id,
        include_daily=include_daily,
    )
    cached = _cache_get(key)
    if cached is not None:
        return cached  # type: ignore[return-value]

    interval = _RANGE_MAP[range_]

    # Build optional filter conditions
    extra_conditions: list[str] = []
    extra_params: list[Any] = []
    if project_id is not None:
        extra_conditions.append("s.project_id = ?")
        extra_params.append(project_id)
    if agent is not None:
        extra_conditions.append("s.profile = ?")
        extra_params.append(agent)
    if profile_id is not None:
        # resolve profile_id → name via profiles table
        profile_name = await _resolve_profile_name(db, profile_id)
        if profile_name is not None:
            extra_conditions.append("s.profile = ?")
            extra_params.append(profile_name)

    extra_where = (" AND " + " AND ".join(extra_conditions)) if extra_conditions else ""

    if group_by == "project":
        sql = f"""
            SELECT
                CAST(COALESCE(p.id, -1) AS TEXT) AS key,
                COALESCE(p.name, 'Unassigned') AS label,
                COALESCE(SUM(s.cost_usd), 0) AS total_cost_usd,
                COALESCE(SUM(s.tokens_in), 0) AS total_tokens_in,
                COALESCE(SUM(s.tokens_out), 0) AS total_tokens_out,
                COUNT(*) AS run_count
            FROM agent_sessions s
            LEFT JOIN projects p ON s.project_id = p.id
            WHERE s.started_at >= datetime('now', ?, 'localtime'){extra_where}
            GROUP BY p.id
            ORDER BY total_cost_usd DESC
        """
        params: list[Any] = [interval, *extra_params]

    elif group_by == "profile":
        # try to join profiles table for richer labels;
        # fall back to raw profile string if the table does not exist yet.
        try:
            sql = f"""
                SELECT
                    COALESCE(pr.name, s.profile) AS key,
                    COALESCE(pr.name, s.profile) AS label,
                    COALESCE(SUM(s.cost_usd), 0) AS total_cost_usd,
                    COALESCE(SUM(s.tokens_in), 0) AS total_tokens_in,
                    COALESCE(SUM(s.tokens_out), 0) AS total_tokens_out,
                    COUNT(*) AS run_count
                FROM agent_sessions s
                LEFT JOIN profiles pr ON s.profile = pr.name
                WHERE s.started_at >= datetime('now', ?, 'localtime'){extra_where}
                GROUP BY COALESCE(pr.name, s.profile)
                ORDER BY total_cost_usd DESC
            """
            params = [interval, *extra_params]
            rows_cursor = await db.execute(sql, params)
        except Exception:  # noqa: BLE001
            # profiles table not available: fall back to
            # grouping by raw profile string, identical to group_by=agent.
            sql = f"""
                SELECT
                    s.profile AS key,
                    s.profile AS label,
                    COALESCE(SUM(s.cost_usd), 0) AS total_cost_usd,
                    COALESCE(SUM(s.tokens_in), 0) AS total_tokens_in,
                    COALESCE(SUM(s.tokens_out), 0) AS total_tokens_out,
                    COUNT(*) AS run_count
                FROM agent_sessions s
                WHERE s.started_at >= datetime('now', ?, 'localtime'){extra_where}
                GROUP BY s.profile
                ORDER BY total_cost_usd DESC
            """
            params = [interval, *extra_params]
            rows_cursor = await db.execute(sql, params)
        rows = await rows_cursor.fetchall()

        groups = []
        for row in rows:
            bucket: dict[str, Any] = {
                "key": row["key"],
                "label": row["label"],
                "total_cost_usd": row["total_cost_usd"],
                "total_tokens_in": row["total_tokens_in"],
                "total_tokens_out": row["total_tokens_out"],
                "run_count": row["run_count"],
            }
            if include_daily:
                bucket["daily"] = await _fetch_daily_cost(
                    db, interval, group_by, row["key"], extra_conditions, extra_params
                )
            groups.append(bucket)

        grand_total = {
            "total_cost_usd": sum(g["total_cost_usd"] for g in groups),
            "total_tokens_in": sum(g["total_tokens_in"] for g in groups),
            "total_tokens_out": sum(g["total_tokens_out"] for g in groups),
            "run_count": sum(g["run_count"] for g in groups),
        }
        result: dict[str, Any] = {"groups": groups, "grand_total": grand_total}
        _cache_set(key, result)
        return result

    elif group_by == "agent":
        sql = f"""
            SELECT
                s.profile AS key,
                s.profile AS label,
                COALESCE(SUM(s.cost_usd), 0) AS total_cost_usd,
                COALESCE(SUM(s.tokens_in), 0) AS total_tokens_in,
                COALESCE(SUM(s.tokens_out), 0) AS total_tokens_out,
                COUNT(*) AS run_count
            FROM agent_sessions s
            WHERE s.started_at >= datetime('now', ?, 'localtime'){extra_where}
            GROUP BY s.profile
            ORDER BY total_cost_usd DESC
        """
        params = [interval, *extra_params]

    else:  # day
        sql = f"""
            SELECT
                date(s.started_at, 'localtime') AS key,
                date(s.started_at, 'localtime') AS label,
                COALESCE(SUM(s.cost_usd), 0) AS total_cost_usd,
                COALESCE(SUM(s.tokens_in), 0) AS total_tokens_in,
                COALESCE(SUM(s.tokens_out), 0) AS total_tokens_out,
                COUNT(*) AS run_count
            FROM agent_sessions s
            WHERE s.started_at >= datetime('now', ?, 'localtime'){extra_where}
            GROUP BY date(s.started_at, 'localtime')
            ORDER BY key ASC
        """
        params = [interval, *extra_params]

    rows_cursor = await db.execute(sql, params)
    rows = await rows_cursor.fetchall()

    groups = []
    for row in rows:
        bucket = {
            "key": row["key"],
            "label": row["label"],
            "total_cost_usd": row["total_cost_usd"],
            "total_tokens_in": row["total_tokens_in"],
            "total_tokens_out": row["total_tokens_out"],
            "run_count": row["run_count"],
        }
        if include_daily and group_by != "day":
            bucket["daily"] = await _fetch_daily_cost(
                db, interval, group_by, row["key"], extra_conditions, extra_params
            )
        groups.append(bucket)

    grand_total = {
        "total_cost_usd": sum(g["total_cost_usd"] for g in groups),
        "total_tokens_in": sum(g["total_tokens_in"] for g in groups),
        "total_tokens_out": sum(g["total_tokens_out"] for g in groups),
        "run_count": sum(g["run_count"] for g in groups),
    }
    result = {"groups": groups, "grand_total": grand_total}
    _cache_set(key, result)
    return result


async def _fetch_daily_cost(
    db: aiosqlite.Connection,
    interval: str,
    group_by: str,
    group_key: str,
    extra_conditions: list[str],
    extra_params: list[Any],
) -> list[dict[str, Any]]:
    """Fetch daily cost series for one group bucket (used by include_daily=True)."""
    if group_by == "project":
        if group_key == "-1":
            group_condition = "s.project_id IS NULL"
            group_params: list[Any] = []
        else:
            group_condition = "s.project_id = ?"
            group_params = [int(group_key)]
    else:  # agent or profile
        group_condition = "s.profile = ?"
        group_params = [group_key]

    extra_where = (" AND " + " AND ".join(extra_conditions)) if extra_conditions else ""

    sql = f"""
        SELECT
            date(s.started_at, 'localtime') AS date,
            COALESCE(SUM(s.cost_usd), 0) AS cost_usd,
            COUNT(*) AS runs
        FROM agent_sessions s
        WHERE s.started_at >= datetime('now', ?, 'localtime')
          AND {group_condition}{extra_where}
        GROUP BY date(s.started_at, 'localtime')
        ORDER BY date ASC
    """
    rows_cursor = await db.execute(sql, [interval, *group_params, *extra_params])
    rows = await rows_cursor.fetchall()
    return [
        {"date": row["date"], "cost_usd": row["cost_usd"], "runs": row["runs"]}
        for row in rows
    ]


# ─── Activity metrics ─────────────────────────────────────────────────────────


async def get_activity_metrics(
    db: aiosqlite.Connection,
    group_by: Literal["project", "agent", "profile", "day"],
    range_: Literal["7d", "30d", "90d"],
    project_id: int | None = None,
    agent: str | None = None,
    profile_id: int | None = None,
) -> dict[str, Any]:
    """Return session-count aggregations grouped by the given dimension.

    Returns a dict with:
    - groups: list of ActivityBucket dicts
    - grand_total: {count}
    """
    key = _cache_key(
        f"activity:{group_by}",
        range_,
        project_id=project_id,
        agent=agent,
        profile_id=profile_id,
    )
    cached = _cache_get(key)
    if cached is not None:
        return cached  # type: ignore[return-value]

    interval = _RANGE_MAP[range_]

    extra_conditions: list[str] = []
    extra_params: list[Any] = []
    if project_id is not None:
        extra_conditions.append("s.project_id = ?")
        extra_params.append(project_id)
    if agent is not None:
        extra_conditions.append("s.profile = ?")
        extra_params.append(agent)
    if profile_id is not None:
        profile_name = await _resolve_profile_name(db, profile_id)
        if profile_name is not None:
            extra_conditions.append("s.profile = ?")
            extra_params.append(profile_name)

    extra_where = (" AND " + " AND ".join(extra_conditions)) if extra_conditions else ""

    if group_by == "project":
        sql = f"""
            SELECT
                CAST(COALESCE(p.id, -1) AS TEXT) AS key,
                COALESCE(p.name, 'Unassigned') AS label,
                COUNT(*) AS count
            FROM agent_sessions s
            LEFT JOIN projects p ON s.project_id = p.id
            WHERE s.started_at >= datetime('now', ?, 'localtime'){extra_where}
            GROUP BY p.id
            ORDER BY count DESC
        """
        params: list[Any] = [interval, *extra_params]

    elif group_by in ("agent", "profile"):
        # profile grouping is identical to agent grouping
        sql = f"""
            SELECT
                s.profile AS key,
                s.profile AS label,
                COUNT(*) AS count
            FROM agent_sessions s
            WHERE s.started_at >= datetime('now', ?, 'localtime'){extra_where}
            GROUP BY s.profile
            ORDER BY count DESC
        """
        params = [interval, *extra_params]

    else:  # day
        sql = f"""
            SELECT
                date(s.started_at, 'localtime') AS key,
                date(s.started_at, 'localtime') AS label,
                COUNT(*) AS count
            FROM agent_sessions s
            WHERE s.started_at >= datetime('now', ?, 'localtime'){extra_where}
            GROUP BY date(s.started_at, 'localtime')
            ORDER BY key ASC
        """
        params = [interval, *extra_params]

    rows_cursor = await db.execute(sql, params)
    rows = await rows_cursor.fetchall()

    groups = [
        {"key": row["key"], "label": row["label"], "count": row["count"]}
        for row in rows
    ]
    grand_total = {"count": sum(g["count"] for g in groups)}

    result: dict[str, Any] = {"groups": groups, "grand_total": grand_total}
    _cache_set(key, result)
    return result
