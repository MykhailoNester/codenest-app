from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services.project_service import (
    create_project,
    delete_project,
    get_all_projects,
    get_project,
    get_project_stats,
    get_project_stats_bulk,
    update_project,
)

router = APIRouter()


# --- JSON API ---


@router.get("/api/v1/projects")
async def api_list_projects():
    db = await get_db()
    projects = await get_all_projects(db)
    stats_by_project = await get_project_stats_bulk(db)
    result = []
    for p in projects:
        stats = stats_by_project.get(
            p["id"], {"task_counts": {}, "inbox_count": 0, "total_tasks": 0}
        )
        result.append({**dict(p), **stats})
    return JSONResponse(result)


@router.get("/api/v1/projects/{project_id}")
async def api_get_project(project_id: int):
    db = await get_db()
    project = await get_project(db, project_id)
    if not project:
        return JSONResponse({"error": "not found"}, status_code=404)
    stats = await get_project_stats(db, project_id)
    return JSONResponse({**dict(project), **stats})


@router.post("/api/v1/projects")
async def api_create_project(request: Request):
    db = await get_db()
    data = await request.json()
    project_id = await create_project(db, data)
    return JSONResponse({"id": project_id}, status_code=201)


@router.delete("/api/v1/projects/{project_id}")
async def api_delete_project(project_id: int):
    db = await get_db()
    await delete_project(db, project_id)
    return JSONResponse({"ok": True})


@router.patch("/api/v1/projects/{project_id}")
async def api_update_project(project_id: int, request: Request):
    """Partially update a project.

    Accepted fields: ``name``, ``description``, ``tech_stack``, ``status``,
    ``path``, ``default_provider_id``.  ``path`` must be absolute when provided.
    ``default_provider_id`` accepts an integer provider id or ``null`` to clear.
    """
    db = await get_db()
    data = await request.json()
    await update_project(db, project_id, data)
    project = await get_project(db, project_id)
    if not project:
        return JSONResponse({"error": "not found"}, status_code=404)
    stats = await get_project_stats(db, project_id)
    return JSONResponse({**dict(project), **stats})


@router.post("/api/v1/projects/validate-path")
async def api_validate_project_path(request: Request):
    """Check whether a filesystem path is valid for a project.

    Returns ``{exists, is_dir, absolute}`` based on local ``pathlib`` checks.
    No filesystem writes are performed.
    """
    body = await request.json()
    raw_path: str = body.get("path", "")
    p = Path(raw_path) if raw_path else None
    if p is None:
        return JSONResponse({"exists": False, "is_dir": False, "absolute": False})
    return JSONResponse(
        {
            "exists": p.exists(),
            "is_dir": p.is_dir(),
            "absolute": p.is_absolute(),
        }
    )
