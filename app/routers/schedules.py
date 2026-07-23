"""Schedule rule engine router — Phase 1 execution bridge."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from app.database import get_db
from app.services import schedule_service
from app.services._cron_helpers import (
    CronHelperError,
    describe_cron,
    next_fire_times,
    preset_to_cron,
)

from ._http import read_json_body

# Bound the create-payload — prompt is now TEXT (multiline), still reasonable.
_MAX_BODY = 128 * 1024


router = APIRouter(prefix="/api/v1/schedules")


# ── Schedule CRUD ─────────────────────────────────────────────────────────────


@router.get("")
async def api_list_schedules() -> JSONResponse:
    db = await get_db()
    return JSONResponse({"schedules": await schedule_service.list_schedules(db)})


@router.post("")
async def api_create_schedule(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    kind = body.get("kind")
    if kind not in ("cron", "event", "interval"):
        raise HTTPException(
            status_code=400, detail="'kind' must be 'cron', 'event', or 'interval'"
        )
    enabled_raw = body.get("enabled")
    enabled = enabled_raw if isinstance(enabled_raw, bool) else True
    db = await get_db()
    cron_raw = body.get("cron_expr")
    event_raw = body.get("event_name")

    # Numeric fields — accept int/float or None.
    def _opt_float(key: str) -> float | None:
        v = body.get(key)
        return float(v) if v is not None else None

    def _opt_int(key: str) -> int | None:
        v = body.get(key)
        return int(v) if v is not None else None

    return JSONResponse(
        await schedule_service.create_schedule(
            db,
            name=str(body.get("name") or ""),
            kind=kind,
            cron_expr=cron_raw if isinstance(cron_raw, str) else None,
            event_name=event_raw if isinstance(event_raw, str) else None,
            agent_name=str(body.get("agent_name") or ""),
            prompt=str(body.get("prompt") or ""),
            enabled=enabled,
            interval_seconds=_opt_int("interval_seconds"),
            project_id=_opt_int("project_id"),
            provider_id=_opt_int("provider_id"),
            model=body.get("model") if isinstance(body.get("model"), str) else None,
            run_mode=str(body.get("run_mode") or "background"),
            result_kind=str(body.get("result_kind") or "transcript"),
            permission_mode=str(body.get("permission_mode") or "dontAsk"),
            allowed_tools=body.get("allowed_tools")
            if isinstance(body.get("allowed_tools"), str)
            else None,
            max_budget_usd=_opt_float("max_budget_usd"),
            max_runtime_sec=_opt_int("max_runtime_sec"),
            notify_policy=str(body.get("notify_policy") or "on_failure"),
            artifact_dir=body.get("artifact_dir")
            if isinstance(body.get("artifact_dir"), str)
            else None,
        )
    )


@router.get("/{schedule_id}")
async def api_get_schedule(schedule_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await schedule_service.get_schedule(db, schedule_id))


@router.patch("/{schedule_id}")
async def api_update_schedule(schedule_id: int, request: Request) -> JSONResponse:
    patch = await read_json_body(request, _MAX_BODY)
    db = await get_db()
    return JSONResponse(await schedule_service.update_schedule(db, schedule_id, patch))


@router.delete("/{schedule_id}")
async def api_delete_schedule(schedule_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await schedule_service.delete_schedule(db, schedule_id))


# ── Cron preview helpers (power the builder UI) ───────────────────────────────────


@router.post("/cron-preview")
async def api_cron_preview(request: Request) -> JSONResponse:
    """Convert a preset or raw cron expression to a description + next fire times.

    Request body (all fields optional except one of cron_expr / preset_kind):
    ```json
    {
      "cron_expr": "0 9 * * *",          // raw expression (mutually exclusive with preset)
      "preset_kind": "daily",            // one of 6 preset types
      "hour": 9, "minute": 0,            // used by daily/weekdays/weekly/monthly
      "weekdays": [1, 3, 5],             // used by weekly (0=Sun … 6=Sat)
      "day_of_month": 1,                 // used by monthly
      "every_n_hours": 4,               // used by every_n_hours
      "count": 3                         // how many next-fire times to return
    }
    ```

    Response:
    ```json
    {
      "cron_expr": "0 9 * * *",
      "description": "Every day at 9:00 AM",
      "next_fires": ["2026-06-17T09:00:00", "2026-06-18T09:00:00", ...]
    }
    ```
    """
    body = await read_json_body(request, 4096)
    count = min(int(body.get("count") or 3), 10)

    raw_cron = body.get("cron_expr")
    preset_kind = body.get("preset_kind")

    # "Every N hours" is now an interval schedule (anchored to creation time),
    # not a wall-clock cron. Preview it directly so the builder shows the real
    # "from now" cadence instead of cron's next even-hour boundary.
    if preset_kind == "every_n_hours":
        from datetime import datetime, timedelta

        n = int(body.get("every_n_hours") or 1)
        if n < 1:
            raise HTTPException(status_code=400, detail="every_n_hours must be >= 1")
        interval_seconds = n * 3600
        now = datetime.now()
        fires = [
            now + timedelta(seconds=interval_seconds * (k + 1)) for k in range(count)
        ]
        return JSONResponse(
            {
                "cron_expr": "",
                "interval_seconds": interval_seconds,
                "description": f"Every {n} hour{'s' if n != 1 else ''} (from creation)",
                "next_fires": [
                    dt.isoformat(sep="T", timespec="seconds") for dt in fires
                ],
            }
        )

    try:
        if raw_cron and not preset_kind:
            cron_expr = str(raw_cron).strip()
        elif preset_kind:
            weekdays_raw = body.get("weekdays")
            cron_expr = preset_to_cron(
                preset_kind,
                hour=int(body.get("hour") or 9),
                minute=int(body.get("minute") or 0),
                weekdays=[int(d) for d in weekdays_raw] if weekdays_raw else None,
                day_of_month=int(body.get("day_of_month") or 1),
                every_n_hours=int(body.get("every_n_hours") or 1),
                raw_cron=body.get("raw_cron"),
            )
        else:
            raise HTTPException(
                status_code=400,
                detail="provide 'cron_expr' or 'preset_kind'",
            )

        description = describe_cron(cron_expr)
        fires = next_fire_times(cron_expr, count=count)
    except CronHelperError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return JSONResponse(
        {
            "cron_expr": cron_expr,
            "description": description,
            "next_fires": [dt.isoformat(sep="T", timespec="seconds") for dt in fires],
        }
    )


# ── Run history ───────────────────────────────────────────────────────────────


@router.get("/{schedule_id}/runs")
async def api_list_runs(schedule_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse({"runs": await schedule_service.list_runs(db, schedule_id)})


@router.get("/runs/{run_id}")
async def api_get_run(run_id: int) -> JSONResponse:
    db = await get_db()
    return JSONResponse(await schedule_service.get_run(db, run_id))


# ── Dispatch queue (polled by Rust shell) ─────────────────────────────────────


@router.get("/dispatch/pending")
async def api_pending_dispatches() -> JSONResponse:
    """Return queued schedule runs ready for the Rust shell to launch.

    The Rust shell polls this endpoint every few seconds. Each item contains
    the run metadata (run_id, session_id, trigger) plus the parent schedule's
    launch config (agent_name, prompt, project_id, provider_id, model,
    permission_mode, allowed_tools, max_budget_usd, max_runtime_sec).

    Runs remain in `queued` status until the shell calls
    `POST /schedules/runs/{run_id}/start`.
    """
    db = await get_db()
    items = await schedule_service.claim_pending_dispatches(db)
    return JSONResponse({"pending": items})


# ── Run lifecycle endpoints (called by Rust shell after launch) ───────────────


@router.post("/runs/{run_id}/start")
async def api_start_run(run_id: int) -> JSONResponse:
    """Transition a queued run to `running`. Called by the Rust shell on PTY open."""
    db = await get_db()
    return JSONResponse(await schedule_service.start_run(db, run_id))


@router.post("/runs/{run_id}/finish")
async def api_finish_run(run_id: int, request: Request) -> JSONResponse:
    """Finalize a run after process exit. Called by the Rust shell.

    Request body:
    ```json
    {
      "exit_code": 0,
      "transcript_path": "/path/to/run_id.log",   // optional
      "artifact_path": "/path/to/output.md",       // optional
      "summary_text": "...",                        // optional
      "tokens_in": 1234, "tokens_out": 5678,       // optional
      "cost_usd": 0.042                             // optional
    }
    ```
    """
    body = await read_json_body(request, _MAX_BODY)
    exit_code = body.get("exit_code")
    if not isinstance(exit_code, int):
        raise HTTPException(status_code=400, detail="'exit_code' must be an integer")

    def _opt_int(key: str) -> int | None:
        v = body.get(key)
        return int(v) if v is not None else None

    def _opt_float(key: str) -> float | None:
        v = body.get(key)
        return float(v) if v is not None else None

    def _opt_str(key: str) -> str | None:
        v = body.get(key)
        return str(v) if v is not None else None

    db = await get_db()
    return JSONResponse(
        await schedule_service.finish_run(
            db,
            run_id,
            exit_code=exit_code,
            transcript_path=_opt_str("transcript_path"),
            artifact_path=_opt_str("artifact_path"),
            summary_text=_opt_str("summary_text"),
            tokens_in=_opt_int("tokens_in"),
            tokens_out=_opt_int("tokens_out"),
            cost_usd=_opt_float("cost_usd"),
        )
    )


@router.post("/runs/{run_id}/timeout")
async def api_timeout_run(run_id: int) -> JSONResponse:
    """Mark a run as `timed_out`. Called by the Rust shell when max_runtime_sec elapses."""
    db = await get_db()
    return JSONResponse(await schedule_service.timeout_run(db, run_id))


@router.post("/runs/{run_id}/cancel")
async def api_cancel_run(run_id: int) -> JSONResponse:
    """Cancel a queued or running run."""
    db = await get_db()
    return JSONResponse(await schedule_service.cancel_run(db, run_id))


# ── Transcript reader ─────────────────────────────────────────────────────────


@router.get("/runs/{run_id}/transcript")
async def api_get_run_transcript(run_id: int) -> JSONResponse:
    """Return the raw transcript file content for a finished run.

    Guards against path traversal.  Returns ``{"content": "<text>"}`` or
    ``{"content": null}`` when no transcript exists / path is missing.
    Bounded to the last 256 KB so the WebView never OOMs on giant logs.
    """
    import os
    from pathlib import Path

    from app.config import settings

    db = await get_db()
    run = await schedule_service.get_run(db, run_id)
    transcript_path: str | None = run.get("transcript_path")
    if not transcript_path:
        return JSONResponse({"content": None, "run_id": run_id})

    # Canonicalize and verify the path stays inside one of the known
    # transcript directories.  Using Path.is_relative_to is a true
    # path-boundary check (not a string prefix), so sibling accounts
    # and paths like /tmp-extra/… are correctly rejected.
    resolved = Path(os.path.realpath(transcript_path))
    allowed_roots = [
        (settings.APP_DATA_DIR / "schedule-runs").resolve(),
        Path("/tmp"),
    ]
    if not any(resolved.is_relative_to(root) for root in allowed_roots):
        return JSONResponse({"content": None, "run_id": run_id})
    abs_path = str(resolved)

    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
            # Seek to tail — last 256 KB only.
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            cap = 256 * 1024
            start = max(0, size - cap)
            fh.seek(start)
            content = fh.read()
            if start > 0:
                content = (
                    f"[…truncated, showing last 256 KB of {size} bytes]\n{content}"
                )
    except OSError:
        content = None

    return JSONResponse({"content": content, "run_id": run_id})


# ── Manual fire ──────────────────────────────────────────────────────────────


@router.post("/{schedule_id}/fire")
async def api_fire_manual(schedule_id: int) -> JSONResponse:
    """Force-fire a schedule from the UI; inserts a queued run for the Rust shell."""
    db = await get_db()
    return JSONResponse(await schedule_service.fire_manual(db, schedule_id))


# ── Transcript retention ─────────────────────────────────────────────────────


@router.get("/retention")
async def api_get_retention() -> JSONResponse:
    """Return the current transcript retention setting (days)."""
    import json

    db = await get_db()
    row = await db.execute(
        "SELECT value_json FROM app_settings WHERE key = 'schedule_transcript_retention_days'",
    )
    r = await row.fetchone()
    if r:
        try:
            days = int(json.loads(r["value_json"]))
        except (ValueError, TypeError):
            days = 30
    else:
        days = 30
    return JSONResponse({"retention_days": days})


@router.put("/retention")
async def api_set_retention(request: Request) -> JSONResponse:
    """Set transcript retention days (1–365)."""
    import json

    body = await read_json_body(request, 512)
    raw = body.get("retention_days")
    if raw is None:
        raise HTTPException(status_code=400, detail="'retention_days' is required")
    try:
        days = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=400, detail="'retention_days' must be an integer"
        )
    if not (1 <= days <= 365):
        raise HTTPException(status_code=400, detail="'retention_days' must be 1–365")
    db = await get_db()
    from datetime import UTC, datetime

    now = datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")
    await db.execute(
        """INSERT INTO app_settings (key, value_json, updated_at)
           VALUES ('schedule_transcript_retention_days', ?, ?)
           ON CONFLICT(key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at""",
        (json.dumps(days), now),
    )
    await db.commit()
    return JSONResponse({"retention_days": days})


# ── Event dispatch ───────────────────────────────────────────────────────────


@router.post("/events")
async def api_dispatch_event(request: Request) -> JSONResponse:
    body = await read_json_body(request, _MAX_BODY)
    event_name = body.get("event_name")
    detail = body.get("detail")
    if not isinstance(event_name, str):
        raise HTTPException(status_code=400, detail="'event_name' must be a string")
    db = await get_db()
    matched = await schedule_service.dispatch_event(
        db,
        event_name,
        detail=detail if isinstance(detail, str) else None,
    )
    return JSONResponse({"event_name": event_name, "matched": matched})
