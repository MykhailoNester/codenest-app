from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from ..database import get_db
from ..services import usage_limits_service

router = APIRouter(prefix="/api/v1/usage")


@router.get("/consumption")
async def api_consumption(
    window: str = usage_limits_service.DEFAULT_WINDOW,
) -> JSONResponse:
    if window not in usage_limits_service.WINDOWS:
        raise HTTPException(
            422, f"window must be one of {sorted(usage_limits_service.WINDOWS)}"
        )
    db = await get_db()
    return JSONResponse(await usage_limits_service.consumption(db, window))
