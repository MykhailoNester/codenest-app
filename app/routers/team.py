from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services.team_service import (
    create_member,
    get_all_members,
    get_member,
    update_member,
)

router = APIRouter()


# --- JSON API ---


@router.get("/api/v1/team")
async def api_list_members():
    db = await get_db()
    members = await get_all_members(db)
    return JSONResponse([dict(m) for m in members])


@router.get("/api/v1/team/{member_id}")
async def api_get_member(member_id: int):
    db = await get_db()
    member = await get_member(db, member_id)
    if not member:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(dict(member))


@router.post("/api/v1/team")
async def api_create_member(request: Request):
    db = await get_db()
    data = await request.json()
    member_id = await create_member(db, data)
    return JSONResponse({"id": member_id}, status_code=201)


@router.put("/api/v1/team/{member_id}")
async def api_update_member(member_id: int, request: Request):
    db = await get_db()
    data = await request.json()
    await update_member(db, member_id, data)
    return JSONResponse({"ok": True})
