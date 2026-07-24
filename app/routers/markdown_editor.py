"""Markdown editor router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import markdown_editor_service
from app.services.markdown_editor_service import MAX_CONTENT_BYTES

from ._http import read_json_body

router = APIRouter(prefix="/api/v1/markdown-files")


@router.get("/{project_id}")
async def api_read(project_id: int, kind: str = "claude") -> JSONResponse:
    db = await get_db()
    return JSONResponse(await markdown_editor_service.read(db, project_id, kind))


@router.post("/{project_id}/diff")
async def api_diff(project_id: int, request: Request) -> JSONResponse:
    body = await read_json_body(request, MAX_CONTENT_BYTES)
    db = await get_db()
    return JSONResponse(
        await markdown_editor_service.diff(
            db,
            project_id,
            str(body.get("kind", "claude")),
            str(body.get("content", "")),
        )
    )


@router.put("/{project_id}")
async def api_write(project_id: int, request: Request) -> JSONResponse:
    body = await read_json_body(request, MAX_CONTENT_BYTES)
    db = await get_db()
    return JSONResponse(
        await markdown_editor_service.write(
            db,
            project_id,
            str(body.get("kind", "claude")),
            str(body.get("content", "")),
            body.get("expected_sha"),
        )
    )
