"""App settings REST router.

`/api/v1/settings/lookups` is the single bootstrap call the frontend
makes at app load — it returns every list and color map the UI needs
plus the full profiles array. Individual `PUT /api/v1/settings/{key}`
calls happen only when the user edits a list in the Settings page.

Note: the `lookups` route is registered before `{key}` so FastAPI does
not match `lookups` as a path parameter.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import settings_service
from app.services.settings_service import SettingPut

router = APIRouter()


@router.get("/api/v1/settings/lookups")
async def api_lookups() -> JSONResponse:
    db = await get_db()
    return JSONResponse(await settings_service.get_lookups(db))


@router.get("/api/v1/settings")
async def api_list_settings() -> JSONResponse:
    db = await get_db()
    return JSONResponse(await settings_service.list_settings(db))


@router.get("/api/v1/settings/{key}")
async def api_get_setting(key: str) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await settings_service.get_setting(db, key))


@router.put("/api/v1/settings/{key}")
async def api_upsert_setting(key: str, payload: SettingPut) -> JSONResponse:
    db = await get_db()
    setting = await settings_service.upsert_setting(db, key, payload.value_json)
    return JSONResponse(setting)
