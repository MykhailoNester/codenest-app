"""FastAPI router for the active workspace."""

from __future__ import annotations

import json

from fastapi import APIRouter

from app.database import get_db
from app.models.workspace import Workspace
from app.services import hooks_service, workspace_context_service, workspace_service

router = APIRouter(prefix="/api/v1/workspace", tags=["workspace"])


@router.get("")
async def get_workspace() -> Workspace:
    db = await get_db()
    return Workspace(**await workspace_service.get_active(db))


@router.get("/context")
async def get_workspace_context() -> dict:
    """Return the workspace project registry.

    Note: the SessionStart hook (hooks_service.py) does NOT call this endpoint;
    hook payloads go to /api/v1/hooks/session-start. This endpoint is available
    for future integration or tooling but currently has no frontend caller.
    """
    db = await get_db()
    return await workspace_context_service.session_context(db)


@router.get("/hooks/snippet")
async def get_hook_snippet(config_home: str | None = None) -> dict:
    """The settings.json hooks block to paste (guided copy-paste; no auto-write)."""
    base = hooks_service.sidecar_base_url()
    block = hooks_service.build_hook_settings(base)
    return {
        "settings_path": hooks_service.settings_json_path(config_home),
        "base_url": base,
        "hooks": block,
        "snippet": json.dumps(block, indent=2),
    }


@router.get("/hooks/status")
async def get_hook_status(since: str | None = None) -> dict:
    """Verify signal. Pass ``since`` (a prior last_ping_at) to require a fresh ping."""
    db = await get_db()
    return await hooks_service.hooks_status(db, since)
