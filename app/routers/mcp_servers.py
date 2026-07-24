"""MCP server registry router.

Also exposes the launch-time materialization endpoint under
``/api/v1/launches/mcp-config``.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import mcp_servers_service

from ._http import read_json_body

# Server config payloads (command/args/env) are small in practice; cap at
# 64 KB so a runaway env_json can't OOM the parser.
_MAX_BODY = 64 * 1024


router = APIRouter(prefix="/api/v1/mcp-servers")

# Separate router for launch-time helpers — registered under /api/v1/launches.
launches_router = APIRouter(prefix="/api/v1/launches")


@router.get("")
async def api_list_servers() -> JSONResponse:
    db = await get_db()
    return JSONResponse({"servers": await mcp_servers_service.list_servers(db)})


@router.get("/suggested")
async def api_list_suggested() -> JSONResponse:
    db = await get_db()
    return JSONResponse({"items": await mcp_servers_service.list_suggested(db)})


@router.post("")
async def api_create_server(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    enabled_raw = body.get("enabled")
    enabled = enabled_raw if isinstance(enabled_raw, bool) else True
    notes_raw = body.get("notes")
    notes = notes_raw if isinstance(notes_raw, str) else None
    db = await get_db()
    return JSONResponse(
        await mcp_servers_service.create_server(
            db,
            slug=str(body.get("slug", "")),
            name=str(body.get("name", "")),
            command=str(body.get("command", "")),
            args=body.get("args"),
            env=body.get("env"),
            enabled=enabled,
            source="manual",
            notes=notes,
        )
    )


@router.get("/{server_id}")
async def api_get_server(server_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await mcp_servers_service.get_server(db, server_id))


@router.patch("/{server_id}")
async def api_update_server(server_id: int, request: Request) -> JSONResponse:
    patch = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(await mcp_servers_service.update_server(db, server_id, patch))


@router.delete("/{server_id}")
async def api_delete_server(server_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await mcp_servers_service.delete_server(db, server_id))


@router.post("/{server_id}/test")
async def api_test_server(server_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await mcp_servers_service.test_server(db, server_id))


# ---------------------------------------------------------------------------
# Scope + effective list endpoints
# ---------------------------------------------------------------------------


@router.get("/effective")
async def api_effective_servers(project_id: int) -> JSONResponse:
    """Return the MCP servers that will be injected for the given project.

    Applies ``scope_mode`` filtering: servers with ``scope_mode='off'`` are
    excluded; ``scope_mode='allowlist'`` servers are only included when a
    matching ``mcp_server_project_scopes`` row exists.
    """
    db = await get_db()
    servers = await mcp_servers_service.resolve_enabled_for_project(db, project_id)
    return JSONResponse({"servers": servers, "project_id": project_id})


@router.post("/{server_id}/scope")
async def api_set_scope(server_id: int, request: Request) -> JSONResponse:
    """Set the ``scope_mode`` and optional project allowlist for a server.

    Body: ``{"scope_mode": "all"|"allowlist"|"off", "project_ids": [1, 2, …]}``
    ``project_ids`` is required (but may be empty) when ``scope_mode='allowlist'``.
    """
    body = await read_json_body(request, _MAX_BODY)
    mode = str(body.get("scope_mode", "all"))
    raw_ids = body.get("project_ids", [])
    if not isinstance(raw_ids, list):
        from fastapi import HTTPException as _HTTPException

        raise _HTTPException(status_code=400, detail="'project_ids' must be a list")
    project_ids = [int(pid) for pid in raw_ids]
    db = await get_db()
    return JSONResponse(
        await mcp_servers_service.set_scope(db, server_id, mode, project_ids)
    )


# ---------------------------------------------------------------------------
# Launch-time MCP config materialization
# ---------------------------------------------------------------------------


@launches_router.post("/mcp-config")
async def api_materialize_mcp_config(project_id: int, request: Request) -> JSONResponse:
    """Materialise a ``--mcp-config`` temp file for the given project.

    Optional JSON body: ``{"exclude_slugs": ["atlassian", …]}``

    ``exclude_slugs`` are omitted from the written config so the materialized
    file is the authoritative record of what the launched agent can reach.
    This is the server-side enforcement of the per-launch capability
    disclosure panel.

    Returns ``{"path": "/tmp/codenest-mcp/project-N-…json"}`` — ready to
    pass as ``{mcp_config}`` in the provider command template.
    """
    # Body is optional; an empty body (e.g. no Content-Type) is treated as {}.
    try:
        body = await read_json_body(request, _MAX_BODY)
    except Exception:  # noqa: BLE001
        body = {}
    raw_exclude = body.get("exclude_slugs", [])
    exclude_slugs: list[str] = (
        [str(s) for s in raw_exclude] if isinstance(raw_exclude, list) else []
    )
    db = await get_db()
    path = await mcp_servers_service.materialize_mcp_config(
        db, project_id, exclude_slugs=exclude_slugs
    )
    return JSONResponse({"path": path, "project_id": project_id})
