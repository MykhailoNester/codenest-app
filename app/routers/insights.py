"""Insights / Proactive Suggestions router."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import insights_service

router = APIRouter(prefix="/api/v1/insights")


@router.post("/run")
async def api_run_insights() -> JSONResponse:
    """Manually fire the insight rules. Idempotent within a UTC day."""
    db = await get_db()
    published = await insights_service.generate_and_publish(db)
    return JSONResponse({"published": published, "count": len(published)})


@router.get("/runs")
async def api_list_runs(limit: int = 50) -> JSONResponse:
    db = await get_db()
    return JSONResponse({"runs": await insights_service.list_runs(db, limit)})
