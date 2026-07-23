"""Per-agent launch override router."""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.database import get_db
from app.models.launch import AgentOverrideUpsert
from app.services import agent_override_service

# Agent names come straight from the URL path and are later interpolated
# into FastAPI path matchers; restrict the charset so `/`, `?`, and similar
# can never sneak through encoded.
_SAFE_AGENT_NAME = re.compile(r"^[A-Za-z0-9._ -]+$")


def _validate_agent_name(name: str) -> str:
    if not _SAFE_AGENT_NAME.match(name):
        raise HTTPException(
            status_code=400,
            detail="agent_name must match [A-Za-z0-9._ -]+",
        )
    return name


router = APIRouter(prefix="/api/v1/agent-overrides")


@router.get("/{agent_name}")
async def api_get_override(agent_name: str) -> JSONResponse:
    _validate_agent_name(agent_name)
    db = await get_db()
    override = await agent_override_service.get_override(db, agent_name)
    if override is None:
        raise HTTPException(
            status_code=404, detail=f"no override for agent {agent_name!r}"
        )
    return JSONResponse(override.model_dump())


@router.put("/{agent_name}")
async def api_upsert_override(
    agent_name: str, body: AgentOverrideUpsert
) -> JSONResponse:
    _validate_agent_name(agent_name)
    db = await get_db()
    stored = await agent_override_service.upsert_override(db, agent_name, body)
    return JSONResponse(stored.model_dump())


@router.delete("/{agent_name}")
async def api_delete_override(agent_name: str) -> JSONResponse:
    _validate_agent_name(agent_name)
    db = await get_db()
    await agent_override_service.delete_override(db, agent_name)
    return JSONResponse({"agent_name": agent_name, "deleted": True})
