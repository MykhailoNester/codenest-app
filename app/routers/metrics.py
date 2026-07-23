from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from ..database import get_db
from ..services import metrics_service

router = APIRouter()

_VALID_GROUP_BY = frozenset({"project", "agent", "profile", "day"})
_VALID_RANGES = frozenset({"7d", "30d", "90d"})


@router.get("/api/v1/metrics/cost")
async def cost_metrics(
    group_by: str = "project",
    range: str = "30d",
    project_id: int | None = None,
    agent: str | None = None,
    profile_id: int | None = None,
    include_daily: bool = False,
) -> JSONResponse:
    if group_by not in _VALID_GROUP_BY:
        raise HTTPException(422, f"group_by must be one of {sorted(_VALID_GROUP_BY)}")
    if range not in _VALID_RANGES:
        raise HTTPException(422, f"range must be one of {sorted(_VALID_RANGES)}")
    db = await get_db()
    result = await metrics_service.get_cost_metrics(
        db,
        group_by=group_by,  # type: ignore[arg-type]
        range_=range,  # type: ignore[arg-type]
        project_id=project_id,
        agent=agent,
        profile_id=profile_id,
        include_daily=include_daily,
    )
    return JSONResponse(result)


@router.get("/api/v1/metrics/activity")
async def activity_metrics(
    group_by: str = "project",
    range: str = "30d",
    project_id: int | None = None,
    agent: str | None = None,
    profile_id: int | None = None,
) -> JSONResponse:
    if group_by not in _VALID_GROUP_BY:
        raise HTTPException(422, f"group_by must be one of {sorted(_VALID_GROUP_BY)}")
    if range not in _VALID_RANGES:
        raise HTTPException(422, f"range must be one of {sorted(_VALID_RANGES)}")
    db = await get_db()
    result = await metrics_service.get_activity_metrics(
        db,
        group_by=group_by,  # type: ignore[arg-type]
        range_=range,  # type: ignore[arg-type]
        project_id=project_id,
        agent=agent,
        profile_id=profile_id,
    )
    return JSONResponse(result)
