import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .database import close_db, get_db, init_db

if TYPE_CHECKING:
    import aiosqlite

_APP_VERSION = "0.1.0"

logger = logging.getLogger(__name__)

_PARENT_WATCHDOG_INTERVAL = 2.0

# Wake the schedule tick this often. Cron resolution is 1 minute, but we
# poll faster so a freshly-created rule fires in ≤30 s rather than ≤60.
_SCHEDULE_TICK_SECONDS = 30.0

# Insights tick. The job is once-per-UTC-day; we wake every 5 min
# only to ensure it fires soon after a sidecar restart that crosses a
# UTC midnight. The insight_runs PK is the actual dedup.
_INSIGHTS_TICK_SECONDS = 300.0


_PRUNE_TICK_SECONDS = 86_400.0  # once per day

# Lane C transcript scan (#167). Deliberately *not* `_PRUNE_TICK_SECONDS`:
# the prunes delete aged rows, so a day of lateness costs nothing, whereas
# this scan is what fills `source_app`, `cli_version`, `git_branch` and
# `session_kind` on sessions that already exist. On the daily cadence a
# session started just after a pass would render `unknown` across every P1
# surface for up to 24 h, which is the exact gap #167 was filed to close.
# Five minutes is the shortest cadence whose steady-state cost is still
# nil: a drained pass is one `stat()` per transcript (~200 files here) and
# no I/O beyond it, because `_resume_offset` short-circuits every file
# whose size and mtime are unchanged.
_TRANSCRIPT_SCAN_TICK_SECONDS = 300.0


def _transcript_scan_interval_ticks() -> int:
    """`_TRANSCRIPT_SCAN_TICK_SECONDS` expressed in schedule ticks (min 1)."""
    return max(1, int(_TRANSCRIPT_SCAN_TICK_SECONDS / _SCHEDULE_TICK_SECONDS))


async def _transcript_scan_tick(db: "aiosqlite.Connection", tick_count: int) -> int:
    """Run one bounded Lane C scan pass; return the tick the next one is due at.

    Returning the next due tick rather than a bare bool is what implements the
    drain rule. A pass is capped at `SCAN_MAX_FILES_PER_PASS` (25) files and
    `SCAN_MAX_BYTES_PER_PASS` (32 MB), so a backlog cannot clear in one call.
    When the pass both scanned something and left something over we ask for the
    *next* tick (30 s) instead of a full interval, so a cold start drains at
    ~25 files per 30 s rather than 25 per 5 min; otherwise the cadence falls
    back to the interval. The bound stays the thing protecting the loop's
    responsiveness — we are only declining to idle while work is demonstrably
    moving.

    One honest limit on that signal: only the FILE bound reports its remainder
    as `files_deferred` (`transcript_scanner_service` counts candidates the
    pass never reached). The byte bound does not — a single file carrying more
    than 32 MB of new bytes, as the only candidate, returns `files_deferred=0`
    with work still left, and the loop then waits a full interval instead of
    coming straight back. That is slower than ideal but never wrong: the file
    keeps its byte offset, so the next pass resumes exactly where this one
    stopped. Do not "fix" it by treating `bytes_read` as a drain signal — a
    pass that read its cap because it finished the file is indistinguishable
    from one that stopped short, and guessing would reintroduce the every-30s
    hot path described below.

    Isolation matches the two prunes above it: any exception is logged at
    warning and swallowed, because a scanner fault must never stop cron
    schedules from firing. On that path we back off a full interval rather
    than retrying next tick — a scanner that is failing is not draining, and
    retrying it every 30 s would only multiply the log line.

    The `CODENEST_DISABLE_SCHEDULE_TICK=1` check is repeated here even though
    the loop that calls it is already gated on the same variable, for the
    reason `event_retention_service.prune_agent_events_if_enabled` gives: the
    guard should belong to the job, so nothing can wire this into a new caller
    and quietly start writing to a test's database.

    The attribution backfill (#158) is deliberately *not* called from here, on
    any trigger. It can create `projects` rows, and a background job that mints
    projects because a transcript mentioned an unfamiliar `cwd` is a different
    risk class from one that fills columns on rows a human already created:
    the scan's worst failure is stale metadata, the backfill's is durable
    invented state in a surface the user curates. It stays manual at
    `POST /api/v1/agents/sessions/backfill-attribution`, where a person sees
    what it proposes to create.
    """
    if os.environ.get("CODENEST_DISABLE_SCHEDULE_TICK") == "1":
        return tick_count + _transcript_scan_interval_ticks()

    try:
        # Imported inside the guard, like the loop's other service imports, so
        # a broken scanner module is one more caught failure rather than an
        # exception escaping past this function's isolation.
        from .services import transcript_scanner_service

        result = await transcript_scanner_service.scan_transcripts(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("transcript scan failed (continuing): %s", exc)
        return tick_count + _transcript_scan_interval_ticks()

    scanned = result.get("files_scanned", 0)
    deferred = result.get("files_deferred", 0)
    # Silence on a drained pass is a requirement, not an optimisation: the
    # steady state on this machine is files_scanned=0, files_up_to_date=200,
    # files_deferred=0, and at a five-minute cadence a summary line there
    # would be ~288 identical entries a day. `files_failed` deliberately does
    # not open the gate on its own — an unreadable file keeps its offset and
    # so fails again on every subsequent pass, which would reintroduce exactly
    # that per-interval spam; the error is recorded durably in
    # `transcript_scan_state.last_error` and surfaced by the scan endpoint.
    if scanned:
        logger.info(
            "transcript scan: files_scanned=%d, sessions_updated=%d, "
            "sessions_unmatched=%d, files_failed=%d, files_deferred=%d",
            scanned,
            result.get("sessions_updated", 0),
            result.get("sessions_unmatched", 0),
            result.get("files_failed", 0),
            deferred,
        )
    # Come back next tick only when the pass actually MOVED — `scanned and
    # deferred`, not `deferred` alone.
    #
    # `deferred` on its own is not evidence of progress, and treating it as
    # such opens a hot path through the door the failure gate was built to
    # shut: more than SCAN_MAX_FILES_PER_PASS files that stat but cannot be
    # opened means every pass scans 0, fails 25 and defers the rest, so
    # `deferred` never reaches 0 and the scan re-runs every 30 s forever.
    # Requiring `scanned` makes a stuck backlog back off to the full interval
    # and, with the log gated on `scanned` too, makes it silent — the failure
    # is still recorded durably per file in `transcript_scan_state.last_error`
    # and surfaced by the scan endpoint, which is where a human should read it
    # rather than out of 2,880 identical log lines a day.
    return tick_count + (
        1 if (scanned and deferred) else _transcript_scan_interval_ticks()
    )


async def _schedule_tick_loop() -> None:
    """Wake every `_SCHEDULE_TICK_SECONDS` and fire any due cron schedules."""
    import asyncio as _asyncio

    from .database import get_db
    from .services import event_retention_service, mcp_servers_service, schedule_service

    tick_count = 0
    # Tick at which the next Lane C scan is due. Starts at 0 so the first
    # pass runs at startup, the same cadence the prunes below use; thereafter
    # `_transcript_scan_tick` decides — next tick while a backlog remains,
    # a full interval once it is drained.
    next_scan_tick = 0
    while True:
        try:
            db = await get_db()
            fired = await schedule_service.tick(db)
            if fired:
                logger.info("schedule tick fired %d rule(s)", fired)
            # Backstop: time out any run wedged at `running` past its deadline
            # (e.g. the Rust shell died after start without reporting finish).
            swept = await schedule_service.sweep_stale_runs(db)
            if swept:
                logger.warning("schedule tick swept %d stale run(s)", swept)
            # GC stale MCP config temp files.
            removed = mcp_servers_service.cleanup_old_mcp_configs()
            if removed:
                logger.debug("mcp config gc: removed %d stale file(s)", removed)
            # Transcript blob prune: run on startup (tick_count==0) and
            # then once every ~24 h (approximately _PRUNE_TICK_SECONDS /
            # _SCHEDULE_TICK_SECONDS ticks).
            prune_interval = max(1, int(_PRUNE_TICK_SECONDS / _SCHEDULE_TICK_SECONDS))
            if tick_count % prune_interval == 0:
                try:
                    result = await schedule_service.prune_transcript_blobs(db)
                    if result["files_deleted"] or result["rows_cleared"]:
                        logger.info("transcript prune: %s", result)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("transcript prune failed (continuing): %s", exc)
                # Agent-event prune (#160). Same daily cadence and the same
                # "log and carry on" isolation as the transcript prune: the
                # tick must keep firing schedules even if retention fails.
                # Rows only — sessions are never deleted, and the DB file
                # does not shrink (no VACUUM).
                try:
                    events = (
                        await event_retention_service.prune_agent_events_if_enabled(db)
                    )
                    if events and events["rows_deleted"]:
                        logger.info("agent event prune: %s", events["classes"])
                except Exception as exc:  # noqa: BLE001
                    logger.warning("agent event prune failed (continuing): %s", exc)
            # Lane C transcript scan (#167) — its own interval, and its own
            # exception isolation inside `_transcript_scan_tick`.
            if tick_count >= next_scan_tick:
                next_scan_tick = await _transcript_scan_tick(db, tick_count)
        except _asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("schedule tick error (continuing): %s", exc)
        tick_count += 1
        await _asyncio.sleep(_SCHEDULE_TICK_SECONDS)


async def _insights_tick_loop() -> None:
    """Wake every `_INSIGHTS_TICK_SECONDS` and run the daily insight job.

    ``generate_and_publish`` is idempotent per (rule, UTC day) via the
    ``insight_runs`` PK, so it's safe — and necessary — to re-evaluate
    every tick: a rule that found no candidate this morning may have
    one this afternoon, and we want that card to land same-day.
    """
    import asyncio as _asyncio

    from .database import get_db
    from .services import insights_service

    while True:
        try:
            db = await get_db()
            published = await insights_service.generate_and_publish(db)
            if published:
                logger.info("insights tick published %d card(s)", len(published))
        except _asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("insights tick error (continuing): %s", exc)
        await _asyncio.sleep(_INSIGHTS_TICK_SECONDS)


async def _watch_parent_pid(parent_pid: int) -> None:
    """Exit the sidecar when the Tauri shell that spawned us is gone.

    Belt-and-suspenders complement to the Rust-side `SidecarManager`
    shutdown path. If the Rust shell exits cleanly it kills us first; if
    it crashes / is SIGKILLed / loses power, the next `kill(parent_pid, 0)`
    raises ProcessLookupError and we self-terminate so we never leak
    uvicorn holding :8002 across launches.
    """
    while True:
        try:
            os.kill(parent_pid, 0)
        except ProcessLookupError:
            logger.warning(
                "parent PID %s is gone; sidecar self-terminating to avoid orphaning :8002",
                parent_pid,
            )
            os._exit(0)
        except PermissionError:
            pass
        await asyncio.sleep(_PARENT_WATCHDOG_INTERVAL)


def create_app() -> FastAPI:
    schedule_task: asyncio.Task | None = None  # type: ignore[type-arg]
    insights_task: asyncio.Task | None = None  # type: ignore[type-arg]

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal schedule_task, insights_task

        from .config import settings as _settings

        logger.info(
            "sidecar db: env=%s frozen=%s path=%s",
            _settings.ENV,
            bool(getattr(sys, "frozen", False)),
            _settings.DATABASE_PATH,
        )
        await init_db()

        # NOTE: the Command Center bootstrap (dir creation, org-agent
        # install/upgrade, default profile, workspace link regeneration) is the
        # slowest startup step but is NOT required for first paint, so it is
        # deferred to a background task below — this lets /health (and thus the
        # `sidecar_ready` event / the UI) become reachable as soon as migrations
        # finish, shaving the cold-launch delay. It is idempotent.

        # Phase 1 execution bridge: reap any runs that were `running` or `queued`
        # when the sidecar crashed. Must run before the tick loop starts so we
        # don't double-fire a run that was mid-flight during the previous session.
        try:
            from app.services import schedule_service as _sched_svc

            db = await get_db()
            reaped = await _sched_svc.reap_orphaned_runs(db)
            if reaped:
                logger.info(
                    "schedule startup reaper: reaped %d orphaned run(s)", reaped
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("schedule startup reaper failed (continuing): %s", exc)

        # Only attach the watchdog when launched by the Rust shell; running
        # uvicorn standalone (tests, scripts) leaves the env var unset.
        raw = os.environ.get("CODENEST_PARENT_PID")
        if raw and raw.isdigit():
            parent_pid = int(raw)
            asyncio.create_task(_watch_parent_pid(parent_pid))
            logger.info("parent-pid watchdog armed for PID %s", parent_pid)
        # Schedule tick — disable via env for tests that don't
        # want a background loop touching their DB.
        if os.environ.get("CODENEST_DISABLE_SCHEDULE_TICK") != "1":
            schedule_task = asyncio.create_task(_schedule_tick_loop())
            logger.info("schedule tick loop armed (%.1fs)", _SCHEDULE_TICK_SECONDS)
        # Insights tick — same disable env as schedule tick.
        if os.environ.get("CODENEST_DISABLE_SCHEDULE_TICK") != "1":
            insights_task = asyncio.create_task(_insights_tick_loop())
            logger.info("insights tick loop armed (%.1fs)", _INSIGHTS_TICK_SECONDS)

        # Plugin scan — runs in the background so a slow or
        # network-mounted plugins root can't keep /health from going
        # green. Subsequent refreshes are user-triggered via
        # POST /api/v1/plugins/refresh.
        async def _initial_plugin_scan() -> None:
            try:
                from .database import get_db
                from .services import plugin_service

                db = await get_db()
                summary = await plugin_service.scan_and_load(db)
                logger.info("plugin scan: %s", summary)
            except Exception as exc:  # noqa: BLE001
                logger.warning("plugin scan failed at startup (continuing): %s", exc)

        asyncio.create_task(_initial_plugin_scan())

        # Deferred Command Center bootstrap (see note above init_db). Runs after
        # the server is accepting requests so it never blocks /health. Idempotent.
        async def _deferred_bootstrap() -> None:
            try:
                from .services import command_center_service

                db = await get_db()
                result = await command_center_service.bootstrap(db, force=False)
                logger.info("command-center bootstrap (deferred): %s", result)
            except Exception as exc:  # noqa: BLE001
                logger.warning("command-center bootstrap failed (continuing): %s", exc)

        asyncio.create_task(_deferred_bootstrap())

        yield

        for task in (schedule_task, insights_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001, S110
                    pass
        await close_db()

    app = FastAPI(title="Codenest", version=_APP_VERSION, lifespan=lifespan)

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(
        request: Request, exc: Exception
    ) -> JSONResponse:
        # Log the full traceback server-side; return a generic message to the
        # client so internal paths, schema details, or library internals are
        # never leaked over the (unauthenticated) localhost API.
        logger.exception(
            "unhandled exception on %s %s", request.method, request.url.path
        )
        return JSONResponse({"detail": "Internal server error"}, status_code=500)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:1420",  # Vite dev server
            "http://127.0.0.1:1420",
            "tauri://localhost",  # Tauri production
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", tags=["system"])
    async def health() -> dict:
        return {"status": "ok", "version": _APP_VERSION}

    from .routers import (
        agent_overrides,
        agents,
        attachments,
        attention,
        budgets,
        command_center,
        dashboard,
        dashboard_trends,
        documents,
        feed,
        inbox,
        insights,
        integrations,
        intent,
        launch_overrides,
        launch_presets,
        launch_seed,
        library,
        markdown_editor,
        marketplace,
        mcp_servers,
        metrics,
        notifications,
        parallel_runs,
        plugins,
        preview,
        profiles,
        project_discovery,
        projects,
        providers,
        schedules,
        search,
        sessions,
        settings,
        sync,
        system,
        tasks,
        taxonomies,
        team,
        workspace,
    )

    app.include_router(command_center.router)
    app.include_router(attention.router)
    app.include_router(dashboard.router)
    app.include_router(dashboard_trends.router)
    app.include_router(tasks.router)
    app.include_router(inbox.router)
    app.include_router(team.router)
    app.include_router(documents.router)
    app.include_router(projects.router)
    app.include_router(project_discovery.router)
    app.include_router(taxonomies.router)
    app.include_router(markdown_editor.router)
    app.include_router(agents.router)
    app.include_router(sessions.router)
    app.include_router(profiles.router)
    app.include_router(settings.router)
    app.include_router(search.router)
    app.include_router(metrics.router)
    app.include_router(notifications.router)
    app.include_router(providers.router)
    app.include_router(launch_presets.router)
    app.include_router(launch_overrides.router)
    app.include_router(launch_seed.router)
    app.include_router(system.router)
    app.include_router(marketplace.router)
    app.include_router(parallel_runs.router)
    app.include_router(mcp_servers.router)
    app.include_router(mcp_servers.launches_router)
    app.include_router(agent_overrides.router)
    app.include_router(schedules.router)
    app.include_router(intent.router)
    app.include_router(preview.router)
    app.include_router(attachments.router)
    app.include_router(library.router)
    app.include_router(budgets.router)
    app.include_router(feed.router)
    app.include_router(insights.router)
    app.include_router(plugins.router)
    app.include_router(integrations.router)
    app.include_router(sync.router)
    app.include_router(workspace.router)

    return app
