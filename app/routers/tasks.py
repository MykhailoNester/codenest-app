from typing import TypeGuard

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import activity_service
from app.services.task_service import (
    add_blocker,
    add_task_label,
    change_task_status,
    create_task,
    delete_task,
    get_all_tasks,
    get_task,
    get_task_blockers,
    list_task_activity,
    list_task_labels,
    remove_blocker,
    remove_task_label,
    set_task_labels,
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


@router.get("/api/v1/tasks/{task_id}/activity")
async def api_task_activity(
    task_id: int, limit: int = activity_service.DEFAULT_ENTITY_LIMIT
) -> JSONResponse:
    db = await get_db()
    entries = await list_task_activity(db, task_id, limit)
    return JSONResponse(entries)


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


def _is_positive_int(value: object) -> TypeGuard[int]:
    """True for a positive int that is not a bool.

    ``isinstance(True, int)`` is ``True`` in Python, so a bare
    ``isinstance(v, int)`` check would silently accept ``{"label_id": true}``
    as ``1``.
    """
    return not isinstance(value, bool) and isinstance(value, int) and value > 0


@router.get("/api/v1/tasks/{task_id}/labels")
async def api_list_task_labels(task_id: int):
    db = await get_db()
    labels = await list_task_labels(db, task_id)
    return JSONResponse(labels)


@router.put("/api/v1/tasks/{task_id}/labels")
async def api_set_task_labels(task_id: int, request: Request):
    db = await get_db()
    try:
        data = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid json body"}, status_code=400)
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be a JSON object"}, status_code=400)
    label_ids = data.get("label_ids")
    if not isinstance(label_ids, list) or not all(
        _is_positive_int(v) for v in label_ids
    ):
        return JSONResponse(
            {"error": "label_ids must be a list of positive integers"},
            status_code=400,
        )
    labels = await set_task_labels(db, task_id, label_ids)
    return JSONResponse(labels)


@router.post("/api/v1/tasks/{task_id}/labels")
async def api_add_task_label(task_id: int, request: Request):
    db = await get_db()
    try:
        data = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "invalid json body"}, status_code=400)
    if not isinstance(data, dict):
        return JSONResponse({"error": "body must be a JSON object"}, status_code=400)
    label_id = data.get("label_id")
    if not _is_positive_int(label_id):
        return JSONResponse(
            {"error": "label_id must be a positive integer"}, status_code=400
        )
    await add_task_label(db, task_id, label_id)
    return JSONResponse({"ok": True}, status_code=201)


@router.delete("/api/v1/tasks/{task_id}/labels/{label_id}")
async def api_remove_task_label(task_id: int, label_id: int):
    db = await get_db()
    await remove_task_label(db, task_id, label_id)
    return JSONResponse({"ok": True})
