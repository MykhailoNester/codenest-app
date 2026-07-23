from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import search_service

router = APIRouter(prefix="/api/v1", tags=["search"])

_VALID_TYPES = {"task", "project", "doc", "inbox", "event"}
_DEFAULT_TYPES = "task,project,doc,inbox,event"


@router.get("/search")
async def api_search(
    q: str = "",
    types: str = _DEFAULT_TYPES,
    limit: int = 20,
) -> JSONResponse:
    if not q or len(q) > 500:
        raise HTTPException(status_code=422, detail="q must be 1–500 characters")

    limit = max(1, min(limit, 100))

    types_list = [t.strip() for t in types.split(",") if t.strip()]
    unknown = [t for t in types_list if t not in _VALID_TYPES]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown types: {unknown}")

    db = await get_db()
    results = await search_service.search(db, q=q, types=types_list, limit=limit)
    return JSONResponse({"results": results, "query": q, "total": len(results)})
