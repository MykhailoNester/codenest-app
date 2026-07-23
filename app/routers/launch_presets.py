"""Launch presets REST router.

Exposes CRUD for saved launch configurations under
``/api/v1/launch-presets``.  All persistence and validation logic lives
in ``launch_preset_service``; this file handles HTTP plumbing only.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.database import get_db
from app.models.launch import LaunchPresetCreate
from app.services import launch_preset_service

router = APIRouter()


@router.get("/api/v1/launch-presets")
async def api_list_launch_presets() -> JSONResponse:
    """Return all saved launch presets."""
    db = await get_db()
    presets = await launch_preset_service.list_presets(db)
    return JSONResponse([p.model_dump() for p in presets])


@router.post("/api/v1/launch-presets", status_code=201)
async def api_create_launch_preset(payload: LaunchPresetCreate) -> JSONResponse:
    """Create a new launch preset.

    Returns ``201`` on success, ``409`` on name conflict, ``400`` when
    ``project_id`` or ``provider_id`` do not exist.
    """
    db = await get_db()
    preset = await launch_preset_service.create_preset(db, payload)
    return JSONResponse(preset.model_dump(), status_code=201)


@router.delete("/api/v1/launch-presets/{preset_id}")
async def api_delete_launch_preset(preset_id: int) -> JSONResponse:
    """Delete a launch preset by id.

    Returns ``200 {"ok": true}`` on success, ``404`` when not found.
    """
    db = await get_db()
    await launch_preset_service.delete_preset(db, preset_id)
    return JSONResponse({"ok": True})
