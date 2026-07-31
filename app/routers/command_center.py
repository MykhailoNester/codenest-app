"""FastAPI router for the Command Center."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import get_db
from app.services import (
    command_center_service,
    project_import_service,
    project_scanner_service,
    project_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/command-center", tags=["command-center"])


class BootstrapRequest(BaseModel):
    force_org_agents_reinstall: bool = False


@router.post("/bootstrap")
async def post_bootstrap(req: BootstrapRequest | None = None) -> dict[str, Any]:
    db = await get_db()
    force = bool(req.force_org_agents_reinstall) if req else False
    return await command_center_service.bootstrap(db, force=force)


@router.post("/workspace/regenerate")
async def post_regenerate() -> dict[str, Any]:
    db = await get_db()
    return await command_center_service.regenerate_workspace_links(db)


@router.get("/workspace/health")
async def get_health() -> dict[str, Any]:
    db = await get_db()
    issues = await command_center_service.get_workspace_health(db)
    # Conflicts are not `verify_status` rows: the agent is intact, it is simply
    # not in the workspace because another project's agent already answers to its
    # name. Reported here because this is where the UI looks for "something needs
    # your attention", and this needs a rename or a disable to resolve.
    conflicts = await command_center_service.list_agent_name_conflicts(db)
    return {
        "issues": issues,
        "issue_count": len(issues),
        "agent_name_conflicts": conflicts,
        "conflict_count": len(conflicts),
    }


@router.get("/agents")
async def list_configured_agents() -> dict[str, Any]:
    """Aggregate view of all configured agents, grouped for the Agents page.

    Returns ``{ "shared": [...], "by_project": [...] }`` — see
    ``command_center_service.list_configured_agents`` for the full shape.
    """
    db = await get_db()
    return await command_center_service.list_configured_agents(db)


@router.get("/org-agents")
async def list_org_agents() -> list[dict[str, Any]]:
    db = await get_db()
    cur = await db.execute(
        "SELECT id, name, display_name, description, model, version, "
        "install_path, link_path, link_type, enabled, verify_status, sha256, installed_at "
        "FROM org_agents ORDER BY id"
    )
    rows = await cur.fetchall()
    cols = [
        "id",
        "name",
        "display_name",
        "description",
        "model",
        "version",
        "install_path",
        "link_path",
        "link_type",
        "enabled",
        "verify_status",
        "sha256",
        "installed_at",
    ]
    return [dict(zip(cols, r)) for r in rows]


# ---------- Project import flow ----------


class PreviewRequest(BaseModel):
    root_path: str


class ImportRequest(BaseModel):
    root_path: str
    name: str | None = None
    tech_stack: str | None = None
    enable_agents: bool = True
    enable_skills: bool = False
    enable_commands: bool = False
    profile_id: int | None = None


class ToggleAgentRequest(BaseModel):
    enabled: bool


@router.post("/projects/preview")
async def post_preview(req: PreviewRequest) -> dict:
    try:
        return project_scanner_service.scan_to_dict(req.root_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/projects")
async def post_import(req: ImportRequest) -> dict:
    db = await get_db()
    try:
        return await project_import_service.import_project(
            db,
            root_path=req.root_path,
            name=req.name,
            tech_stack=req.tech_stack,
            enable_agents=req.enable_agents,
            enable_skills=req.enable_skills,
            enable_commands=req.enable_commands,
            profile_id=req.profile_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/projects/{project_id}/rescan")
async def post_rescan(project_id: int) -> dict:
    db = await get_db()
    try:
        return await project_import_service.rescan_project(db, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.patch("/projects/{project_id}/agents/{agent_id}")
async def patch_agent(project_id: int, agent_id: int, req: ToggleAgentRequest) -> dict:
    db = await get_db()
    cur = await db.execute(
        "UPDATE project_agents SET enabled = ? WHERE id = ? AND project_id = ?",
        (int(req.enabled), agent_id, project_id),
    )
    await db.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="agent not found")
    regen = await command_center_service.regenerate_workspace_links(db)
    return {"ok": True, "links_regenerated": regen["total"]}


@router.patch("/projects/{project_id}/skills/{skill_id}")
async def patch_skill(project_id: int, skill_id: int, req: ToggleAgentRequest) -> dict:
    db = await get_db()
    cur = await db.execute(
        "UPDATE project_skills SET enabled = ? WHERE id = ? AND project_id = ?",
        (int(req.enabled), skill_id, project_id),
    )
    await db.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="skill not found")
    regen = await command_center_service.regenerate_workspace_links(db)
    return {"ok": True, "links_regenerated": regen["total"]}


@router.patch("/projects/{project_id}/commands/{command_id}")
async def patch_command(
    project_id: int, command_id: int, req: ToggleAgentRequest
) -> dict:
    db = await get_db()
    cur = await db.execute(
        "UPDATE project_commands SET enabled = ? WHERE id = ? AND project_id = ?",
        (int(req.enabled), command_id, project_id),
    )
    await db.commit()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="command not found")
    regen = await command_center_service.regenerate_workspace_links(db)
    return {"ok": True, "links_regenerated": regen["total"]}


@router.get("/projects/{project_id}/skills")
async def list_project_skills(project_id: int) -> list[dict]:
    db = await get_db()
    cur = await db.execute(
        "SELECT id, name, canonical_path, link_path, link_type, enabled, verify_status "
        "FROM project_skills WHERE project_id = ? ORDER BY name",
        (project_id,),
    )
    cols = [
        "id",
        "name",
        "canonical_path",
        "link_path",
        "link_type",
        "enabled",
        "verify_status",
    ]
    return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.get("/projects/{project_id}/commands")
async def list_project_commands(project_id: int) -> list[dict]:
    db = await get_db()
    cur = await db.execute(
        "SELECT id, name, canonical_path, link_path, link_type, enabled, verify_status "
        "FROM project_commands WHERE project_id = ? ORDER BY name",
        (project_id,),
    )
    cols = [
        "id",
        "name",
        "canonical_path",
        "link_path",
        "link_type",
        "enabled",
        "verify_status",
    ]
    return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.get("/projects")
async def list_projects_with_agents() -> list[dict]:
    """List imported projects (excluding workspace) with agent counts and profile_id."""
    db = await get_db()
    cur = await db.execute(
        """SELECT p.id, p.name, p.root_path, p.git_remote, p.tech_stack, p.is_active,
                  p.imported_at, p.last_scanned_at, p.profile_id,
                  (SELECT COUNT(*) FROM project_agents WHERE project_id = p.id) AS agent_count,
                  (SELECT COUNT(*) FROM project_agents WHERE project_id = p.id AND enabled = 1) AS enabled_count
             FROM projects p
            WHERE p.is_workspace = 0
              AND p.root_path IS NOT NULL
            ORDER BY p.imported_at DESC"""
    )
    cols = [
        "id",
        "name",
        "root_path",
        "git_remote",
        "tech_stack",
        "is_active",
        "imported_at",
        "last_scanned_at",
        "profile_id",
        "agent_count",
        "enabled_count",
    ]
    return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.get("/projects/{project_id}/agents")
async def list_project_agents(project_id: int) -> list[dict]:
    db = await get_db()
    cur = await db.execute(
        """SELECT id, name, description, model, canonical_path, link_path,
                  link_type, enabled, has_name_mismatch, verify_status
             FROM project_agents WHERE project_id = ? ORDER BY name""",
        (project_id,),
    )
    cols = [
        "id",
        "name",
        "description",
        "model",
        "canonical_path",
        "link_path",
        "link_type",
        "enabled",
        "has_name_mismatch",
        "verify_status",
    ]
    return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.post("/projects/{project_id}/agents/{agent_id}/promote")
async def promote_agent(project_id: int, agent_id: int) -> dict[str, Any]:
    """Promote a project-level agent into the org shared set.

    Creates a symlink from ORG_AGENTS_DIR pointing at the agent's canonical
    file, inserts an org_agents row with source='promoted', and regenerates
    workspace links so the agent is immediately available in all sessions.

    Idempotent: if the agent is already promoted the existing row is returned
    with ``already_existed=true``.

    Response shape::

        {
          "org_agent": {
            "id": int,
            "name": str,
            "display_name": str | null,
            "description": str | null,
            "model": str | null,
            "install_path": str,
            "link_path": str,
            "source": "promoted",
            "enabled": 1,
            "verify_status": "ok"
          },
          "already_existed": bool,
          "regen": {
            "total": int,
            "counts": {...},
            "failed": [...]
          }
        }

    Errors:
        400 — name collides with an existing bundled org agent.
        404 — project_id / agent_id not found.
    """
    db = await get_db()
    try:
        return await command_center_service.promote_agent_to_org(
            db, project_id, agent_id
        )
    except ValueError as exc:
        msg = str(exc)
        status = 404 if "not found" in msg else 400
        raise HTTPException(status_code=status, detail=msg)


@router.get("/onboarding")
async def get_onboarding_state() -> dict:
    """Return ``{"completed": bool}`` from the workspace_state table."""
    from app.services import workspace_state_service as ws_state

    db = await get_db()
    val = await ws_state.get(db, "onboarding_completed")
    return {"completed": val == "true"}


@router.post("/onboarding/complete")
async def complete_onboarding() -> dict:
    """Mark Command Center onboarding as complete.

    Also re-runs bootstrap (idempotent) so provider-bound profiles, the default
    grouping profile, and workspace symlinks created/changed during onboarding
    are reconciled immediately — without waiting for the next sidecar restart.
    """
    from app.services import command_center_service
    from app.services import workspace_state_service as ws_state

    db = await get_db()
    await ws_state.set(db, "onboarding_completed", "true")
    # Reconcile is best-effort; never let its failure block onboarding.
    try:
        await command_center_service.bootstrap(db, force=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning("onboarding-complete bootstrap failed (continuing): %s", exc)
    return {"completed": True}


@router.post("/factory-reset")
async def factory_reset() -> dict:
    """Wipe all user data and reset onboarding so the next launch starts fresh.

    Deletes every row from all user-data tables (projects, tasks, agents,
    sessions, settings, workspace_state, …) then re-runs bootstrap so the DB
    is in the same state as a brand-new install — with the onboarding_completed
    flag absent (reads as false).  The sidecar stays up; the frontend is
    expected to navigate to /onboarding after receiving the 200 response.
    """
    db = await get_db()

    # Tables to wipe — ordered to respect FK constraints (children before parents).
    # workspace_state is wiped so onboarding_completed is cleared.
    tables = [
        # deepest dependents first
        "session_project_costs",
        "agent_events",
        "agent_runs",
        "agent_sessions",
        "project_agents",
        "project_skills",
        "project_commands",
        "org_agents",
        "mcp_server_project_scopes",
        "mcp_servers",
        "agent_launch_overrides",
        "notifications",
        "schedule_runs",
        "schedules",
        "parallel_run_attempts",
        "parallel_runs",
        "marketplace_installs",
        "launch_presets",
        "launch_source_overrides",
        "provider_models",
        "providers",
        "budget_threshold_alerts",
        "budgets",
        "activity_log",
        "task_blockers",
        "attachments",
        "insight_runs",
        "tasks",
        "workflow_items",
        "documents",
        "members",
        "preview_visits",
        "library_items",
        "sync_snapshots",
        "sync_targets",
        "plugins",
        "workspaces",
        "taxonomies",
        "integration_catalog",
        "profiles",
        "projects",
        "app_settings",
        "workspace_state",
    ]
    for table in tables:
        try:
            await db.execute(f"DELETE FROM {table}")
        except Exception as exc:  # noqa: BLE001
            # A table may not exist in an older DB version — tolerate that
            # gracefully but log it so silent failures are no longer invisible.
            logger.warning("factory_reset: DELETE FROM %s failed: %s", table, exc)
    await db.commit()

    # Restore the seeded reference data (app_settings, taxonomies, workspaces,
    # integration_catalog, and the Unassigned sentinel project) that the wipe
    # just deleted.  providers / provider_models
    # / profiles are intentionally NOT reseeded — post-reset those tables must
    # be empty (=0) so onboarding starts completely clean.
    await command_center_service.reseed_reference_data(db)

    # Re-run bootstrap to recreate workspace dirs, reinstall org agents, and
    # seed the Command Center workspace project row — identical to first-run state.
    await command_center_service.bootstrap(db, force=True)

    return {"ok": True}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int) -> dict:
    db = await get_db()
    row = await (
        await db.execute(
            "SELECT is_workspace FROM projects WHERE id = ?", (project_id,)
        )
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="project not found")
    if row[0]:
        raise HTTPException(
            status_code=400, detail="cannot delete the workspace project"
        )
    # Use the shared service so tasks/workflow items are reassigned to
    # "Unassigned" and agent_sessions.project_id is nullified before the row
    # is deleted (avoids FK violation when tasks reference this project).
    await project_service.delete_project(db, project_id)
    regen = await command_center_service.regenerate_workspace_links(db)
    return {"deleted": True, "links_regenerated": regen["total"]}
