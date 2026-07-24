"""Project discovery + bulk import endpoints.

Mounted under ``/api/v1/projects/discovery/``. Thin like the rest — HTTP
parsing here, all logic in :mod:`app.services.project_discovery_service`.
"""

from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.database import get_db
from app.services import project_discovery_service

router = APIRouter(prefix="/api/v1/projects/discovery")


class ScanRequest(BaseModel):
    roots: list[str] | None = None
    max_depth: int = Field(
        default=project_discovery_service.DEFAULT_MAX_DEPTH, ge=1, le=8
    )
    max_results: int = Field(
        default=project_discovery_service.DEFAULT_MAX_RESULTS, ge=1, le=1000
    )
    git_only: bool = False


class ImportItem(BaseModel):
    path: str
    name: str | None = None
    stack: str | None = None


class ImportRequest(BaseModel):
    items: list[ImportItem]


@router.post("/scan")
async def api_scan(
    payload: ScanRequest | None = Body(default=None),  # noqa: B008
) -> JSONResponse:
    body = payload or ScanRequest()
    db = await get_db()
    imported_paths = await project_discovery_service.get_imported_paths(db)
    candidates = project_discovery_service.scan(
        roots=body.roots,
        max_depth=body.max_depth,
        max_results=body.max_results,
        already_imported_paths=imported_paths,
        git_only=body.git_only,
    )
    return JSONResponse({"candidates": candidates})


@router.post("/import")
async def api_import(payload: ImportRequest) -> JSONResponse:
    db = await get_db()
    items = [item.model_dump() for item in payload.items]
    result = await project_discovery_service.import_candidates(db, items)
    return JSONResponse(result)
