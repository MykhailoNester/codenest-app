"""Attention queue router — the Needs You page's endpoint surface.

Three routes: the queue (with the counts its tiles and the nav rail render), a
way to recompute it, and — since #172 gave the queue rows that are questions
rather than observations — a way to say what the answer was.

`GET /api/v1/attention` recomputes before it reads. That is deliberate and it
is what makes the page's promise — "re-checked every 30 seconds" — true without
a background tick: the producers are five indexed SELECTs over tables that are
small by construction, so recomputing on read costs less than the render that
follows it and removes any possibility of the page showing a queue that the
database stopped agreeing with. `refresh=false` is there for the one caller
that wants the stored queue verbatim (a test, or a second widget on a page that
has already refreshed this tick) rather than as a performance escape hatch.

The expiry sweep that closes aged-out hook prompts (#172) rides on the same
recompute, which is why `refresh=false` really does mean verbatim: it can hand
back an item that expired a moment ago. That is the staleness every stored item
already has — the queue is only ever as current as its last recompute — and it
is why the page's own read does not pass the flag.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

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


class RespondRequest(BaseModel):
    """What a human did about one item.

    `response` is free-form and stored verbatim in `response_json`: what a
    useful answer looks like differs per hook event, and a schema here would
    be this module guessing at the shape of a payload Claude Code defines.
    """

    response: Any = None
    resolution: str = attention_service.RESOLUTION_ANSWERED


@router.post("/{item_id}/respond")
async def api_respond(item_id: int, body: RespondRequest) -> JSONResponse:
    """Record the answer to a blocking item and close it.

    404 for an id that is not there *or* is already resolved: from the page's
    side those are the same situation — the row it was looking at is not
    answerable any more — and telling them apart would mean telling a user
    that the thing they just answered had already expired, which helps nobody
    and leaks the sweep's timing into the UI.

    This does not reach the session. See `attention_service.respond`.
    """
    if body.resolution not in attention_service.HUMAN_RESOLUTIONS:
        raise HTTPException(
            status_code=422,
            detail=(
                "resolution must be one of "
                f"{', '.join(attention_service.HUMAN_RESOLUTIONS)}"
            ),
        )
    db = await get_db()
    item = await attention_service.respond(
        db, item_id, response=body.response, resolution=body.resolution
    )
    if item is None:
        raise HTTPException(status_code=404, detail="no live attention item")
    return JSONResponse({"item": item})
