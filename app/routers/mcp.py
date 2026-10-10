"""MCP Streamable HTTP endpoint for the workboard (`POST /mcp`).

Stateless: every POST carries one JSON-RPC message (or a batch) and gets a
plain JSON answer, so there is no session id and no SSE stream — GET and
DELETE are 405, which the transport spec allows.

The sidecar's trust model is "nothing off this host can reach it", and a
browser is the one thing on this host that can be steered from off it. So
this route refuses any request carrying an `Origin` (MCP clients never send
one; a web page always does) and any `Host` that is not loopback, which is
what closes DNS rebinding.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from app.database import get_db
from app.services import mcp_service

router = APIRouter()

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]"})
_MAX_BODY_BYTES = 1_048_576


def _host_name(host_header: str) -> str:
    if host_header.startswith("["):
        return host_header.split("]", 1)[0] + "]"
    return host_header.rsplit(":", 1)[0]


def _reject(request: Request) -> JSONResponse | None:
    if "origin" in request.headers:
        return JSONResponse({"error": "browser origins are not allowed"}, 403)
    if _host_name(request.headers.get("host", "")).lower() not in _LOOPBACK_HOSTS:
        return JSONResponse({"error": "host must be loopback"}, 403)
    version = request.headers.get("mcp-protocol-version")
    if version and version not in mcp_service.SUPPORTED_PROTOCOL_VERSIONS:
        return JSONResponse({"error": f"unsupported protocol version {version}"}, 400)
    return None


@router.post("/mcp")
async def mcp_post(request: Request) -> Response:
    if (rejection := _reject(request)) is not None:
        return rejection
    content_type = request.headers.get("content-type", "")
    if content_type.split(";", 1)[0].strip().lower() != "application/json":
        return JSONResponse({"error": "content-type must be application/json"}, 415)
    raw = await request.body()
    if len(raw) > _MAX_BODY_BYTES:
        return JSONResponse({"error": "request body too large"}, 413)
    try:
        payload: Any = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JSONResponse(
            mcp_service.jsonrpc_error(None, mcp_service.PARSE_ERROR, "invalid JSON"),
            400,
        )

    db = await get_db()
    if isinstance(payload, list):
        if not payload:
            return JSONResponse(
                mcp_service.jsonrpc_error(
                    None, mcp_service.INVALID_REQUEST, "empty batch"
                ),
                400,
            )
        answers = [await mcp_service.handle_message(db, m) for m in payload]
        replies = [a for a in answers if a is not None]
        return JSONResponse(replies) if replies else Response(status_code=202)

    answer = await mcp_service.handle_message(db, payload)
    return JSONResponse(answer) if answer is not None else Response(status_code=202)


@router.get("/mcp")
@router.delete("/mcp")
async def mcp_not_supported(request: Request) -> Response:
    if (rejection := _reject(request)) is not None:
        return rejection
    return Response(status_code=405, headers={"Allow": "POST"})
