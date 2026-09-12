"""One session, assembled from every lane that observed it (#179)."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import aiosqlite

from . import lane_reconciler_service as lane_reconciler
from .otlp_trace_receiver_service import SPAN_CATEGORY

logger = logging.getLogger(__name__)

MONEY_FIELDS: tuple[str, ...] = (
    "cost_usd",
    "tokens_in",
    "tokens_out",
    "context_tokens",
    "model",
)

LANE_LABELS: dict[str, str] = {
    lane_reconciler.LANE_HOOK: "Hooks",
    lane_reconciler.LANE_OTLP: "OTLP telemetry",
    lane_reconciler.LANE_TRANSCRIPT: "Transcript scan",
}

_EVENT_LIMIT = 100


async def _rows(
    db: aiosqlite.Connection, sql: str, params: tuple[Any, ...]
) -> list[aiosqlite.Row]:
    try:
        async with db.execute(sql, params) as cur:
            return list(await cur.fetchall())
    except aiosqlite.Error:
        logger.warning("session inspector: query failed", exc_info=True)
        return []


def _parse(stamp: str | None) -> datetime | None:
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(stamp.replace("T", " ").replace("Z", ""))
    except ValueError:
        return None


def _seconds(start: str | None, end: str | None) -> float | None:
    a, b = _parse(start), _parse(end)
    if a is None or b is None:
        return None
    return max(0.0, (b - a).total_seconds())


def _field_state(value: Any, claimed: bool) -> str:
    if claimed:
        return "claimed"
    # A value with no claim behind it predates provenance, or came from a writer
    # the reconciler does not gate yet. It is not evidence of a lane.
    if value in (None, "", 0, 0.0):
        return "unobserved"
    return "untracked"


async def _fields(
    db: aiosqlite.Connection, session_id: str, session: dict[str, Any]
) -> list[dict[str, Any]]:
    try:
        winners = await lane_reconciler.read(db, session_id)
    except Exception:
        logger.warning("session inspector: provenance read failed", exc_info=True)
        winners = {}

    claims: dict[str, list[dict[str, Any]]] = {}
    for row in await _rows(
        db,
        "SELECT field, lane, value_text, claimed_at FROM session_field_provenance "
        "WHERE session_id = ? ORDER BY claimed_at ASC, lane ASC",
        (session_id,),
    ):
        claims.setdefault(row["field"], []).append(
            {
                "lane": row["lane"],
                "value_text": row["value_text"],
                "claimed_at": row["claimed_at"],
            }
        )

    out: list[dict[str, Any]] = []
    for field in lane_reconciler.FIELD_LANES:
        value = session.get(field)
        field_claims = claims.get(field, [])
        money = field in MONEY_FIELDS
        if not money and not field_claims and value in (None, "", 0, 0.0):
            continue
        out.append(
            {
                "field": field,
                "group": "money" if money else "other",
                "value": value,
                "state": _field_state(value, bool(field_claims)),
                "winning_lane": (winners.get(field) or {}).get("lane"),
                "lanes_allowed": list(lane_reconciler.FIELD_LANES[field]),
                "claims": field_claims,
            }
        )
    out.sort(key=lambda f: (f["group"] != "money", f["field"]))
    return out


async def _count(db: aiosqlite.Connection, sql: str, session_id: str) -> int:
    rows = await _rows(db, sql, (session_id,))
    return int(rows[0][0] or 0) if rows else 0


async def _lanes(
    db: aiosqlite.Connection, session_id: str, fields: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    events = await _count(
        db, "SELECT COUNT(*) FROM agent_events WHERE session_id = ?", session_id
    )
    spans = await _count(
        db,
        "SELECT COALESCE(SUM(count), 0) FROM otlp_span_stats WHERE session_id = ?",
        session_id,
    )
    series = await _count(
        db, "SELECT COUNT(*) FROM otlp_metric_series WHERE session_id = ?", session_id
    )
    parsed = await _count(
        db,
        "SELECT COALESCE(SUM(rows_parsed), 0) FROM transcript_scan_state WHERE session_id = ?",
        session_id,
    )

    won: dict[str, int] = {}
    for field in fields:
        lane = field["winning_lane"]
        if lane:
            won[lane] = won.get(lane, 0) + 1

    evidence = {
        lane_reconciler.LANE_HOOK: (
            events > 0,
            f"{events} hook events" if events else "no hook events recorded",
        ),
        lane_reconciler.LANE_OTLP: (
            spans > 0 or series > 0,
            f"{spans} spans, {series} metric series"
            if (spans or series)
            else "nothing exported — telemetry is opt-in and off for this session",
        ),
        lane_reconciler.LANE_TRANSCRIPT: (
            parsed > 0,
            f"{parsed} transcript rows parsed"
            if parsed
            else "transcript not scanned (file gone, or scan not run)",
        ),
    }
    return [
        {
            "lane": lane,
            "label": LANE_LABELS[lane],
            "observed": observed,
            "evidence": text,
            "fields_won": won.get(lane, 0),
        }
        for lane, (observed, text) in evidence.items()
    ]


async def inspect(db: aiosqlite.Connection, session_id: str) -> dict[str, Any] | None:
    session_rows = await _rows(
        db,
        "SELECT s.*, p.name AS project_name FROM agent_sessions s "
        "LEFT JOIN projects p ON p.id = s.project_id WHERE s.session_id = ?",
        (session_id,),
    )
    if not session_rows:
        return None
    session = dict(session_rows[0])

    fields = await _fields(db, session_id, session)

    spans = [
        {
            "seq": row["seq"],
            "project_id": row["project_id"],
            "project_name": row["project_name"],
            "cwd": row["cwd"],
            "repo_path": row["repo_path"],
            "started_at": row["started_at"],
            "ended_at": row["ended_at"],
            "last_seen_at": row["last_seen_at"],
            "seconds": _seconds(
                row["started_at"], row["ended_at"] or row["last_seen_at"]
            ),
            "open": row["ended_at"] is None,
        }
        for row in await _rows(
            db,
            "SELECT sp.*, p.name AS project_name FROM session_project_spans sp "
            "LEFT JOIN projects p ON p.id = sp.project_id "
            "WHERE sp.session_id = ? ORDER BY sp.seq ASC",
            (session_id,),
        )
    ]

    attention = [
        {
            "id": row["id"],
            "kind": row["kind"],
            "severity": row["severity"],
            "state": row["state"],
            "title": row["title"],
            "detail": row["detail"],
            "first_seen_at": row["first_seen_at"],
            "last_seen_at": row["last_seen_at"],
            "resolved_at": row["resolved_at"],
            "resolution": row["resolution"],
        }
        for row in await _rows(
            db,
            "SELECT * FROM attention_items WHERE session_id = ? "
            "ORDER BY state = 'open' DESC, last_seen_at DESC LIMIT 50",
            (session_id,),
        )
    ]

    operations = []
    for row in await _rows(
        db,
        "SELECT span_name, operation, count, error_count, total_duration_ms,"
        "       min_duration_ms, max_duration_ms, last_seen_at"
        "  FROM otlp_span_stats WHERE session_id = ? ORDER BY count DESC LIMIT 200",
        (session_id,),
    ):
        count = int(row["count"] or 0)
        total = float(row["total_duration_ms"] or 0.0)
        operations.append(
            {
                "span_name": row["span_name"],
                "category": SPAN_CATEGORY.get(row["span_name"], "other"),
                "operation": row["operation"] or "",
                "count": count,
                "error_count": int(row["error_count"] or 0),
                "total_duration_ms": total,
                "avg_duration_ms": (total / count) if count else 0.0,
                "min_duration_ms": float(row["min_duration_ms"] or 0.0),
                "max_duration_ms": float(row["max_duration_ms"] or 0.0),
                "last_seen_at": row["last_seen_at"],
            }
        )

    events = [
        {
            "id": row["id"],
            "event_type": row["event_type"],
            "tool_name": row["tool_name"],
            "summary": row["summary"],
            "created_at": row["created_at"],
        }
        for row in await _rows(
            db,
            "SELECT id, event_type, tool_name, summary, created_at FROM agent_events "
            "WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, _EVENT_LIMIT),
        )
    ]
    event_counts = [
        {"event_type": row["event_type"], "count": int(row["cnt"])}
        for row in await _rows(
            db,
            "SELECT event_type, COUNT(*) AS cnt FROM agent_events WHERE session_id = ? "
            "GROUP BY event_type ORDER BY cnt DESC",
            (session_id,),
        )
    ]

    return {
        "session": session,
        "lanes": await _lanes(db, session_id, fields),
        "fields": fields,
        "spans": spans,
        "attention": attention,
        "operations": operations,
        "events": events,
        "event_counts": event_counts,
        "events_truncated": len(events) == _EVENT_LIMIT,
    }
