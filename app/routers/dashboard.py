from fastapi import APIRouter
from fastapi.responses import JSONResponse
from app.database import get_db
from app.services.project_service import get_all_projects, get_project_stats_bulk
from app.services.task_service import get_all_tasks

router = APIRouter()


@router.get("/api/v1/dashboard")
async def dashboard_api():
    db = await get_db()

    rows = await db.execute("SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status")
    counts_raw = {r["status"]: r["cnt"] for r in await rows.fetchall()}
    task_counts = {
        s: counts_raw.get(s, 0)
        for s in ("backlog", "todo", "in-progress", "blocked", "done")
    }

    row = await db.execute(
        "SELECT COUNT(*) as cnt FROM workflow_items WHERE status = 'inbox'"
    )
    r = await row.fetchone()
    inbox_count = r["cnt"]

    projects = await get_all_projects(db)
    stats_by_project = await get_project_stats_bulk(db)
    project_stats = []
    for p in projects:
        stats = stats_by_project.get(
            p["id"], {"task_counts": {}, "inbox_count": 0, "total_tasks": 0}
        )
        project_stats.append({**dict(p), **stats})

    in_progress_tasks = await get_all_tasks(
        db, {"status": "in-progress", "sort": "project"}
    )

    rows = await db.execute(
        "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 10"
    )
    recent_activity = await rows.fetchall()

    return JSONResponse(
        {
            "task_counts": task_counts,
            "inbox_count": inbox_count,
            "projects": project_stats,
            "in_progress_tasks": [dict(t) for t in in_progress_tasks],
            "recent_activity": [dict(a) for a in recent_activity],
        }
    )
