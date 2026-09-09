"""Agent Command Center router.

Receives Claude Code hook payloads, exposes a small read API, streams live updates
via Server-Sent Events, and renders the Command Center page.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from app.database import get_db
from app.models.session_hud import PaneHud
from app.routers._http import read_json_body
from app.services import (
    agent_runs_service,
    agent_service,
    budget_service,
    cwd_resolver_service,
    event_retention_service,
    session_backfill_service,
    session_hud_service,
)

router = APIRouter()
log = logging.getLogger(__name__)

# Always return continue=true so Claude never blocks if our DB is misbehaving
_OK = {"continue": True}


# ─── Hook ingest ─────────────────────────────────────────────────────────────


async def _safe_handle(handler, payload: dict) -> None:
    db = None
    try:
        db = await get_db()
        await handler(db, payload)
    except Exception:
        log.exception("agent hook handler %s failed", handler.__name__)
        # Roll back any partial, uncommitted writes so they can't leak into the
        # next handler's commit on this shared connection.
        if db is not None:
            try:
                await db.rollback()
            except Exception:
                log.exception("rollback after failed agent hook handler failed")


@router.post("/api/v1/hooks/session-start")
async def hook_session_start(request: Request):
    payload = await _read_json(request)
    await _safe_handle(agent_service.record_session_start, payload)
    # Budget hard-stop. Only deliberate over-limit denials
    # surface here; DB errors continue to return continue=True so Claude
    # is never blocked by a broken sidecar.
    try:
        db = await get_db()
        project_id = payload.get("project_id")
        if not isinstance(project_id, int):
            project_id = None
        profile = (
            payload.get("profile") if isinstance(payload.get("profile"), str) else None
        )
        allow, reason = await budget_service.check_hard_stop(db, project_id, profile)
        if not allow:
            return JSONResponse({"continue": False, "reason": reason})
    except Exception:
        log.exception("budget hard-stop check failed; allowing session")
    return JSONResponse(_OK)


@router.post("/api/v1/hooks/user-prompt")
async def hook_user_prompt(request: Request):
    payload = await _read_json(request)
    await _safe_handle(agent_service.record_user_prompt, payload)
    return JSONResponse(_OK)


@router.post("/api/v1/hooks/pre-tool")
async def hook_pre_tool(request: Request):
    payload = await _read_json(request)
    await _safe_handle(agent_service.record_pre_tool, payload)
    return JSONResponse(_OK)


@router.post("/api/v1/hooks/post-tool")
async def hook_post_tool(request: Request):
    payload = await _read_json(request)
    await _safe_handle(agent_service.record_post_tool, payload)
    return JSONResponse(_OK)


@router.post("/api/v1/hooks/stop")
async def hook_stop(request: Request):
    payload = await _read_json(request)
    await _safe_handle(agent_service.record_stop, payload)
    return JSONResponse(_OK)


@router.post("/api/v1/hooks/session-end")
async def hook_session_end(request: Request):
    payload = await _read_json(request)
    await _safe_handle(agent_service.record_session_end, payload)
    return JSONResponse(_OK)


async def _read_json(request: Request) -> dict:
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        body = await request.body()
        try:
            return json.loads(body or b"{}")
        except Exception:  # noqa: BLE001
            return {}


# ─── Command Center aggregate ────────────────────────────────────────────────


@router.get("/api/v1/command-center")
async def api_command_center():
    db = await get_db()

    counts_row = await db.execute(
        "SELECT "
        "  SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active,"
        "  SUM(CASE WHEN status='idle' THEN 1 ELSE 0 END) as idle,"
        "  SUM(CASE WHEN status='ended' OR status='stopped' THEN 1 ELSE 0 END) as ended,"
        "  COUNT(*) as total "
        "FROM agent_sessions"
    )
    counts = await counts_row.fetchone()

    proj_rows = await db.execute("SELECT id, name, path FROM projects ORDER BY name")
    projects = await proj_rows.fetchall()

    inbox_row = await db.execute(
        "SELECT COUNT(*) as cnt FROM workflow_items WHERE status = 'inbox'"
    )
    inbox_r = await inbox_row.fetchone()

    return JSONResponse(
        {
            "counts": {
                "active": counts["active"] or 0 if counts else 0,
                "idle": counts["idle"] or 0 if counts else 0,
                "ended": counts["ended"] or 0 if counts else 0,
                "total": counts["total"] or 0 if counts else 0,
            },
            "projects": [dict(p) for p in projects],
            "inbox_count": inbox_r["cnt"] if inbox_r else 0,
        }
    )


# ─── Read API ────────────────────────────────────────────────────────────────


@router.get("/api/v1/agents")
async def api_list_agents():
    db = await get_db()
    agents = await agent_service.list_with_stats(db, "30d")
    return JSONResponse(agents)


# ─── Event retention (epic #153 / #160) ─────────────────────────────────────
#
# The `agent_events` counterpart to `GET/PUT /api/v1/schedules/retention`:
# same `app_settings` storage, same 1–365 range, same 400 texts — one field
# per class of record instead of one field total. `event_retention_service`
# owns the class list, the default windows and the field names; these two
# handlers only parse and validate.


@router.get("/api/v1/agents/retention")
async def api_get_agent_retention() -> JSONResponse:
    """Return the effective agent-event retention window for every class."""
    db = await get_db()
    days = await event_retention_service.resolve_retention_days(db)
    return JSONResponse(event_retention_service.retention_payload(days))


@router.put("/api/v1/agents/retention")
async def api_set_agent_retention(request: Request) -> JSONResponse:
    """Set one or more agent-event retention windows (1–365 days each).

    Partial writes are accepted — a body naming only `tool_retention_days`
    leaves the other two classes on whatever they were resolving to. The
    response is the full resolved payload either way, so a caller always
    learns the effective policy and not just the part it sent.
    """
    body = await read_json_body(request, 512)

    provided: dict[str, int] = {}
    for cls in event_retention_service.RETENTION_CLASSES:
        field = event_retention_service.field_name(cls.key)
        raw = body.get(field)
        if raw is None:
            continue
        try:
            days = int(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"'{field}' must be an integer")
        if not (1 <= days <= 365):
            raise HTTPException(status_code=400, detail=f"'{field}' must be 1–365")
        provided[cls.key] = days

    if not provided:
        expected = ", ".join(
            f"'{event_retention_service.field_name(c.key)}'"
            for c in event_retention_service.RETENTION_CLASSES
        )
        raise HTTPException(status_code=400, detail=f"one of {expected} is required")

    db = await get_db()
    await event_retention_service.set_retention_days(db, provided)
    effective = await event_retention_service.resolve_retention_days(db)
    return JSONResponse(event_retention_service.retention_payload(effective))


@router.get("/api/v1/agents/{name}/stats")
async def api_agent_stats(name: str, range: str = "30d"):
    if range not in ("7d", "30d", "all"):
        return JSONResponse(
            {"detail": "range must be one of 7d, 30d, all"}, status_code=400
        )
    db = await get_db()
    stats = await agent_service.get_stats(db, name, range)
    return JSONResponse(stats)


@router.get("/api/v1/agents/{name}/invocations")
async def api_agent_invocations(
    name: str,
    range: str = "30d",
    limit: int = 50,
    offset: int = 0,
):
    """Return invocation history attributed to a named agent.

    Attribution matches on ``$.tool_input.subagent_type`` so it works for
    both ``Agent`` and ``Task`` tool events.  Stats and paginated rows are
    returned together; callers pass ``limit=0`` when they only need stats.
    """
    if range not in ("7d", "30d", "all"):
        return JSONResponse(
            {"detail": "range must be one of 7d, 30d, all"}, status_code=400
        )
    db = await get_db()
    stats = await agent_service.get_agent_invocation_stats(db, name, range)
    total, invocations = await agent_service.list_agent_invocations(
        db, name, range, limit, offset
    )
    return JSONResponse({"stats": stats, "invocations": invocations, "total": total})


@router.get("/api/v1/agents/{name}/sessions")
async def api_agent_sessions(name: str, limit: int = 50, offset: int = 0):
    db = await get_db()
    total, sessions = await agent_service.list_sessions_for_agent(
        db, name, limit, offset
    )
    return JSONResponse({"total": total, "sessions": sessions})


@router.get("/api/v1/agents/{name}/events")
async def api_agent_events(name: str, session_id: str, limit: int = 200):
    db = await get_db()
    events = await agent_service.list_events_for_session(db, name, session_id, limit)
    return JSONResponse(events)


@router.get("/api/v1/agents/sessions")
async def api_list_sessions(
    profile: str = "",
    status: str = "",
    limit: int = 100,
    include_ended: bool = False,
    provider_id: int | None = None,
):
    """List sessions. By default excludes 'ended' status for a cleaner live view.

    Pass ``include_ended=true`` or ``status=ended`` to retrieve ended sessions.
    Pass ``provider_id`` to scope to a single AI provider.
    """
    db = await get_db()
    sessions = await agent_service.list_sessions(
        db,
        profile=profile or None,
        status=status or None,
        limit=limit,
        include_ended=include_ended,
        provider_id=provider_id,
    )
    return JSONResponse([dict(s) for s in sessions])


@router.post("/api/v1/agents/sessions/cleanup-stale")
async def api_cleanup_stale_sessions():
    """Force-close any sessions still marked active/idle/stopped.

    Used by the Command Center "Reconcile" action when the dashboard's
    live list doesn't match reality (e.g. Claude Code was closed without
    a clean SessionEnd hook firing). Returns the number of sessions
    transitioned to ``ended`` along with their ids.
    """
    db = await get_db()
    result = await agent_service.cleanup_stale_sessions(db)
    return JSONResponse(result)


@router.post("/api/v1/agents/sessions/backfill-attribution")
async def api_backfill_session_attribution(dry_run: bool = False, force: bool = False):
    """Re-resolve every recorded session's project attribution (#158).

    Attribution is computed once, at hook time, so the history recorded before
    `cwd_resolver_service` shipped keeps whatever the old substring matcher
    said — 70 of 128 live sessions with `project_id NULL`. This pushes every
    row back through the same resolver the hooks use and returns
    ``{scanned, attributed, ephemeral, still_unattributed, created_projects}``.

    ``?dry_run=1`` returns the counts a real run would produce and writes
    nothing. ``?force=1`` re-resolves rows that already have a `project_id`
    and replaces it; without it those rows keep the project they have, which
    is the default because a set value may have been set by hand.

    curl is the interface for P0 — there is no UI trigger. Safe to re-run: a
    second pass finds nothing to change and reports ``attributed=0``.
    """
    db = await get_db()
    result = await session_backfill_service.backfill_session_attribution(
        db, dry_run=dry_run, force=force
    )
    return JSONResponse(result)


@router.get("/api/v1/agents/sessions/ended")
async def api_list_ended_sessions(
    profile: str = "",
    limit: int = 20,
    offset: int = 0,
):
    """Paginated ended-session history.

    Returns ``{items: [...], total: int}`` so the frontend can show
    "Showing X of Y ended" pagination controls.
    """
    db = await get_db()
    total = await agent_service.count_sessions(
        db, profile=profile or None, status="ended"
    )
    sessions = await agent_service.list_sessions(
        db,
        profile=profile or None,
        status="ended",
        limit=limit,
        offset=offset,
        include_ended=True,
    )
    return JSONResponse({"items": [dict(s) for s in sessions], "total": total})


@router.get("/api/v1/agents/recent-events")
async def api_recent_events(
    limit: int = 50,
    provider_id: int | None = None,
):
    """Most-recent cross-session events for the Live Activity ticker."""
    db = await get_db()
    events = await agent_service.list_recent_events(
        db, limit=limit, provider_id=provider_id
    )
    return JSONResponse(events)


@router.get("/api/v1/agents/hud")
async def api_agents_hud():
    """Per-pane session-state facts for the terminal HUD strip (C1).

    Hydration snapshot only — live updates ride the existing SSE stream as the
    additive `hud` field (C2). Always 200, a bare JSON array; a clean database
    returns `[]`. One entry per pane, never two (D5).
    """
    db = await get_db()
    huds = await session_hud_service.list_live_huds(db)
    return JSONResponse([PaneHud.model_validate(h).model_dump() for h in huds])


@router.get("/api/v1/agents/sessions/{session_id}")
async def api_get_session(session_id: str):
    db = await get_db()
    session = await agent_service.get_session(db, session_id)
    if not session:
        return JSONResponse({"error": "not found"}, status_code=404)
    events = await agent_service.get_events(db, session_id, limit=200)
    return JSONResponse({"session": dict(session), "events": [dict(e) for e in events]})


@router.get("/api/v1/agents/sessions/{session_id}/events")
async def api_session_events(session_id: str, limit: int = 200):
    db = await get_db()
    events = await agent_service.get_events(db, session_id, limit=limit)
    return JSONResponse([dict(e) for e in events])


@router.get("/api/v1/agents/sessions/{session_id}/stats")
async def api_session_stats(session_id: str):
    db = await get_db()
    stats = await agent_service.get_session_stats(db, session_id)
    return JSONResponse(stats)


# ─── Launch telemetry ────────────────────────────────────────────────────────


@router.post("/api/v1/agents/events/launch")
async def api_record_launch_event(request: Request):
    """Record a pane-level launch telemetry event.

    1. Publishes a ``kind="launch"`` message to the SSE stream (Live Activity
       ticker depends on this — must remain intact, do NOT remove).
    2. Also persists an ``agent_runs`` row so the unified Agents panel can
       display ALL launched agents regardless of provider.

    The ``pane_id`` field from the frontend is the PTY handle UUID; it is used
    for Focus/Stop and liveness tracking via ``pty-exited``.

    The ``session_id`` field (if present) was generated by the dashboard at
    launch and injected into the Claude command via ``--session-id``.  Non-Claude
    providers omit the placeholder — those runs have ``session_id=None``.
    """
    payload = await _read_json(request)
    # ── 1. SSE publish (must stay; Live Activity depends on it) ──────────────
    agent_service._publish({"kind": "launch", "event": payload})

    # ── 2. Persist agent_runs row ────────────────────────────────────────────
    # Resolve provider_id: the frontend sends either a numeric provider_id or
    # a string provider name (legacy path).  We accept both gracefully.
    raw_provider = payload.get("provider")
    provider_id: int | None = None
    if isinstance(raw_provider, int):
        provider_id = raw_provider
    elif isinstance(raw_provider, str) and raw_provider:
        try:
            db = await get_db()
            row = await db.execute(
                "SELECT id FROM providers WHERE name = ? OR display_name = ?",
                (raw_provider, raw_provider),
            )
            r = await row.fetchone()
            if r:
                provider_id = r["id"]
        except Exception:  # noqa: BLE001, S110
            pass

    project_id = payload.get("project_id")
    if not isinstance(project_id, int):
        project_id = None

    # An agent pane sends `cwd` instead of a project id (it has no project
    # lookup of its own), so resolve one here rather than letting the row read
    # as project "unknown". An explicit project_id always wins.
    #
    # Through `cwd_resolver_service` — the one cwd→project code path — so a
    # pane and the session it starts agree on the answer, including the walk
    # up to the git repo root that a pane opened in a monorepo subdirectory
    # needs. `allow_discovery=False`: launching a pane must never grow the
    # project list, that stays a decision the session's own hooks make.
    if project_id is None:
        raw_cwd = payload.get("cwd")
        if isinstance(raw_cwd, str) and raw_cwd:
            try:
                db = await get_db()
                resolution = await cwd_resolver_service.resolve(
                    db, raw_cwd, allow_discovery=False
                )
                project_id = resolution.project_id
            except Exception:
                log.exception("project resolution from cwd failed (non-fatal)")

    source_id_raw = payload.get("source_id")
    source_id: int | None = (
        int(source_id_raw) if isinstance(source_id_raw, (int, float)) else None
    )

    prompt_raw = payload.get("prompt_preview") or payload.get("prompt")
    prompt_preview: str | None = str(prompt_raw)[:120] if prompt_raw else None

    # session_id was generated by the frontend before launch and passed here.
    session_id: str | None = payload.get("session_id") or None

    pane_id: str | None = payload.get("pane_id") or None

    profile: str | None = payload.get("profile") or None
    if isinstance(profile, str) and profile.strip():
        profile = profile.strip()
    else:
        profile = None

    raw_target = payload.get("target")
    target: str | None = (
        raw_target
        if isinstance(raw_target, str) and raw_target in ("embedded", "popout")
        else None
    )

    try:
        db = await get_db()
        await agent_runs_service.persist_on_launch(
            db,
            session_id=session_id,
            provider_id=provider_id,
            project_id=project_id,
            pane_id=pane_id,
            model=payload.get("model") or None,
            prompt_preview=prompt_preview,
            source_kind=payload.get("source_kind") or None,
            source_id=source_id,
            profile=profile,
            target=target,
        )
    except Exception:
        log.exception("agent_runs persist_on_launch failed (non-fatal)")

    return JSONResponse({"ok": True})


@router.post("/api/v1/agents/runs/exited")
async def api_run_exited(request: Request):
    """Mark the ``agent_runs`` row for a pane as ended.

    Called by the frontend when it receives a ``pty-exited`` Tauri event for
    a pane that was used to launch an agent.  This is the liveness sink for
    all providers — no provider-specific hooks required.

    ``close_terminal`` IPC → Rust fires ``pty-exited`` → frontend calls this
    endpoint → run transitions to ``status='ended'``.  The "Stop" action in
    the UI follows the same path: ``close_terminal(pane_id)`` → ``pty-exited``
    → here.
    """
    payload = await _read_json(request)
    pane_id = payload.get("pane_id") or ""
    exit_code_raw = payload.get("exit_code")
    exit_code: int | None = (
        int(exit_code_raw) if isinstance(exit_code_raw, (int, float)) else None
    )
    # Optional: an agent pane knows which session ended, and a pane id alone
    # cannot tell one run from its restarted replacement.
    session_id: str | None = payload.get("session_id") or None

    if not pane_id:
        return JSONResponse({"ok": True, "updated": 0})

    try:
        db = await get_db()
        updated = await agent_runs_service.mark_ended_by_pane(
            db, pane_id, exit_code, session_id
        )
    except Exception:
        log.exception("agent_runs mark_ended_by_pane failed")
        updated = 0

    return JSONResponse({"ok": True, "updated": updated})


@router.get("/api/v1/agents/runs")
async def api_list_runs(
    provider_id: int | None = None,
    status: str | None = None,
    profile: str | None = None,
    limit: int = 100,
):
    """Return the unified agents list.

    Includes both dashboard-launched ``agent_runs`` rows (any provider) and
    observe-only ``agent_sessions`` that are not linked to any run row
    (external / hook-driven Claude sessions).
    """
    db = await get_db()
    runs = await agent_runs_service.list_runs(
        db,
        limit=limit,
        provider_id=provider_id,
        status=status or None,
        profile=profile or None,
    )
    return JSONResponse(runs)


# ─── Launch (Warp) ───────────────────────────────────────────────────────────


@router.post("/api/v1/agents/launch")
async def api_launch(request: Request):
    payload = await _read_json(request)
    work = max(0, int(payload.get("work", 0) or 0))
    personal = max(0, int(payload.get("personal", 0) or 0))
    if work == 0 and personal == 0:
        return JSONResponse(
            {"error": "specify at least one of work or personal"}, status_code=400
        )
    if work > 12 or personal > 12:
        return JSONResponse({"error": "max 12 sessions per profile"}, status_code=400)

    db = await get_db()

    async def _resolve_cwd(project_id) -> str:
        fallback = os.path.expanduser("~")
        if not project_id:
            return fallback
        try:
            row = await db.execute(
                "SELECT path FROM projects WHERE id = ?", (int(project_id),)
            )
            r = await row.fetchone()
            if r and r["path"]:
                p = r["path"].rstrip("/")
                if p == "." or p == "":
                    return fallback
                if p.startswith("/"):
                    return p
                return os.path.join(fallback, p)
        except Exception:  # noqa: BLE001, S110
            pass
        return fallback

    work_cwd = await _resolve_cwd(payload.get("work_project_id"))
    personal_cwd = await _resolve_cwd(payload.get("personal_project_id"))

    prow = await db.execute(
        "SELECT name, claude_config_dir FROM profiles "
        "WHERE claude_config_dir IS NOT NULL AND claude_config_dir != '' "
        "ORDER BY created_at ASC, id ASC"
    )
    profile_rows = [dict(r) for r in await prow.fetchall()]

    from datetime import datetime

    name = f"codenest-agents-{datetime.now().strftime('%Y%m%d-%H%M%S')}"  # noqa: DTZ005
    yaml_text = agent_service.build_warp_launch_yaml(
        name=name,
        work_count=work,
        personal_count=personal,
        work_cwd=work_cwd,
        personal_cwd=personal_cwd,
        profiles=profile_rows,
    )
    path = agent_service.write_warp_launch_config(name, yaml_text)

    from urllib.parse import quote

    launch_url = f"warp://launch/{quote(name, safe='')}"
    return JSONResponse(
        {
            "name": name,
            "url": launch_url,
            "yaml_path": str(path),
            "work": work,
            "personal": personal,
            "work_cwd": work_cwd,
            "personal_cwd": personal_cwd,
        }
    )


# ─── SSE stream ──────────────────────────────────────────────────────────────


@router.get("/api/v1/agents/stream")
async def stream():
    async def gen() -> AsyncGenerator[bytes, None]:
        q = agent_service.subscribe()
        try:
            yield b": connected\n\n"
            # Send a full snapshot on connection so the browser can reconcile
            # any drift from missed delta events (e.g., SSE reconnect after a
            # uvicorn reload or queue overflow).
            try:
                db = await get_db()
                sessions = await agent_service.list_sessions(db)
                hud = await session_hud_service.list_live_huds(db)
                snapshot = {
                    "kind": "snapshot",
                    "sessions": [dict(s) for s in sessions],
                    "hud": hud,
                }
                payload = json.dumps(snapshot, default=str)
                yield f"event: snapshot\ndata: {payload}\n\n".encode()
            except Exception:
                log.exception("failed to send SSE snapshot")

            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15.0)
                    payload = json.dumps(msg, default=str)
                    yield f"event: {msg.get('kind', 'update')}\ndata: {payload}\n\n".encode()
                except asyncio.TimeoutError:
                    yield b": ping\n\n"
        finally:
            agent_service.unsubscribe(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/api/v1/agents/runs/reconcile")
async def api_reconcile_runs(request: Request):
    """End every ``running`` run whose pane the shell no longer holds a child for.

    The self-heal for the leak class no per-event report can cover: a popout
    window torn down before its report left the webview, the app quitting or
    crashing, or a sidecar that was unreachable at that moment. The row would
    otherwise claim the session is live forever, with a Focus and a Stop that act
    on nothing.

    ``live_pane_ids`` comes from the Rust shell's ``list_live_panes`` command —
    it owns the child processes, so it is the only component that can answer
    truthfully. An absent or non-list value is rejected rather than treated as
    "nothing is alive", which would end every running run in the table.
    """
    payload = await _read_json(request)
    raw = payload.get("live_pane_ids")
    if not isinstance(raw, list):
        return JSONResponse(
            {"ok": False, "error": "live_pane_ids must be a list"}, status_code=400
        )
    live = [str(p) for p in raw if isinstance(p, str)]

    try:
        db = await get_db()
        ended = await agent_runs_service.reconcile_running_runs(db, live)
    except Exception:
        log.exception("agent_runs reconcile failed")
        ended = 0

    return JSONResponse({"ok": True, "ended": ended})
