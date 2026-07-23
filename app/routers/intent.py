"""Intent classifier router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.services import intent_service

from ._http import read_json_body

# The query is the user's omni-bar input; small even for long prompts.
_MAX_BODY = 32 * 1024


router = APIRouter(prefix="/api/v1/intent")


@router.post("/classify")
async def api_classify_intent(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    query = body.get("query")
    return JSONResponse(
        intent_service.classify(query if isinstance(query, str) else "")
    )
