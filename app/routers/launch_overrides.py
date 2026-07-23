"""Launch overrides router.

Exposes:
  PUT    /api/v1/launch/overrides/{source_kind}/{source_id}
  DELETE /api/v1/launch/overrides/{source_kind}/{source_id}

`source_kind` is validated via the path parameter annotation (Literal type);
Pydantic/FastAPI raises 422 automatically for unknown values.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Path
from fastapi.responses import JSONResponse

from app.database import get_db
from app.models.launch import LaunchOverride, LaunchOverrideUpsert
from app.services import launch_override_service

router = APIRouter(prefix="/api/v1/launch", tags=["launch-overrides"])

SourceKindPath = Annotated[
    Literal["task", "inbox"],
    Path(description="Source entity type — 'task' or 'inbox'"),
]


@router.put(
    "/overrides/{source_kind}/{source_id}",
    response_model=LaunchOverride,
    summary="Upsert a per-source launch override",
)
async def upsert_override(
    source_kind: SourceKindPath,
    source_id: int,
    payload: LaunchOverrideUpsert,
) -> LaunchOverride:
    db = await get_db()
    return await launch_override_service.upsert_override(
        db, source_kind, source_id, payload
    )


@router.delete(
    "/overrides/{source_kind}/{source_id}",
    summary="Delete a per-source launch override",
)
async def delete_override(
    source_kind: SourceKindPath,
    source_id: int,
) -> JSONResponse:
    db = await get_db()
    await launch_override_service.delete_override(db, source_kind, source_id)
    return JSONResponse({"ok": True})
