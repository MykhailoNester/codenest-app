"""Plugin SDK & Local Plugin System router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import plugin_service

from ._http import read_json_body

_MAX_BODY = 4 * 1024

router = APIRouter(prefix="/api/v1/plugins")


@router.get("")
async def api_list() -> JSONResponse:
    db = await get_db()
    plugins = await plugin_service.list_plugins(db)
    trust_mode = await plugin_service.get_trust_mode(db)
    return JSONResponse(
        {
            "plugins": plugins,
            "trust_mode": trust_mode,
            "plugins_root": str(plugin_service.plugins_root()),
        }
    )


@router.post("/refresh")
async def api_refresh() -> JSONResponse:
    db = await get_db()
    return JSONResponse(await plugin_service.scan_and_load(db))


@router.post("/trust")
async def api_trust(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    sha = str(body.get("sha256", "")).strip().lower()
    return JSONResponse(await plugin_service.trust_hash(db, sha))


@router.post("/untrust")
async def api_untrust(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    sha = str(body.get("sha256", "")).strip().lower()
    return JSONResponse(await plugin_service.untrust_hash(db, sha))


@router.post("/trust-mode")
async def api_set_trust_mode(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(
        await plugin_service.set_trust_mode(db, str(body.get("mode", "")))
    )


@router.post("/{plugin_id}/enabled")
async def api_set_enabled(plugin_id: int, request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    enabled = bool(body.get("enabled", True))
    return JSONResponse(await plugin_service.set_enabled(db, plugin_id, enabled))
