"""Cross-App Integrations Pack router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import integrations_service

from ._http import read_json_body

_MAX_BODY = 8 * 1024

router = APIRouter(prefix="/api/v1/integrations")


@router.get("")
async def api_list() -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        {"integrations": await integrations_service.list_with_status(db)}
    )


@router.post("/{slug}/install")
async def api_install(slug: str, request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(await integrations_service.install(db, slug, body.get("env")))


@router.post("/{slug}/uninstall")
async def api_uninstall(slug: str) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await integrations_service.uninstall(db, slug))


# ── Custom catalog entries ─────────────────────────────────


@router.post("/custom")
async def api_add_custom(request: Request) -> JSONResponse:
    """Add a user-authored integration catalog entry.

    Body: ``{slug, name, description?, pane_url?, mcp_command, mcp_args?, env_template?}``
    """
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(
        await integrations_service.add_custom_entry(
            db,
            slug=str(body.get("slug", "")),
            name=str(body.get("name", "")),
            description=str(body.get("description", "")),
            pane_url=str(body.get("pane_url", "")),
            mcp_command=str(body.get("mcp_command", "")),
            mcp_args=body.get("mcp_args"),
            env_template=body.get("env_template"),
        )
    )


@router.delete("/custom/{slug}")
async def api_delete_custom(slug: str) -> JSONResponse:
    """Delete a user-authored catalog entry (is_custom=1 only)."""
    db = await get_db()
    return JSONResponse(await integrations_service.delete_custom_entry(db, slug))
