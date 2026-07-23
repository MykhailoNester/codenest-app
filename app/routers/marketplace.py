"""Marketplace router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import marketplace_service

from ._http import read_json_body

# Install payload is just a slug + project_id; reject anything implausibly
# large up-front rather than trusting the JSON parser to do it.
_MAX_INSTALL_BODY = 16 * 1024


router = APIRouter(prefix="/api/v1/marketplace")


@router.get("/items")
async def api_list_items() -> JSONResponse:
    return JSONResponse(marketplace_service.list_catalog())


@router.get("/installs")
async def api_list_installs(project_id: int | None = None) -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        {"installs": await marketplace_service.list_installs(db, project_id)}
    )


@router.post("/install")
async def api_install(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_INSTALL_BODY)
    slug = body.get("slug")
    project_id = body.get("project_id")
    if not isinstance(slug, str) or not slug:
        raise HTTPException(status_code=400, detail="'slug' is required")
    if not isinstance(project_id, int):
        raise HTTPException(status_code=400, detail="'project_id' must be an integer")
    db = await get_db()
    return JSONResponse(await marketplace_service.install(db, slug, project_id))
