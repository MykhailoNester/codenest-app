"""Multimodal attachments router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import attachments_service

from ._http import read_json_body

# Cap the upload payload generously above the service's 8 MB raw limit so the
# base64-encoded body has room (~10.7 MB) plus JSON envelope overhead.
_MAX_BODY = 12 * 1024 * 1024


router = APIRouter(prefix="/api/v1/attachments")


@router.get("")
async def api_list_attachments(limit: int = 50) -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        {"attachments": await attachments_service.list_attachments(db, limit)}
    )


@router.post("")
async def api_create_attachment(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(
        await attachments_service.create_attachment(
            db,
            filename=str(body.get("filename") or ""),
            mime_type=str(body.get("mime_type") or "application/octet-stream"),
            content_b64=str(body.get("content_b64") or ""),
            inbox_item_id=body.get("inbox_item_id")
            if isinstance(body.get("inbox_item_id"), int)
            else None,
        )
    )


@router.get("/{attachment_id}")
async def api_get_attachment(attachment_id: int, content: bool = False) -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        await attachments_service.get_attachment(
            db, attachment_id, include_content=content
        )
    )
