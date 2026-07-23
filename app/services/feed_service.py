"""Activity Feed & Audit Log.

Produces a unified, append-only chronological feed by UNION-ing
``activity_log`` (task/inbox/document/member events) with
``agent_sessions`` (one row per agent run). All rows share a common
normalized shape so the frontend treats them uniformly.

Filters compose in a wrapper SELECT around the UNION so we don't
duplicate WHERE clauses across both sub-queries (and so cursor
pagination is stable across mixed sources).
"""

from __future__ import annotations

import csv
import io
from typing import Any, AsyncIterator, Iterable, Literal

import aiosqlite
from fastapi import HTTPException

from ._sql import escape_like

Source = Literal["activity", "agent_session"]

_VALID_SOURCES: frozenset[str] = frozenset({"activity", "agent_session"})

# Hard cap on a single CSV export so a misclick can't pull the full
# table into memory or stall the sidecar.
CSV_ROW_CAP = 50_000

# JSON list default + cap.
DEFAULT_LIMIT = 100
MAX_LIMIT = 500

# Canonical column order for both JSON dicts and CSV exports.
COLUMNS: tuple[str, ...] = (
    "id",
    "source",
    "entity_type",
    "entity_id",
    "action",
    "actor",
    "project_id",
    "summary",
    "created_at",
)


# ─── Query construction ──────────────────────────────────────────────────────


_BASE_UNION_SQL: str = (
    # Each ``agent_sessions`` row contributes a ``started`` event at
    # ``started_at`` and, if ``ended_at`` is set, an additional ``ended``
    # event at that time. This preserves the start signal for audit
    # purposes even after a session ends. IDs are namespaced
    # (``a:<n>``, ``s:<session_id>:started`` / ``:ended``) so cursor
    # callers can identify the source without an extra round-trip and
    # same-timestamp rows never collide.
    "SELECT "
    "  'a:' || al.id            AS id, "
    "  'activity'               AS source, "
    "  al.entity_type           AS entity_type, "
    "  CAST(al.entity_id AS TEXT) AS entity_id, "
    "  al.action                AS action, "
    "  al.actor                 AS actor, "
    "  al.project_id            AS project_id, "
    "  COALESCE(al.new_value, al.old_value, '') AS summary, "
    "  al.created_at            AS created_at "
    "FROM activity_log al "
    "UNION ALL "
    "SELECT "
    "  's:' || s.session_id || ':started' AS id, "
    "  'agent_session'          AS source, "
    "  'agent_session'          AS entity_type, "
    "  s.session_id             AS entity_id, "
    "  'started'                AS action, "
    "  s.profile                AS actor, "
    "  s.project_id             AS project_id, "
    "  COALESCE(s.initial_prompt, '') AS summary, "
    "  s.started_at             AS created_at "
    "FROM agent_sessions s "
    "UNION ALL "
    "SELECT "
    "  's:' || s.session_id || ':ended' AS id, "
    "  'agent_session'          AS source, "
    "  'agent_session'          AS entity_type, "
    "  s.session_id             AS entity_id, "
    "  'ended'                  AS action, "
    "  s.profile                AS actor, "
    "  s.project_id             AS project_id, "
    "  COALESCE(s.status, '')   AS summary, "
    "  s.ended_at               AS created_at "
    "FROM agent_sessions s "
    "WHERE s.ended_at IS NOT NULL"
)


def _apply_filters(
    where: list[str],
    params: list[Any],
    *,
    source: str | None,
    actor: str | None,
    project_id: int | None,
    from_iso: str | None,
    to_iso: str | None,
    q: str | None,
) -> None:
    if source is not None:
        if source not in _VALID_SOURCES:
            raise HTTPException(400, f"source must be one of {sorted(_VALID_SOURCES)}")
        where.append("source = ?")
        params.append(source)
    if actor:
        where.append("actor = ?")
        params.append(actor)
    if project_id is not None:
        where.append("project_id = ?")
        params.append(project_id)
    if from_iso:
        where.append("created_at >= ?")
        params.append(from_iso)
    if to_iso:
        where.append("created_at < ?")
        params.append(to_iso)
    if q:
        where.append(
            "(summary LIKE ? ESCAPE '\\' "
            "OR action LIKE ? ESCAPE '\\' "
            "OR entity_type LIKE ? ESCAPE '\\')"
        )
        like = f"%{escape_like(q)}%"
        params.extend([like, like, like])


# ─── JSON list with cursor pagination ────────────────────────────────────────


async def list_feed(
    db: aiosqlite.Connection,
    *,
    source: str | None = None,
    actor: str | None = None,
    project_id: int | None = None,
    from_iso: str | None = None,
    to_iso: str | None = None,
    q: str | None = None,
    before_created_at: str | None = None,
    before_id: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> dict[str, Any]:
    """Return ``{items: [...], next_cursor: {…} | None}``.

    The cursor pairs ``created_at`` with ``id`` so two rows sharing the
    same timestamp don't get skipped or duplicated across pages.
    """
    capped = max(1, min(int(limit), MAX_LIMIT))

    where: list[str] = []
    params: list[Any] = []
    _apply_filters(
        where,
        params,
        source=source,
        actor=actor,
        project_id=project_id,
        from_iso=from_iso,
        to_iso=to_iso,
        q=q,
    )
    if before_created_at is not None:
        if before_id is not None:
            where.append("(created_at < ? OR (created_at = ? AND id < ?))")
            params.extend([before_created_at, before_created_at, before_id])
        else:
            where.append("created_at < ?")
            params.append(before_created_at)

    where_clause = f" WHERE {' AND '.join(where)}" if where else ""
    sql = (
        f"SELECT * FROM ({_BASE_UNION_SQL}){where_clause} "
        f"ORDER BY created_at DESC, id DESC LIMIT ?"
    )
    params.append(capped + 1)

    async with db.execute(sql, params) as cur:
        rows = list(await cur.fetchall())

    items = [dict(r) for r in rows[:capped]]
    next_cursor: dict[str, Any] | None = None
    if len(rows) > capped:
        last = items[-1]
        next_cursor = {"before_created_at": last["created_at"], "before_id": last["id"]}

    return {"items": items, "next_cursor": next_cursor}


# ─── CSV export (streaming) ──────────────────────────────────────────────────


async def stream_csv(
    db: aiosqlite.Connection,
    *,
    source: str | None = None,
    actor: str | None = None,
    project_id: int | None = None,
    from_iso: str | None = None,
    to_iso: str | None = None,
    q: str | None = None,
) -> AsyncIterator[str]:
    """Yield CSV text chunks for the filtered feed, hard-capped at CSV_ROW_CAP."""
    where: list[str] = []
    params: list[Any] = []
    _apply_filters(
        where,
        params,
        source=source,
        actor=actor,
        project_id=project_id,
        from_iso=from_iso,
        to_iso=to_iso,
        q=q,
    )
    where_clause = f" WHERE {' AND '.join(where)}" if where else ""
    sql = (
        f"SELECT * FROM ({_BASE_UNION_SQL}){where_clause} "
        f"ORDER BY created_at DESC, id DESC LIMIT ?"
    )
    params.append(CSV_ROW_CAP)

    # Header
    yield _csv_line(COLUMNS)

    async with db.execute(sql, params) as cur:
        async for row in cur:
            yield _csv_line([row[col] for col in COLUMNS])


def _csv_line(values: Iterable[Any]) -> str:
    """Render a single CSV line using csv.writer to handle quoting/escaping."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(["" if v is None else str(v) for v in values])
    return buf.getvalue()
