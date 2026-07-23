"""Shared HTTP helpers for thin routers.

Routers in this project parse the request body and call a service. The
body parser needs a configurable byte cap (markdown editor allows 1 MB
of content; the marketplace install payload is tiny) plus a
``Content-Length`` pre-check so a multi-MB POST is rejected before
FastAPI materialises it.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException, Request


async def read_json_body(request: Request, max_bytes: int) -> dict[str, Any]:
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > max_bytes + 4096:
                raise HTTPException(
                    status_code=413,
                    detail=f"request body too large ({cl} bytes)",
                )
        except ValueError:
            pass
    raw = await request.body()
    if len(raw) > max_bytes + 4096:
        raise HTTPException(
            status_code=413,
            detail=f"request body too large ({len(raw)} bytes)",
        )
    try:
        body = json.loads(raw or b"{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=400, detail="request body must be a JSON object"
        )
    return body
