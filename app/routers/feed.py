"""Activity Feed & Audit Log router."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from app.database import get_db
from app.services import feed_service

router = APIRouter(prefix="/api/v1/feed")


@router.get("")
async def api_feed(
    source: str | None = None,
    actor: str | None = None,
    project_id: int | None = None,
    from_iso: str | None = None,
    to_iso: str | None = None,
    q: str | None = None,
    before_created_at: str | None = None,
    before_id: str | None = None,
    limit: int = feed_service.DEFAULT_LIMIT,
) -> JSONResponse:
    db = await get_db()
    result = await feed_service.list_feed(
        db,
        source=source,
        actor=actor,
        project_id=project_id,
        from_iso=from_iso,
        to_iso=to_iso,
        q=q,
        before_created_at=before_created_at,
        before_id=before_id,
        limit=limit,
    )
    return JSONResponse(result)


@router.get(".csv")
async def api_feed_csv(
    source: str | None = None,
    actor: str | None = None,
    project_id: int | None = None,
    from_iso: str | None = None,
    to_iso: str | None = None,
    q: str | None = None,
) -> StreamingResponse:
    db = await get_db()
    iterator = feed_service.stream_csv(
        db,
        source=source,
        actor=actor,
        project_id=project_id,
        from_iso=from_iso,
        to_iso=to_iso,
        q=q,
    )
    return StreamingResponse(
        iterator,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="activity-feed.csv"'},
    )
