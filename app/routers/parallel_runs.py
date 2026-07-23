"""Parallel runs router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import parallel_runner_service

from ._http import read_json_body

# Create payload carries the prompt (≤ MAX_PROMPT_BYTES) + an int — no other
# fields. Bound at 32 KB to leave envelope headroom.
_MAX_CREATE_BODY = 32 * 1024


router = APIRouter(prefix="/api/v1/parallel-runs")


@router.get("")
async def api_list_runs(project_id: int | None = None) -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        {"runs": await parallel_runner_service.list_runs(db, project_id)}
    )


@router.post("")
async def api_create_run(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_CREATE_BODY)
    project_id = body.get("project_id")
    prompt = body.get("prompt")
    attempts = body.get("attempts")
    if not isinstance(project_id, int):
        raise HTTPException(status_code=400, detail="'project_id' must be an integer")
    if not isinstance(prompt, str):
        raise HTTPException(status_code=400, detail="'prompt' must be a string")
    if not isinstance(attempts, int):
        raise HTTPException(status_code=400, detail="'attempts' must be an integer")
    db = await get_db()
    return JSONResponse(
        await parallel_runner_service.create_run(
            db, project_id=project_id, prompt=prompt, attempts=attempts
        )
    )


@router.get("/{run_id}")
async def api_get_run(run_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await parallel_runner_service.get_run(db, run_id))


@router.delete("/{run_id}")
async def api_delete_run(run_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await parallel_runner_service.delete_run(db, run_id))


@router.get("/{run_id}/attempts/{attempt_id}/diff")
async def api_attempt_diff(run_id: int, attempt_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        await parallel_runner_service.attempt_diff(db, run_id, attempt_id)
    )


@router.post("/{run_id}/attempts/{attempt_id}/merge")
async def api_merge_attempt(run_id: int, attempt_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        await parallel_runner_service.merge_attempt(db, run_id, attempt_id)
    )


@router.post("/{run_id}/attempts/{attempt_id}/reject")
async def api_reject_attempt(run_id: int, attempt_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(
        await parallel_runner_service.reject_attempt(db, run_id, attempt_id)
    )
