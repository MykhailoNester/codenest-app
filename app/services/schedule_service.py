"""Schedule rule engine — Phase 1 execution bridge.

Key changes from the pre-Phase-1 skeleton:
  - `schedule_runs` now has a real lifecycle: queued → running → succeeded/failed/…
  - `tick()` enforces an overlap guard (skips if a running row exists) and a
    staleness guard (records `missed` when the due slot is > 24 h late).
  - `reap_orphaned_runs()` clears stuck `running` rows on startup (sidecar
    crash resilience).
  - `create_dispatch_run()` inserts a `queued` row and returns the full run
    record for the Rust shell to consume.
  - `claim_pending_dispatches()` returns the next batch of `queued` runs and
    atomically transitions them to `dispatched_pending` (internal sentinel
    kept in memory; the Rust shell sets them to `running` via `start_run()`).
  - `start_run()`, `finish_run()`, `timeout_run()`, `cancel_run()` drive the
    per-run state machine from sidecar API endpoints.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

import aiosqlite
from fastapi import HTTPException

from . import _cron, _cron_helpers

logger = logging.getLogger(__name__)

ScheduleKind = Literal["cron", "event", "interval"]
TriggerKind = Literal["cron", "event", "manual"]

# Valid `trigger` values in schedule_runs.trigger
RunTrigger = Literal["scheduled", "manual", "catchup", "event"]

# How far past due a schedule may be before we record it as `missed` instead
# of launching.  This prevents flooding on a long lid-close (e.g. a week's
# vacation).
_STALENESS_HOURS = 24

# Event names are user-supplied; restrict to a safe slug-ish charset.
_SAFE_EVENT = re.compile(r"^[A-Za-z0-9._-]+$")

# Bound the worst case: dashboards realistically need a few dozen rules.
_LIST_LIMIT = 200

# Default max runtime (seconds) when a schedule doesn't pin one. Mirrors the
# Rust scheduler's fallback so the in-process backstop and the shell watchdog
# agree on the deadline.
_DEFAULT_MAX_RUNTIME_SEC = 900
# Extra grace beyond max_runtime before the in-process sweep declares a run
# lost — gives the Rust shell's watchdog (which fires at exactly max_runtime)
# time to report the timeout itself first.
_STALE_RUN_GRACE_SEC = 120


# ---------------------------------------------------------------------------
# Row conversion helpers
# ---------------------------------------------------------------------------


def _row_to_schedule(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    d["enabled"] = bool(d.get("enabled"))
    return d


def _row_to_run(row: aiosqlite.Row) -> dict[str, Any]:
    return dict(row)


# ---------------------------------------------------------------------------
# Schedule CRUD
# ---------------------------------------------------------------------------


async def list_schedules(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    cur = await db.execute(
        "SELECT * FROM schedules ORDER BY id ASC LIMIT ?", (_LIST_LIMIT,)
    )
    return [_row_to_schedule(r) for r in await cur.fetchall()]


async def get_schedule(db: aiosqlite.Connection, schedule_id: int) -> dict[str, Any]:
    async with db.execute(
        "SELECT * FROM schedules WHERE id = ?", (schedule_id,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"schedule {schedule_id} not found")
    return _row_to_schedule(row)


def _now() -> datetime:
    # Wrapped so tests can monkey-patch a fixed clock.
    return datetime.now()  # noqa: DTZ005


def _compute_next_fire(cron_expr: str, after: datetime | None = None) -> datetime:
    # Use the croniter-backed helper so create/patch/tick accept the SAME
    # expressions the friendly builder generates (comma lists like "1,3,5",
    # named tokens, etc.) — the legacy _cron parser rejects those. Re-raise as
    # _cron.CronError to keep existing call-site except handlers valid.
    try:
        fires = _cron_helpers.next_fire_times(cron_expr, count=1, after=after or _now())
    except _cron_helpers.CronHelperError as exc:
        raise _cron.CronError(str(exc)) from exc
    return fires[0]


# Smallest interval we accept — guards against a runaway "every 1 second" rule
# that would flood the dispatch queue.
_MIN_INTERVAL_SECONDS = 60


def _interval_next_fire(interval_seconds: int, after: datetime) -> datetime:
    """Next interval fire strictly after ``after`` (anchored to ``after``).

    On the happy path the caller passes the previous slot, so the result is just
    one interval later. If the app was closed for several intervals, advance in
    whole steps until we're in the future — never replaying every missed slot.
    """
    step = timedelta(seconds=max(interval_seconds, _MIN_INTERVAL_SECONDS))
    nxt = after + step
    now = _now()
    if nxt <= now:
        # Catch up in whole steps from the last slot to the next future one.
        missed = int((now - after).total_seconds() // step.total_seconds())
        nxt = after + step * (missed + 1)
    return nxt


# Extended patch keys including Phase 1 execution-bridge fields.
_ALLOWED_PATCH_KEYS = frozenset(
    {
        "name",
        "cron_expr",
        "event_name",
        "interval_seconds",
        "agent_name",
        "prompt",
        "enabled",
        "project_id",
        "provider_id",
        "model",
        "run_mode",
        "result_kind",
        "permission_mode",
        "allowed_tools",
        "max_budget_usd",
        "max_runtime_sec",
        "notify_policy",
        "artifact_dir",
    }
)


async def create_schedule(
    db: aiosqlite.Connection,
    *,
    name: str,
    kind: ScheduleKind,
    cron_expr: str | None,
    event_name: str | None,
    agent_name: str,
    prompt: str,
    enabled: bool = True,
    interval_seconds: int | None = None,
    project_id: int | None = None,
    provider_id: int | None = None,
    model: str | None = None,
    run_mode: str = "background",
    result_kind: str = "transcript",
    permission_mode: str = "dontAsk",
    allowed_tools: str | None = None,
    max_budget_usd: float | None = None,
    max_runtime_sec: int | None = None,
    notify_policy: str = "on_failure",
    artifact_dir: str | None = None,
) -> dict[str, Any]:
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="'name' is required")
    if provider_id is None:
        raise HTTPException(
            status_code=400,
            detail="a provider is required — scheduled runs need credentials to authenticate",
        )
    # agent_name is OPTIONAL — the UI offers "None (no specific agent)", in which
    # case the scheduled run launches claude without an --agent. Store "".
    agent_name = agent_name.strip() if isinstance(agent_name, str) else ""
    anchor_at: datetime | None = None
    if kind == "cron":
        if not isinstance(cron_expr, str) or not cron_expr.strip():
            raise HTTPException(
                status_code=400, detail="cron schedule requires 'cron_expr'"
            )
        try:
            next_at = _compute_next_fire(cron_expr)
        except _cron.CronError as exc:
            raise HTTPException(status_code=400, detail=f"invalid cron_expr: {exc}")
        event_name = None
        interval_seconds = None
    elif kind == "interval":
        if (
            not isinstance(interval_seconds, int)
            or interval_seconds < _MIN_INTERVAL_SECONDS
        ):
            raise HTTPException(
                status_code=400,
                detail=f"interval schedule requires 'interval_seconds' >= {_MIN_INTERVAL_SECONDS}",
            )
        # Anchor to creation time so "every N" counts from now, not the wall clock.
        anchor_at = _now()
        next_at = anchor_at + timedelta(seconds=interval_seconds)
        cron_expr = None
        event_name = None
    elif kind == "event":
        if not isinstance(event_name, str) or not event_name.strip():
            raise HTTPException(
                status_code=400, detail="event schedule requires 'event_name'"
            )
        if not _SAFE_EVENT.match(event_name):
            raise HTTPException(
                status_code=400,
                detail="event_name must match [A-Za-z0-9._-]+",
            )
        cron_expr = None
        next_at = None
        interval_seconds = None
    else:
        raise HTTPException(status_code=400, detail=f"unknown kind {kind!r}")

    cur = await db.execute(
        """
        INSERT INTO schedules
            (name, kind, cron_expr, event_name, interval_seconds, anchor_at,
             agent_name, prompt, enabled,
             next_fire_at, project_id, provider_id, model, run_mode, result_kind,
             permission_mode, allowed_tools, max_budget_usd, max_runtime_sec,
             notify_policy, artifact_dir)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            name.strip(),
            kind,
            cron_expr,
            event_name,
            interval_seconds,
            anchor_at.isoformat(sep=" ", timespec="seconds") if anchor_at else None,
            agent_name.strip(),
            prompt or "",
            1 if enabled else 0,
            next_at.isoformat(sep=" ", timespec="seconds") if next_at else None,
            project_id,
            provider_id,
            model,
            run_mode or "background",
            result_kind or "transcript",
            permission_mode or "dontAsk",
            allowed_tools,
            max_budget_usd,
            max_runtime_sec,
            notify_policy or "on_failure",
            artifact_dir or None,
        ),
    )
    await db.commit()
    sid = cur.lastrowid
    if sid is None:
        raise HTTPException(status_code=500, detail="failed to allocate schedule id")
    return await get_schedule(db, sid)


async def update_schedule(
    db: aiosqlite.Connection,
    schedule_id: int,
    patch: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(patch, dict):
        raise HTTPException(status_code=400, detail="patch must be an object")
    unknown = set(patch.keys()) - _ALLOWED_PATCH_KEYS
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"unknown patch keys: {sorted(unknown)}"
        )
    current = await get_schedule(db, schedule_id)

    sets: list[str] = []
    params: list[Any] = []

    # Core identity fields
    if "name" in patch:
        if not isinstance(patch["name"], str) or not patch["name"].strip():
            raise HTTPException(status_code=400, detail="'name' must be non-empty")
        sets.append("name = ?")
        params.append(patch["name"].strip())
    if "cron_expr" in patch:
        if current["kind"] != "cron":
            raise HTTPException(
                status_code=400, detail="cron_expr only valid for cron schedules"
            )
        if not isinstance(patch["cron_expr"], str) or not patch["cron_expr"].strip():
            raise HTTPException(status_code=400, detail="'cron_expr' must be non-empty")
        try:
            next_at = _compute_next_fire(patch["cron_expr"])
        except _cron.CronError as exc:
            raise HTTPException(status_code=400, detail=f"invalid cron_expr: {exc}")
        sets.append("cron_expr = ?")
        params.append(patch["cron_expr"].strip())
        sets.append("next_fire_at = ?")
        params.append(next_at.isoformat(sep=" ", timespec="seconds"))
    if "interval_seconds" in patch:
        if current["kind"] != "interval":
            raise HTTPException(
                status_code=400,
                detail="interval_seconds only valid for interval schedules",
            )
        val = patch["interval_seconds"]
        if (
            not isinstance(val, int)
            or isinstance(val, bool)
            or val < _MIN_INTERVAL_SECONDS
        ):
            raise HTTPException(
                status_code=400,
                detail=f"'interval_seconds' must be an int >= {_MIN_INTERVAL_SECONDS}",
            )
        # Re-anchor to now so the new cadence starts from this edit.
        anchor = _now()
        sets.append("interval_seconds = ?")
        params.append(val)
        sets.append("anchor_at = ?")
        params.append(anchor.isoformat(sep=" ", timespec="seconds"))
        sets.append("next_fire_at = ?")
        params.append(
            (anchor + timedelta(seconds=val)).isoformat(sep=" ", timespec="seconds")
        )
    if "event_name" in patch:
        if current["kind"] != "event":
            raise HTTPException(
                status_code=400, detail="event_name only valid for event schedules"
            )
        if not isinstance(patch["event_name"], str) or not _SAFE_EVENT.match(
            patch["event_name"]
        ):
            raise HTTPException(
                status_code=400, detail="event_name must match [A-Za-z0-9._-]+"
            )
        sets.append("event_name = ?")
        params.append(patch["event_name"])
    if "agent_name" in patch:
        # Optional — empty string clears the agent (no specific agent).
        if not isinstance(patch["agent_name"], str):
            raise HTTPException(status_code=400, detail="'agent_name' must be a string")
        sets.append("agent_name = ?")
        params.append(patch["agent_name"].strip())
    if "prompt" in patch:
        if not isinstance(patch["prompt"], str):
            raise HTTPException(status_code=400, detail="'prompt' must be a string")
        sets.append("prompt = ?")
        params.append(patch["prompt"])
    if "enabled" in patch:
        if not isinstance(patch["enabled"], bool):
            raise HTTPException(status_code=400, detail="'enabled' must be a boolean")
        sets.append("enabled = ?")
        params.append(1 if patch["enabled"] else 0)

    # Execution-bridge fields
    if "provider_id" in patch and patch["provider_id"] is None:
        raise HTTPException(
            status_code=400,
            detail="provider_id cannot be cleared — a provider is required",
        )
    for simple_col in (
        "project_id",
        "provider_id",
        "model",
        "allowed_tools",
        "permission_mode",
        "run_mode",
        "result_kind",
        "notify_policy",
        "artifact_dir",
    ):
        if simple_col in patch:
            sets.append(f"{simple_col} = ?")
            params.append(patch[simple_col])
    for num_col in ("max_budget_usd", "max_runtime_sec"):
        if num_col in patch:
            val = patch[num_col]
            if val is not None and not isinstance(val, (int, float)):
                raise HTTPException(
                    status_code=400, detail=f"'{num_col}' must be a number or null"
                )
            sets.append(f"{num_col} = ?")
            params.append(val)

    if not sets:
        return current
    sets.append("updated_at = CURRENT_TIMESTAMP")
    params.append(schedule_id)
    await db.execute(
        f"UPDATE schedules SET {', '.join(sets)} WHERE id = ?",
        tuple(params),
    )
    await db.commit()
    return await get_schedule(db, schedule_id)


async def delete_schedule(db: aiosqlite.Connection, schedule_id: int) -> dict[str, Any]:
    await get_schedule(db, schedule_id)
    await db.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
    await db.commit()
    return {"id": schedule_id, "deleted": True}


# ---------------------------------------------------------------------------
# Run history
# ---------------------------------------------------------------------------


async def list_runs(db: aiosqlite.Connection, schedule_id: int) -> list[dict[str, Any]]:
    await get_schedule(db, schedule_id)
    cur = await db.execute(
        """
        SELECT * FROM schedule_runs
        WHERE schedule_id = ?
        ORDER BY fired_at DESC
        LIMIT ?
        """,
        (schedule_id, _LIST_LIMIT),
    )
    return [_row_to_run(r) for r in await cur.fetchall()]


async def get_run(db: aiosqlite.Connection, run_id: int) -> dict[str, Any]:
    async with db.execute("SELECT * FROM schedule_runs WHERE id = ?", (run_id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"run {run_id} not found")
    return _row_to_run(row)


# ---------------------------------------------------------------------------
# Startup reaper
# ---------------------------------------------------------------------------


async def reap_orphaned_runs(db: aiosqlite.Connection) -> int:
    """Mark any `running` runs as `failed` on sidecar startup.

    A `running` row that survives a sidecar restart means the previous
    process crashed mid-execution. The Rust shell is also gone, so the PTY
    is already dead. Reaping here ensures no schedule is permanently wedged.
    Returns the number of rows reaped.
    """
    now_str = _now().isoformat(sep=" ", timespec="seconds")
    cur = await db.execute(
        """
        UPDATE schedule_runs
        SET status = 'failed',
            finished_at = ?,
            detail = 'reaped on startup — sidecar crashed during run'
        WHERE status IN ('running', 'queued')
        """,
        (now_str,),
    )
    await db.commit()
    count = cur.rowcount or 0
    if count:
        logger.warning("reap_orphaned_runs: reaped %d stuck run(s)", count)
    return count


async def sweep_stale_runs(db: aiosqlite.Connection) -> int:
    """Backstop for runs left `running` past their deadline.

    The Rust shell normally kills and reports a run at ``max_runtime_sec``. If
    the shell dies after a run starts while the sidecar keeps running (e.g. a
    lost finish POST), the run would otherwise sit `running` until the next
    startup reaper. This sweep — called from the schedule tick — marks any run
    whose ``started_at`` is older than its schedule's ``max_runtime_sec`` (or the
    default) plus a grace window as ``timed_out``. The grace lets the shell's own
    watchdog report first in the normal case. Returns the number of rows swept.
    """
    now_str = _now().isoformat(sep=" ", timespec="seconds")
    cur = await db.execute(
        """
        UPDATE schedule_runs
        SET status = 'timed_out',
            finished_at = ?,
            detail = 'stale sweep — no completion within max_runtime + grace'
        WHERE status = 'running'
          AND started_at IS NOT NULL
          AND (julianday(?) - julianday(started_at)) * 86400.0 >
              COALESCE(
                  (SELECT max_runtime_sec FROM schedules
                   WHERE id = schedule_runs.schedule_id),
                  ?
              ) + ?
        """,
        (now_str, now_str, _DEFAULT_MAX_RUNTIME_SEC, _STALE_RUN_GRACE_SEC),
    )
    await db.commit()
    count = cur.rowcount or 0
    if count:
        logger.warning("sweep_stale_runs: timed out %d stale run(s)", count)
    return count


# ---------------------------------------------------------------------------
# Run lifecycle helpers
# ---------------------------------------------------------------------------


async def _insert_run(
    db: aiosqlite.Connection,
    schedule_id: int,
    trigger_kind: TriggerKind,
    trigger: RunTrigger,
    *,
    status: str = "queued",
    session_id: str | None = None,
    detail: str | None = None,
) -> dict[str, Any]:
    sid = session_id or str(uuid.uuid4())
    now_str = _now().isoformat(sep=" ", timespec="seconds")
    cur = await db.execute(
        """
        INSERT INTO schedule_runs
            (schedule_id, trigger_kind, trigger, status, session_id, detail, fired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (schedule_id, trigger_kind, trigger, status, sid, detail, now_str),
    )
    await db.commit()
    run_id = cur.lastrowid
    return await get_run(db, run_id)  # type: ignore[arg-type]


async def start_run(db: aiosqlite.Connection, run_id: int) -> dict[str, Any]:
    """Transition a `queued` run to `running`. Called by the Rust shell."""
    now_str = _now().isoformat(sep=" ", timespec="seconds")
    await db.execute(
        """
        UPDATE schedule_runs
        SET status = 'running', started_at = ?
        WHERE id = ? AND status = 'queued'
        """,
        (now_str, run_id),
    )
    await db.commit()
    return await get_run(db, run_id)


async def finish_run(
    db: aiosqlite.Connection,
    run_id: int,
    *,
    exit_code: int,
    transcript_path: str | None = None,
    artifact_path: str | None = None,
    summary_text: str | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    cost_usd: float | None = None,
) -> dict[str, Any]:
    """Finalize a run on process exit. Called by the Rust shell via the API."""
    now = _now()
    now_str = now.isoformat(sep=" ", timespec="seconds")

    # Compute duration from started_at if available.
    run = await get_run(db, run_id)
    duration_ms: int | None = None
    started_raw = run.get("started_at")
    if started_raw:
        try:
            started = datetime.fromisoformat(str(started_raw))
            duration_ms = int((now - started).total_seconds() * 1000)
        except (ValueError, TypeError):
            pass

    status = "succeeded" if exit_code == 0 else "failed"
    await db.execute(
        """
        UPDATE schedule_runs
        SET status = ?, finished_at = ?, duration_ms = ?, exit_code = ?,
            transcript_path = ?, artifact_path = ?, summary_text = ?,
            tokens_in = ?, tokens_out = ?, cost_usd = ?
        WHERE id = ?
        """,
        (
            status,
            now_str,
            duration_ms,
            exit_code,
            transcript_path,
            artifact_path,
            summary_text,
            tokens_in,
            tokens_out,
            cost_usd,
            run_id,
        ),
    )
    await db.commit()
    logger.info("finish_run: run %d → %s (exit %d)", run_id, status, exit_code)
    return await get_run(db, run_id)


async def timeout_run(db: aiosqlite.Connection, run_id: int) -> dict[str, Any]:
    """Mark a run as `timed_out`. Called by the Rust shell."""
    now_str = _now().isoformat(sep=" ", timespec="seconds")
    await db.execute(
        """
        UPDATE schedule_runs
        SET status = 'timed_out', finished_at = ?, exit_code = -1
        WHERE id = ? AND status = 'running'
        """,
        (now_str, run_id),
    )
    await db.commit()
    return await get_run(db, run_id)


async def cancel_run(db: aiosqlite.Connection, run_id: int) -> dict[str, Any]:
    """Mark a run as `cancelled`."""
    now_str = _now().isoformat(sep=" ", timespec="seconds")
    await db.execute(
        """
        UPDATE schedule_runs
        SET status = 'cancelled', finished_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
        """,
        (now_str, run_id),
    )
    await db.commit()
    return await get_run(db, run_id)


# ---------------------------------------------------------------------------
# Tick engine
# ---------------------------------------------------------------------------


def _parse_db_timestamp(raw: str) -> datetime:
    return datetime.fromisoformat(raw)


def _is_stale(due_at: datetime, now: datetime) -> bool:
    """Return True if the due slot is more than _STALENESS_HOURS old."""
    return (now - due_at).total_seconds() > _STALENESS_HOURS * 3600


async def _has_running_run(db: aiosqlite.Connection, schedule_id: int) -> bool:
    """Return True if there is already a running or queued run for this schedule."""
    cur = await db.execute(
        """
        SELECT 1 FROM schedule_runs
        WHERE schedule_id = ? AND status IN ('running', 'queued')
        LIMIT 1
        """,
        (schedule_id,),
    )
    return await cur.fetchone() is not None


async def tick(db: aiosqlite.Connection) -> int:
    """Fire every enabled cron/interval schedule whose next_fire_at <= now.

    Guards:
      - Overlap guard: skip (status=skipped) if a running/queued run exists.
      - Staleness guard: record `missed` when the due slot is > 24 h late.

    Returns the number of schedules that were queued for launch (excludes
    skipped/missed).
    """
    now = _now()
    cur = await db.execute(
        """
        SELECT * FROM schedules
        WHERE kind IN ('cron', 'interval') AND enabled = 1
          AND next_fire_at IS NOT NULL
          AND next_fire_at <= ?
        """,
        (now.isoformat(sep=" ", timespec="seconds"),),
    )
    rows = list(await cur.fetchall())
    fired = 0
    for row in rows:
        sid = int(row["id"])
        kind = str(row["kind"])
        expr_raw = str(row["cron_expr"])
        try:
            try:
                current_nfa = _parse_db_timestamp(str(row["next_fire_at"]))
            except (ValueError, TypeError):
                current_nfa = now

            # Compute next fire before any guard so disabled rows still advance.
            try:
                if kind == "interval":
                    interval_seconds = int(row["interval_seconds"])
                    next_at = _interval_next_fire(interval_seconds, after=current_nfa)
                else:
                    next_at = _compute_next_fire(expr_raw, after=max(now, current_nfa))
            except (_cron.CronError, ValueError, TypeError) as exc:
                logger.warning(
                    "schedule %s has invalid %s config: %s; disabling",
                    sid,
                    kind,
                    exc,
                )
                await db.execute(
                    "UPDATE schedules SET enabled = 0 WHERE id = ?", (sid,)
                )
                await db.commit()
                continue

            # Staleness guard: very old due slot → record missed, advance.
            if _is_stale(current_nfa, now):
                logger.info(
                    "schedule %s: due slot %s is >%dh old → missed",
                    sid,
                    current_nfa.isoformat(),
                    _STALENESS_HOURS,
                )
                await _insert_run(
                    db,
                    sid,
                    "cron",
                    "scheduled",
                    status="missed",
                    detail=f"due slot {current_nfa.isoformat()} was >{_STALENESS_HOURS}h late",
                )
                await db.execute(
                    """
                    UPDATE schedules
                    SET last_fired_at = CURRENT_TIMESTAMP,
                        next_fire_at  = ?,
                        updated_at    = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (next_at.isoformat(sep=" ", timespec="seconds"), sid),
                )
                await db.commit()
                continue

            # Overlap guard: skip if a run is already in-flight.
            if await _has_running_run(db, sid):
                logger.info(
                    "schedule %s: overlap guard — a run is already queued/running", sid
                )
                await _insert_run(
                    db,
                    sid,
                    "cron",
                    "scheduled",
                    status="skipped",
                    detail="overlap: a run is already queued or running",
                )
                await db.execute(
                    """
                    UPDATE schedules
                    SET next_fire_at = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (next_at.isoformat(sep=" ", timespec="seconds"), sid),
                )
                await db.commit()
                continue

            # Happy path: insert a queued run (the Rust shell will claim it).
            await _insert_run(db, sid, "cron", "scheduled", status="queued")
            await db.execute(
                """
                UPDATE schedules
                SET last_fired_at = CURRENT_TIMESTAMP,
                    next_fire_at  = ?,
                    updated_at    = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (next_at.isoformat(sep=" ", timespec="seconds"), sid),
            )
            await db.commit()
            fired += 1

        except Exception as exc:  # noqa: BLE001
            logger.warning("schedule %s tick error (skipped): %s", sid, exc)
    return fired


# ---------------------------------------------------------------------------
# Dispatch queue (sidecar→shell channel)
# ---------------------------------------------------------------------------


async def claim_pending_dispatches(
    db: aiosqlite.Connection,
    *,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Return queued runs with their parent schedule's launch config.

    The Rust shell polls this endpoint every few seconds. Each returned run is
    accompanied by the full schedule row so the shell can build the `claude`
    command without a second round-trip.

    The rows are NOT transitioned here — they remain `queued` until the shell
    calls `POST /schedules/runs/{id}/start`. This keeps the sidecar stateless
    with respect to the dispatch; if the shell restarts between claim and start,
    the run is reaped by the next startup reaper.
    """
    cur = await db.execute(
        """
        SELECT
            sr.id            AS run_id,
            sr.schedule_id,
            sr.trigger_kind,
            sr.trigger,
            sr.session_id,
            sr.fired_at,
            s.name           AS schedule_name,
            s.agent_name,
            s.prompt,
            s.project_id,
            s.provider_id,
            s.model,
            s.run_mode,
            s.result_kind,
            s.permission_mode,
            s.allowed_tools,
            s.max_budget_usd,
            s.max_runtime_sec,
            s.notify_policy,
            s.artifact_dir
        FROM schedule_runs sr
        JOIN schedules s ON s.id = sr.schedule_id
        WHERE sr.status = 'queued'
        ORDER BY sr.fired_at ASC
        LIMIT ?
        """,
        (limit,),
    )
    rows = await cur.fetchall()

    from app.config import settings  # local import avoids circular at module level

    result: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        if d.get("result_kind") == "artifact":
            artifact_dir_val = d.get("artifact_dir")
            root = (
                Path(artifact_dir_val)
                if artifact_dir_val
                else (settings.WORKSPACE_ROOT / "schedule-artifacts")
            )
            raw_name = d.get("schedule_name") or ""
            safe = (
                re.sub(r"[^A-Za-z0-9._-]+", "-", raw_name).strip("-").lower()
                or f"schedule-{d.get('schedule_id')}"
            )
            target = root / safe / f"{safe}-run{d.get('run_id')}.md"
            d["artifact_target_path"] = str(target)
        else:
            d["artifact_target_path"] = None
        # `artifact_dir` only feeds the target-path computation above; the Rust
        # shell consumes `artifact_target_path`, not the raw dir, so keep it out
        # of the dispatch payload.
        d.pop("artifact_dir", None)
        result.append(d)
    return result


# ---------------------------------------------------------------------------
# Manual fire
# ---------------------------------------------------------------------------


async def fire_manual(db: aiosqlite.Connection, schedule_id: int) -> dict[str, Any]:
    """Force-fire a schedule from the UI — inserts a queued run record.

    For interval schedules ("every N"), a manual fire re-anchors the cadence to
    now so the next automatic fire is one full interval away — i.e. "Run now"
    resets the countdown, matching the user's mental model of "every 2h from the
    last run". Cron schedules keep their wall-clock cadence (a manual run never
    shifts a cron slot), so their next_fire_at is left untouched.
    """
    schedule = await get_schedule(db, schedule_id)

    # Overlap guard even for manual fires.
    if await _has_running_run(db, schedule_id):
        raise HTTPException(
            status_code=409,
            detail="a run is already queued or running for this schedule",
        )

    run = await _insert_run(db, schedule_id, "manual", "manual", status="queued")

    now = _now()
    now_str = now.isoformat(sep=" ", timespec="seconds")
    interval = schedule.get("interval_seconds")
    if (
        schedule.get("kind") == "interval"
        and isinstance(interval, int)
        and interval > 0
    ):
        next_at = now + timedelta(seconds=interval)
        await db.execute(
            """
            UPDATE schedules
            SET last_fired_at = ?,
                anchor_at     = ?,
                next_fire_at  = ?,
                updated_at    = ?
            WHERE id = ?
            """,
            (
                now_str,
                now_str,
                next_at.isoformat(sep=" ", timespec="seconds"),
                now_str,
                schedule_id,
            ),
        )
    else:
        await db.execute(
            """
            UPDATE schedules
            SET last_fired_at = ?,
                updated_at    = ?
            WHERE id = ?
            """,
            (now_str, now_str, schedule_id),
        )
    await db.commit()
    # Re-read so the response carries the updated next_fire_at (the UI shows it
    # immediately as "next in <interval>" instead of the stale countdown).
    schedule = await get_schedule(db, schedule_id)
    return {"schedule": schedule, "run": run}


# ---------------------------------------------------------------------------
# Event dispatch
# ---------------------------------------------------------------------------


async def dispatch_event(
    db: aiosqlite.Connection, event_name: str, detail: str | None = None
) -> int:
    """Record a queued run for every enabled event schedule matching ``event_name``."""
    if not isinstance(event_name, str) or not _SAFE_EVENT.match(event_name):
        raise HTTPException(
            status_code=400, detail="event_name must match [A-Za-z0-9._-]+"
        )
    cur = await db.execute(
        """
        SELECT id FROM schedules
        WHERE kind = 'event' AND enabled = 1 AND event_name = ?
        """,
        (event_name,),
    )
    ids = [int(row["id"]) for row in await cur.fetchall()]
    for sid in ids:
        await _insert_run(
            db,
            sid,
            "event",
            "event",
            status="queued",
            detail=detail,
        )
    if ids:
        placeholders = ",".join("?" * len(ids))
        await db.execute(
            f"""
            UPDATE schedules
            SET last_fired_at = CURRENT_TIMESTAMP,
                updated_at    = CURRENT_TIMESTAMP
            WHERE id IN ({placeholders})
            """,
            tuple(ids),
        )
        await db.commit()
    return len(ids)


# ---------------------------------------------------------------------------
# Transcript retention (Phase 3.5)
# ---------------------------------------------------------------------------

_DEFAULT_RETENTION_DAYS = 30


async def prune_transcript_blobs(
    db: aiosqlite.Connection,
    *,
    runs_dir: Path | None = None,
    retention_days: int | None = None,
) -> dict[str, int]:
    """Delete old internal transcript log files and NULL their DB column.

    Run metadata rows, artifact files, and the ``artifact_path`` column are
    kept untouched — artifacts are user-owned deliverables that must never be
    auto-deleted by the app.  Only the on-disk transcript log (an internal raw
    stream-json file written by the sidecar to ``<APP_DATA_DIR>/schedule-runs/``)
    and its corresponding ``transcript_path`` column are cleared.

    Args:
        runs_dir:       Override for the schedule-runs directory; resolved from
                        ``app.config.settings.APP_DATA_DIR`` when None.
        retention_days: How many days to keep transcripts; falls back to the
                        ``schedule_transcript_retention_days`` app_setting, and
                        ultimately to ``_DEFAULT_RETENTION_DAYS`` (30).

    Returns a summary dict: {"files_deleted": N, "rows_cleared": N}.
    """
    from app.config import settings  # local import avoids circular at module level

    if runs_dir is None:
        runs_dir = settings.APP_DATA_DIR / "schedule-runs"

    runs_dir = runs_dir.resolve()

    # Resolve effective retention window.
    if retention_days is None:
        async with db.execute(
            "SELECT value_json FROM app_settings WHERE key = 'schedule_transcript_retention_days'",
        ) as _setting_cur:
            setting_row = await _setting_cur.fetchone()
        if setting_row:
            try:
                import json

                retention_days = int(json.loads(setting_row["value_json"]))
            except (ValueError, TypeError):
                retention_days = _DEFAULT_RETENTION_DAYS
        else:
            retention_days = _DEFAULT_RETENTION_DAYS

    cutoff = (_now() - timedelta(days=retention_days)).isoformat(
        sep=" ", timespec="seconds"
    )

    # Fetch runs whose transcript should be pruned (finished before cutoff).
    async with db.execute(
        """
        SELECT id, transcript_path
        FROM schedule_runs
        WHERE finished_at < ?
          AND transcript_path IS NOT NULL
        """,
        (cutoff,),
    ) as _prune_cur:
        rows = await _prune_cur.fetchall()

    files_deleted = 0
    rows_cleared = 0

    for run_row in rows:
        run_id = run_row["id"]
        path_str = run_row["transcript_path"]
        if not path_str:
            continue

        p = Path(path_str).resolve()

        # Safety guard: only unlink files that actually live inside runs_dir.
        # If the stored path somehow points outside our data dir (e.g. due to
        # DB corruption or a path-traversal edge case), skip the unlink but
        # still NULL the column so it stops appearing in future prune queries.
        if not p.is_relative_to(runs_dir):
            logger.warning(
                "prune_transcript_blobs: transcript_path %s is outside runs_dir %s"
                " (run %d) — skipping unlink, clearing column only",
                p,
                runs_dir,
                run_id,
            )
        elif p.exists():
            try:
                p.unlink()
                files_deleted += 1
                logger.info(
                    "prune_transcript_blobs: deleted transcript %s (run %d)", p, run_id
                )
            except OSError as exc:
                logger.warning(
                    "prune_transcript_blobs: could not delete %s: %s", p, exc
                )

        await db.execute(
            "UPDATE schedule_runs SET transcript_path = NULL WHERE id = ?",
            (run_id,),
        )
        rows_cleared += 1

    if rows_cleared:
        await db.commit()

    logger.info(
        "prune_transcript_blobs: retention=%dd, transcripts_deleted=%d, rows_cleared=%d",
        retention_days,
        files_deleted,
        rows_cleared,
    )
    return {"files_deleted": files_deleted, "rows_cleared": rows_cleared}
