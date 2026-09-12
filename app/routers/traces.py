"""Read side of the OTLP trace receiver (#178) — the latency surface's data."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import otlp_trace_receiver_service

router = APIRouter(prefix="/api/v1/traces")


@router.get("/operations")
async def api_operation_stats(limit: int = 500) -> JSONResponse:
    db = await get_db()
    limit = max(1, min(limit, 2000))
    return JSONResponse(await otlp_trace_receiver_service.operation_stats(db, limit))
