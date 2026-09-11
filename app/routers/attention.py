"""Attention queue router — the Needs You page's only endpoint surface.

Two routes, because the page needs exactly two things: the queue (with the
counts its tiles and the nav rail render) and a way to recompute it.

`GET /api/v1/attention` recomputes before it reads. That is deliberate and it
is what makes the page's promise — "re-checked every 30 seconds" — true without
a background tick: the producers are five indexed SELECTs over tables that are
small by construction, so recomputing on read costs less than the render that
follows it and removes any possibility of the page showing a queue that the
database stopped agreeing with. `refresh=false` is there for the one caller
that wants the stored queue verbatim (a test, or a second widget on a page that
has already refreshed this tick) rather than as a performance escape hatch.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import attention_service

router = APIRouter(prefix="/api/v1/attention")


@router.get("")
async def api_list(state: str = "open", refresh: bool = True) -> JSONResponse:
    if state not in attention_service.STATES:
        raise HTTPException(status_code=422, detail=f"unknown state {state!r}")
    db = await get_db()
    if refresh:
        summary = await attention_service.refresh(db)
    else:
        summary = await attention_service.counts(db)
    items = await attention_service.list_items(db, state=state)
    return JSONResponse({"items": items, "counts": summary})


@router.post("/refresh")
async def api_refresh() -> JSONResponse:
    db = await get_db()
    return JSONResponse(await attention_service.refresh(db))
