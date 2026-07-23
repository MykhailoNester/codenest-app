"""Local-First Sync & Backup router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import sync_service

from ._http import read_json_body

_MAX_BODY = 4 * 1024

router = APIRouter(prefix="/api/v1/sync")


@router.get("/targets")
async def api_list_targets() -> JSONResponse:
    db = await get_db()
    return JSONResponse({"targets": await sync_service.list_targets(db)})


@router.post("/targets")
async def api_create_target(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(await sync_service.create_target(db, body))


@router.delete("/targets/{target_id}")
async def api_delete_target(target_id: int) -> JSONResponse:
    db = await get_db()
    await sync_service.delete_target(db, target_id)
    return JSONResponse({"ok": True})


@router.post("/targets/{target_id}/snapshot")
async def api_create_snapshot(target_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await sync_service.create_snapshot(db, target_id))


@router.get("/targets/{target_id}/snapshots")
async def api_list_snapshots(target_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse({"snapshots": await sync_service.list_snapshots(db, target_id)})


@router.post("/targets/{target_id}/restore")
async def api_restore_snapshot(target_id: int, request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    file_name = str(body.get("file_name", "")).strip()
    if not file_name:
        raise HTTPException(400, "file_name is required")
    return JSONResponse(await sync_service.restore_snapshot(db, target_id, file_name))


@router.get("/history")
async def api_list_history(limit: int = 50) -> JSONResponse:
    db = await get_db()
    return JSONResponse({"history": await sync_service.list_history(db, limit)})
