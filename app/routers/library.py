"""Knowledge Base / Context Library router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import library_service

from ._http import read_json_body

# Body cap: title + body + tags; service enforces a 64 KB body limit
# separately, so leave headroom for JSON envelope + multi-byte chars.
_MAX_BODY = 128 * 1024


router = APIRouter(prefix="/api/v1/library")


@router.get("")
async def api_list_items(
    q: str | None = None, tag: str | None = None, limit: int = 50
) -> JSONResponse:
    db = await get_db()
    return JSONResponse({"items": await library_service.list_items(db, q, tag, limit)})


@router.post("")
async def api_create_item(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(
        await library_service.create_item(
            db,
            slug=str(body.get("slug") or ""),
            title=str(body.get("title") or ""),
            body=str(body.get("body") or ""),
            tags=body.get("tags"),
            source=str(body.get("source") or "manual"),
        )
    )


@router.get("/by-slug/{slug}")
async def api_get_by_slug(slug: str) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await library_service.get_by_slug(db, slug))


@router.get("/{item_id}")
async def api_get_item(item_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await library_service.get_by_id(db, item_id))


@router.patch("/{item_id}")
async def api_update_item(item_id: int, request: Request) -> JSONResponse:
    patch = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(await library_service.update_item(db, item_id, patch))


@router.delete("/{item_id}")
async def api_delete_item(item_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await library_service.delete_item(db, item_id))
