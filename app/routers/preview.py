"""Browser/preview router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import preview_service

from ._http import read_json_body

# Visit payloads are tiny (url + title); cap the body for safety.
_MAX_BODY = 16 * 1024


router = APIRouter(prefix="/api/v1/preview")


@router.get("/detect")
async def api_detect_dev_server() -> JSONResponse:
    return JSONResponse(await preview_service.detect_dev_server())


@router.get("/visits")
async def api_list_visits(limit: int = 50) -> JSONResponse:
    db = await get_db()
    return JSONResponse({"visits": await preview_service.list_visits(db, limit)})


@router.post("/visits")
async def api_record_visit(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    url = body.get("url")
    title = body.get("title")
    db = await get_db()
    return JSONResponse(
        await preview_service.record_visit(
            db,
            url=str(url) if isinstance(url, str) else "",
            title=title if isinstance(title, str) else None,
        )
    )
