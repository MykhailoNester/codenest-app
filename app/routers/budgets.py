"""Cost budgets, quotas, and alerts router."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import budget_service

from ._http import read_json_body

_MAX_BODY = 8 * 1024


router = APIRouter(prefix="/api/v1/budgets")


@router.get("")
async def api_list() -> JSONResponse:
    db = await get_db()
    return JSONResponse({"budgets": await budget_service.list_budgets(db)})


@router.post("")
async def api_create(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(await budget_service.create_budget(db, body))


@router.get("/burn-rate")
async def api_burn_rate() -> JSONResponse:
    db = await get_db()
    return JSONResponse({"items": await budget_service.burn_summary(db)})


@router.get("/check")
async def api_check(
    project_id: int | None = None, profile: str | None = None
) -> JSONResponse:
    db = await get_db()
    allow, reason = await budget_service.check_hard_stop(db, project_id, profile)
    return JSONResponse({"allow": allow, "reason": reason})


@router.get("/{budget_id}")
async def api_get(budget_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await budget_service.get_budget(db, budget_id))


@router.patch("/{budget_id}")
async def api_patch(budget_id: int, request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(await budget_service.update_budget(db, budget_id, body))


@router.delete("/{budget_id}")
async def api_delete(budget_id: int) -> JSONResponse:
    db = await get_db()
    await budget_service.delete_budget(db, budget_id)
    return JSONResponse({"ok": True})
