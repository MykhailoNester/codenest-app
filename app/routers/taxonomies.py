"""Taxonomies router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import taxonomy_service

router = APIRouter(prefix="/api/v1/taxonomies")


@router.get("")
async def api_list() -> JSONResponse:
    db = await get_db()
    return JSONResponse(await taxonomy_service.list_all(db))


@router.get("/{kind}")
async def api_list_by_kind(kind: str, include_inactive: bool = False) -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        await taxonomy_service.list_by_kind(db, kind, include_inactive=include_inactive)
    )


@router.post("")
async def api_create(request: Request) -> JSONResponse:
    db = await get_db()
    payload = await request.json()
    return JSONResponse(await taxonomy_service.create(db, payload), status_code=201)


@router.patch("/{taxonomy_id}")
async def api_update(taxonomy_id: int, request: Request) -> JSONResponse:
    db = await get_db()
    patch = await request.json()
    return JSONResponse(await taxonomy_service.update(db, taxonomy_id, patch))


@router.post("/{kind}/reorder")
async def api_reorder(kind: str, request: Request) -> JSONResponse:
    db = await get_db()
    body = await request.json()
    ordered_ids = body.get("ordered_ids", [])
    if not isinstance(ordered_ids, list):
        return JSONResponse({"error": "ordered_ids must be a list"}, status_code=400)
    return JSONResponse(
        await taxonomy_service.reorder(db, kind, [int(i) for i in ordered_ids])
    )


@router.delete("/{taxonomy_id}")
async def api_delete(taxonomy_id: int) -> JSONResponse:
    db = await get_db()
    await taxonomy_service.delete(db, taxonomy_id)
    return JSONResponse({"ok": True})
