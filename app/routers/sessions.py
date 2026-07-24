"""Sessions router — Phase 7 telemetry API.

Exposes REST endpoints for LLM session telemetry (tokens, cost, model)
and session replay. Complements app/routers/agents.py which handles
hook ingestion and live streaming.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.database import get_db
from app.services import session_service

router = APIRouter()


@router.get("/api/v1/sessions")
async def list_sessions(
    profile: str = "",
    status: str = "",
    limit: int = 100,
):
    db = await get_db()
    from app.services.agent_service import list_sessions as _list

    rows = await _list(db, profile or None, status or None, limit)
    return [dict(r) for r in rows]


@router.get("/api/v1/sessions/{session_id}")
async def get_session(session_id: str):
    db = await get_db()
    replay = await session_service.get_session_replay(db, session_id)
    if not replay:
        raise HTTPException(status_code=404, detail="Session not found")
    return replay


@router.get("/api/v1/sessions/{session_id}/cost")
async def get_session_cost(session_id: str):
    db = await get_db()
    return await session_service.get_session_cost(db, session_id)


@router.get("/api/v1/sessions/stats/daily")
async def get_daily_spend():
    db = await get_db()
    return await session_service.get_daily_spend(db)
