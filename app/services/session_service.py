"""Session telemetry service — Phase 7.

Wraps agent_sessions / agent_events with token/cost tracking functions.
The underlying tables were created in migrations 004 and 007.
"""

from __future__ import annotations

import aiosqlite


async def get_session_replay(
    db: aiosqlite.Connection,
    session_id: str,
    limit: int = 300,
) -> dict:
    row = await db.execute(
        "SELECT s.*, p.name as project_name "
        "FROM agent_sessions s LEFT JOIN projects p ON s.project_id = p.id "
        "WHERE s.session_id = ?",
        (session_id,),
    )
    session = await row.fetchone()
    if not session:
        return {}
    events_row = await db.execute(
        "SELECT * FROM agent_events WHERE session_id = ? ORDER BY id ASC LIMIT ?",
        (session_id, limit),
    )
    events = await events_row.fetchall()
    return {
        "session": dict(session),
        "events": [dict(e) for e in events],
    }


# ─── Aggregates ─────────────────────────────────────────────────────────────


async def get_daily_spend(db: aiosqlite.Connection) -> dict:
    """Return total tokens and cost for sessions started today (local time)."""
    row = await db.execute(
        "SELECT COALESCE(SUM(tokens_in),0) as ti, COALESCE(SUM(tokens_out),0) as to_, "
        "       COALESCE(SUM(cost_usd),0) as cost "
        "FROM agent_sessions "
        "WHERE date(started_at, 'localtime') = date('now', 'localtime')",
    )
    r = await row.fetchone()
    return {
        "tokens_in": r["ti"] if r else 0,
        "tokens_out": r["to_"] if r else 0,
        "cost_usd": r["cost"] if r else 0.0,
    }


async def get_session_cost(db: aiosqlite.Connection, session_id: str) -> dict:
    row = await db.execute(
        "SELECT tokens_in, tokens_out, cost_usd, model FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    )
    r = await row.fetchone()
    if not r:
        return {"tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0, "model": None}
    return dict(r)
