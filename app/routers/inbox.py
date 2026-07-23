from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from app.database import get_db
from app.services.inbox_service import (
    get_all_items,
    create_item,
    update_item,
    delete_item,
    promote_to_task,
)

router = APIRouter()


# --- JSON API ---


@router.get("/api/v1/inbox/counts")
async def api_inbox_counts():
    db = await get_db()
    rows = await db.execute(
        "SELECT status, COUNT(*) as cnt FROM workflow_items GROUP BY status"
    )
    raw = {r["status"]: r["cnt"] for r in await rows.fetchall()}
    counts = {
        s: raw.get(s, 0) for s in ("inbox", "review", "ready", "done", "rejected")
    }
    return JSONResponse(counts)


@router.get("/api/v1/inbox")
async def api_list_items(status: str = "", project_id: str = ""):
    db = await get_db()
    pid = int(project_id) if project_id else None
    items = await get_all_items(db, status_filter=status, project_id=pid)
    return JSONResponse([dict(i) for i in items])


@router.post("/api/v1/inbox")
async def api_create_item(request: Request):
    db = await get_db()
    data = await request.json()
    item_id = await create_item(db, data)
    return JSONResponse({"id": item_id}, status_code=201)


@router.put("/api/v1/inbox/{item_id}")
async def api_update_item(item_id: int, request: Request):
    db = await get_db()
    data = await request.json()
    await update_item(db, item_id, data)
    return JSONResponse({"ok": True})


@router.post("/api/v1/inbox/{item_id}/promote")
async def api_promote_item(item_id: int, request: Request):
    db = await get_db()
    try:
        data = await request.json()
    except Exception:
        data = {}
    task_id = await promote_to_task(db, item_id, data)
    return JSONResponse({"task_id": task_id}, status_code=201)


@router.delete("/api/v1/inbox/{item_id}")
async def api_delete_item(item_id: int):
    db = await get_db()
    await delete_item(db, item_id)
    return JSONResponse({"ok": True})
