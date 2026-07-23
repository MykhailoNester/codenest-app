"""Launch seed router.

Exposes:
  GET /api/v1/launch/seed?source_kind={task|inbox}&source_id={id}

Returns a `LaunchSeed` JSON payload that the frontend uses to pre-fill
the Launch modal for a given task or inbox item.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query

from app.database import get_db
from app.models.launch import LaunchSeed
from app.services import launch_seed_service

router = APIRouter(prefix="/api/v1/launch", tags=["launch-seed"])


@router.get(
    "/seed",
    response_model=LaunchSeed,
    summary="Build a launch seed for a task or inbox item",
)
async def get_seed(
    source_kind: Literal["task", "inbox"] = Query(
        ..., description="Source entity type — 'task' or 'inbox'"
    ),
    source_id: int = Query(..., description="Numeric id of the source row"),
) -> LaunchSeed:
    db = await get_db()
    return await launch_seed_service.build_seed(db, source_kind, source_id)
