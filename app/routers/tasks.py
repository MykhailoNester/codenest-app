from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services.task_service import (
    add_blocker,
    change_task_status,
    create_task,
    delete_task,
    get_all_tasks,
    get_task,
    get_task_blockers,
    remove_blocker,
    update_task,
)

router = APIRouter()


# --- JSON API ---


@router.get("/api/v1/tasks")
async def api_list_tasks(
    status: str = "",
    assignee_id: str = "",
    priority: str = "",
    project_id: str = "",
    sort: str = "",
):
    db = await get_db()
    filters: dict[str, str | int] = {}
    if status:
        filters["status"] = status
    if assignee_id:
        filters["assignee_id"] = int(assignee_id)
    if priority:
        filters["priority"] = priority
    if project_id:
        filters["project_id"] = int(project_id)
    if sort:
        filters["sort"] = sort
    tasks = await get_all_tasks(db, filters)
    return JSONResponse([dict(t) for t in tasks])


@router.get("/api/v1/tasks/{task_id}")
async def api_get_task(task_id: int):
    db = await get_db()
    task = await get_task(db, task_id)
    if not task:
        return JSONResponse({"error": "not found"}, status_code=404)
    blockers = await get_task_blockers(db, task_id)
    return JSONResponse({**dict(task), "blockers": [dict(b) for b in blockers]})


@router.post("/api/v1/tasks")
async def api_create_task(request: Request):
    db = await get_db()
    data = await request.json()
    task_id = await create_task(db, data)
    return JSONResponse({"id": task_id}, status_code=201)


@router.put("/api/v1/tasks/{task_id}")
async def api_update_task(task_id: int, request: Request):
    db = await get_db()
    data = await request.json()
    await update_task(db, task_id, data)
    return JSONResponse({"ok": True})


@router.post("/api/v1/tasks/{task_id}/status")
async def api_change_status(task_id: int, request: Request):
    db = await get_db()
    data = await request.json()
    await change_task_status(db, task_id, data["status"])
    return JSONResponse({"ok": True})


@router.delete("/api/v1/tasks/{task_id}")
async def api_delete_task(task_id: int):
    db = await get_db()
    await delete_task(db, task_id)
    return JSONResponse({"ok": True})


@router.post("/api/v1/tasks/{task_id}/blockers")
async def api_add_blocker(task_id: int, request: Request):
    db = await get_db()
    try:
        data = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid json body"}, status_code=400)
    raw = data.get("blocking_task_id") if isinstance(data, dict) else None
    if not isinstance(raw, int) or raw <= 0:
        return JSONResponse(
            {"error": "blocking_task_id must be a positive integer"},
            status_code=400,
        )
    if raw == task_id:
        return JSONResponse({"error": "a task cannot block itself"}, status_code=400)
    if await get_task(db, raw) is None:
        return JSONResponse({"error": f"task {raw} does not exist"}, status_code=404)
    await add_blocker(db, task_id, raw)
    return JSONResponse({"ok": True}, status_code=201)


@router.delete("/api/v1/tasks/{task_id}/blockers/{blocker_id}")
async def api_remove_blocker(task_id: int, blocker_id: int):
    db = await get_db()
    await remove_blocker(db, blocker_id)
    return JSONResponse({"ok": True})
