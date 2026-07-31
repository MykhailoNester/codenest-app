"""agent_runs_service — provider-agnostic run tracking.

Every dashboard-launched agent produces one ``agent_runs`` row at launch time.
Claude hooks ENRICH a run when present (via the deterministic session_id link)
but are never required for basic tracking.

Architecture note
-----------------
- Launch  → persist_on_launch()  (called from agents.py POST /agents/events/launch)
- PTY exit → mark_ended_by_pane() (called from agents.py POST /agents/runs/exited)
- Hook enrichment → link_session()  (called from agent_service once a session_id
                                     arrives in any hook payload)
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


# ── Write API ────────────────────────────────────────────────────────────────


async def persist_on_launch(
    db: aiosqlite.Connection,
    *,
    session_id: str | None,
    provider_id: int | None,
    project_id: int | None,
    pane_id: str | None,
    model: str | None,
    prompt_preview: str | None,
    source_kind: str | None,
    source_id: int | None,
    profile: str | None = None,
    target: str | None = None,
) -> int:
    """Insert an ``agent_runs`` row for a freshly-launched agent pane.

    Returns the new row's ``id``.

    ``target`` is ``'embedded'`` when the pane lives in the main-window
    terminal grid, or ``'popout'`` when it lives in the detached terminals
    window.  ``None`` is treated as ``'embedded'`` everywhere it is read.
    """
    now = _now()
    cursor = await db.execute(
        """
        INSERT INTO agent_runs
            (session_id, provider_id, project_id, pane_id, model,
             prompt_preview, status, source_kind, source_id, started_at,
             profile, target)
        VALUES
            (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
        """,
        (
            session_id,
            provider_id,
            project_id,
            pane_id,
            model,
            prompt_preview,
            source_kind,
            source_id,
            now,
            profile,
            target,
        ),
    )
    await db.commit()
    row_id = cursor.lastrowid
    assert row_id is not None
    return row_id


def _paths_are_case_insensitive() -> bool:
    """Whether this platform compares paths case-insensitively.

    A function rather than a module constant so a test can exercise the Windows
    branch without running on Windows — the whole point of the normalisation
    below is behaviour this platform cannot demonstrate.
    """
    return os.name == "nt"


def _match_key(path: str) -> str:
    """Normalise a path for prefix comparison.

    Separators are folded to ``/`` because the two sides come from different
    places: a project path is whatever was stored at import time, while a cwd
    comes from the pane. On Windows those legitimately differ in separator — a
    stored ``C:/w/acme`` against a ``C:\\w\\acme`` cwd — and a literal compare
    would simply never match, which is the bug this fixes.

    Case is folded only where the filesystem does, so ``/w/App`` and ``/w/app``
    stay distinct projects on Linux (where they can genuinely coexist) and are
    the same one on Windows.
    """
    normalised = path.replace("\\", "/").rstrip("/")
    return normalised.casefold() if _paths_are_case_insensitive() else normalised


async def resolve_project_id_for_cwd(
    db: aiosqlite.Connection, cwd: str | None
) -> int | None:
    """Return the id of the project whose ``path`` contains ``cwd``, if any.

    An agent pane knows the directory it was opened in, not a project id — the
    pane tree is deliberately free of the react-query/project lookups the rest
    of the app uses. Resolving here is what stops those runs from showing as
    project "unknown" on the Command Center.

    Longest match wins, because a pane can be opened in a subdirectory of a
    project (and one project's path can be a prefix of another's, as an umbrella
    repo's is of every repo nested inside it). Matching is prefix-on-separator,
    so ``/w/app`` never claims a pane in ``/w/app-legacy``.

    Both sides are normalised through :func:`_match_key` first, so a Windows
    ``C:\\w\\acme`` cwd still matches a project stored as ``C:/w/acme`` and the
    comparison respects the platform's own case rules.
    """
    if not cwd:
        return None
    needle = _match_key(cwd)
    cur = await db.execute(
        "SELECT id, path FROM projects WHERE path IS NOT NULL AND path != ''"
    )
    best_id: int | None = None
    best_len = -1
    for row in await cur.fetchall():
        path = _match_key(str(row["path"]))
        if not path:
            continue
        matches = needle == path or needle.startswith(f"{path}/")
        if matches and len(path) > best_len:
            best_id, best_len = row["id"], len(path)
    return best_id


async def mark_ended_by_pane(
    db: aiosqlite.Connection,
    pane_id: str,
    exit_code: int | None = None,
    session_id: str | None = None,
) -> int:
    """Mark running ``agent_runs`` rows for ``pane_id`` as ended.

    Returns the number of rows updated.

    ``session_id`` narrows the update to one run. A pane id is reused across
    restarts — an agent pane keeps its leaf id for the pane's whole life — so
    "every running row for this pane" would let a late report about the session
    that *just* ended mark the freshly-started replacement as ended too, leaving
    a live session showing as dead (and losing its Focus/Stop actions) for the
    rest of its life. Callers that know which session ended should say so; the
    unscoped form stays for the PTY path, whose ``pty-exited`` event carries no
    session id.
    """
    now = _now()
    if session_id:
        cursor = await db.execute(
            """
            UPDATE agent_runs
            SET status = 'ended', ended_at = ?
            WHERE pane_id = ? AND status = 'running' AND session_id = ?
            """,
            (now, pane_id, session_id),
        )
    else:
        cursor = await db.execute(
            """
            UPDATE agent_runs
            SET status = 'ended', ended_at = ?
            WHERE pane_id = ? AND status = 'running'
            """,
            (now, pane_id),
        )
    await db.commit()
    return cursor.rowcount


RECONCILE_GRACE_SECONDS = 60


async def reconcile_running_runs(
    db: aiosqlite.Connection,
    live_pane_ids: Iterable[str],
    grace_seconds: int = RECONCILE_GRACE_SECONDS,
) -> int:
    """End every ``running`` run whose pane no longer has a child. Returns the count.

    A run is moved to ``ended`` by whoever noticed the child die, and that report
    is what goes missing when a popout window is torn down mid-report, when the
    app quits or crashes, or when the sidecar was unreachable at that moment. The
    row then claims the session is live forever, offering a Focus and a Stop that
    act on nothing. This is the sweep that repairs it, against the shell's list of
    panes it still holds children for — the only authoritative answer.

    Runs younger than ``grace_seconds`` are left alone. The caller's list is a
    snapshot taken just before the request, so a pane that started in between
    would otherwise be "not live" and get ended immediately after launching. A
    genuinely dead young run is simply caught by the next sweep.
    """
    live = {str(p) for p in live_pane_ids if p}
    cutoff = datetime.now(UTC) - timedelta(seconds=max(0, grace_seconds))
    cur = await db.execute(
        "SELECT id, pane_id FROM agent_runs WHERE status = 'running' AND started_at <= ?",
        (cutoff.isoformat(timespec="seconds"),),
    )
    stale = [row["id"] for row in await cur.fetchall() if row["pane_id"] not in live]
    if not stale:
        return 0
    now = _now()
    # Interpolates only the `?` placeholders, one per id — every value is still
    # bound. SQLite has no array parameter, so a variable-length IN needs this.
    placeholders = ",".join("?" for _ in stale)
    await db.execute(
        f"UPDATE agent_runs SET status = 'ended', ended_at = ? WHERE id IN ({placeholders})",
        (now, *stale),
    )
    await db.commit()
    return len(stale)


async def link_session(
    db: aiosqlite.Connection,
    run_id: int,
    session_id: str,
) -> None:
    """Back-fill ``session_id`` on an existing run row (if still NULL).

    Called once the first hook carrying the session UUID arrives.  The
    column may already be set (the dashboard generated it at launch);
    this is a no-op in that case.
    """
    await db.execute(
        """
        UPDATE agent_runs
        SET session_id = ?
        WHERE id = ? AND session_id IS NULL
        """,
        (session_id, run_id),
    )
    await db.commit()


async def relink_run_to_session(
    db: aiosqlite.Connection,
    new_session_id: str,
    cwd: str | None,
) -> str | None:
    """Re-point a running ``agent_runs`` row at a brand-new ``session_id``.

    Called after ``/clear`` inside a Claude Code session: Claude restarts
    itself with a fresh UUID without re-running the original shell command,
    so the dashboard-minted ``session_id`` stored in ``agent_runs`` is now
    stale.

    Matching strategy (most-specific first):
    1. Find a ``running`` ``agent_runs`` row whose joined ``agent_sessions``
       row already carries a ``pane_id`` (set on prior launches via this
       same function) — pick the row where ``agent_sessions.cwd = cwd``.
    2. Fall back to any ``running`` row whose previous session shared the
       same ``cwd`` (works for the first ``/clear`` before ``pane_id`` was
       stamped on the old session).
    3. Last resort: any ``running`` row with no ``session_id`` yet and a
       NULL or matching ``cwd`` — handles edge cases after sidecar restart.

    Returns the ``pane_id`` of the relinked row, or ``None`` if no
    candidate was found.
    """
    if not cwd:
        return None

    cursor = await db.execute(
        """
        SELECT r.id, r.pane_id
        FROM agent_runs r
        LEFT JOIN agent_sessions s ON s.session_id = r.session_id
        WHERE r.status = 'running'
          AND r.ended_at IS NULL
          AND (s.cwd = ? OR r.session_id IS NULL)
        ORDER BY
            -- Prefer rows whose prior session pane_id is already stamped
            -- (deterministic on repeated /clear) over heuristic cwd match.
            CASE WHEN s.pane_id IS NOT NULL THEN 0 ELSE 1 END ASC,
            r.started_at DESC
        LIMIT 1
        """,
        (cwd,),
    )
    result = await cursor.fetchone()
    if not result:
        return None

    run_id: int = result["id"]
    # ``agent_runs.pane_id`` is TEXT NULL — a run launched without a pane_id
    # yields None here, which the caller's ``if pane_id:`` guard handles.
    pane_id: str | None = result["pane_id"]
    await db.execute(
        "UPDATE agent_runs SET session_id = ? WHERE id = ?",
        (new_session_id, run_id),
    )
    await db.commit()
    return pane_id


# ── Read API ─────────────────────────────────────────────────────────────────


async def list_runs(
    db: aiosqlite.Connection,
    limit: int = 100,
    provider_id: int | None = None,
    status: str | None = None,
    profile: str | None = None,
) -> list[dict[str, Any]]:
    """Return a unified agent list: ``agent_runs`` rows plus observe-only sessions.

    The result is a UNION of:
    1. ``agent_runs`` rows (dashboard-launched, any provider) merged with
       provider metadata and session enrichment.
    2. ``agent_sessions`` rows that are NOT linked to any ``agent_runs`` row
       (external / hook-driven Claude sessions) — rendered with
       ``row_kind='observe'`` so the UI can mark them as observe-only.

    Filters ``provider_id``, ``status``, and ``profile`` are applied to both
    halves where the relevant column exists.

    Each row exposes:
    - ``row_kind``: ``'run'`` | ``'observe'``.
    - All ``agent_runs`` columns (NULLs for observe-only rows).
    - ``provider_name``, ``provider_display_name``, ``provider_color``.
    - ``project_name``.
    - ``session_status``, ``session_current_tool``, ``session_tokens_in``,
      ``session_tokens_out``, ``session_cost_usd``, ``session_initial_prompt``,
      ``session_total_tool_calls``.
    - ``profile`` (from agent_runs for launched runs, from agent_sessions for
      observe-only rows).
    """
    # ── Part 1: dashboard-launched runs ──────────────────────────────────────
    run_conditions: list[str] = []
    run_params: list[Any] = []

    if provider_id is not None:
        run_conditions.append("r.provider_id = ?")
        run_params.append(provider_id)
    if status is not None:
        run_conditions.append("r.status = ?")
        run_params.append(status)
    if profile is not None:
        run_conditions.append("r.profile = ?")
        run_params.append(profile)

    run_where = ("WHERE " + " AND ".join(run_conditions)) if run_conditions else ""

    run_sql = f"""
        SELECT
            'run'              AS row_kind,
            r.id,
            r.session_id,
            r.provider_id,
            r.project_id,
            r.pane_id,
            r.model,
            r.prompt_preview,
            r.status,
            r.source_kind,
            r.source_id,
            r.started_at,
            r.ended_at,
            r.profile,
            r.target,
            p.name             AS provider_name,
            p.display_name     AS provider_display_name,
            p.color            AS provider_color,
            proj.name          AS project_name,
            s.status           AS session_status,
            s.current_tool     AS session_current_tool,
            s.tokens_in        AS session_tokens_in,
            s.tokens_out       AS session_tokens_out,
            s.cost_usd         AS session_cost_usd,
            s.initial_prompt   AS session_initial_prompt,
            s.total_tool_calls AS session_total_tool_calls,
            sr.schedule_id     AS schedule_id,
            sch.name           AS schedule_name
        FROM agent_runs r
        LEFT JOIN providers    p    ON p.id    = r.provider_id
        LEFT JOIN projects     proj ON proj.id  = r.project_id
        LEFT JOIN agent_sessions s  ON s.session_id = r.session_id
        LEFT JOIN schedule_runs sr  ON sr.session_id = r.session_id
        LEFT JOIN schedules    sch  ON sch.id = sr.schedule_id
        {run_where}
    """

    # ── Part 2: observe-only sessions (not linked to any agent_runs row) ─────
    # Only include active/idle sessions by default; if the caller asks for
    # status='ended' we include ended sessions too.
    obs_conditions: list[str] = [
        "s.session_id NOT IN (SELECT session_id FROM agent_runs WHERE session_id IS NOT NULL)"
    ]
    obs_params: list[Any] = []

    if provider_id is not None:
        obs_conditions.append("s.provider_id = ?")
        obs_params.append(provider_id)
    if status is not None:
        # Map run status to session status vocabulary.
        # 'running' in run land → 'active' or 'idle' in session land.
        if status == "running":
            obs_conditions.append("s.status IN ('active', 'idle')")
        elif status == "ended":
            obs_conditions.append("s.status IN ('ended', 'stopped')")
        else:
            obs_conditions.append("s.status = ?")
            obs_params.append(status)
    else:
        # Default: include both running (active/idle) and ended sessions.
        pass
    if profile is not None:
        obs_conditions.append("s.profile = ?")
        obs_params.append(profile)

    obs_where = "WHERE " + " AND ".join(obs_conditions)

    obs_sql = f"""
        SELECT
            'observe'          AS row_kind,
            NULL               AS id,
            s.session_id,
            s.provider_id,
            s.project_id,
            NULL               AS pane_id,
            s.model,
            s.initial_prompt   AS prompt_preview,
            CASE
                WHEN s.status IN ('active', 'idle') THEN 'running'
                ELSE 'ended'
            END                AS status,
            NULL               AS source_kind,
            NULL               AS source_id,
            s.started_at,
            s.ended_at,
            s.profile,
            NULL               AS target,
            p.name             AS provider_name,
            p.display_name     AS provider_display_name,
            p.color            AS provider_color,
            proj.name          AS project_name,
            s.status           AS session_status,
            s.current_tool     AS session_current_tool,
            s.tokens_in        AS session_tokens_in,
            s.tokens_out       AS session_tokens_out,
            s.cost_usd         AS session_cost_usd,
            s.initial_prompt   AS session_initial_prompt,
            s.total_tool_calls AS session_total_tool_calls,
            sr.schedule_id     AS schedule_id,
            sch.name           AS schedule_name
        FROM agent_sessions s
        LEFT JOIN providers p    ON p.id    = s.provider_id
        LEFT JOIN projects  proj ON proj.id = s.project_id
        LEFT JOIN schedule_runs sr ON sr.session_id = s.session_id
        LEFT JOIN schedules sch    ON sch.id = sr.schedule_id
        {obs_where}
    """

    union_sql = f"""
        SELECT * FROM ({run_sql}) runs
        UNION ALL
        SELECT * FROM ({obs_sql}) observe
        ORDER BY started_at DESC
        LIMIT ?
    """

    all_params: list[Any] = run_params + obs_params + [limit]
    rows = await db.execute(union_sql, all_params)
    return [dict(row) for row in await rows.fetchall()]


async def get_run_by_pane(
    db: aiosqlite.Connection,
    pane_id: str,
) -> dict[str, Any] | None:
    """Return the most-recent agent_runs row for a given pane_id."""
    row = await db.execute(
        "SELECT * FROM agent_runs WHERE pane_id = ? ORDER BY started_at DESC LIMIT 1",
        (pane_id,),
    )
    result = await row.fetchone()
    return dict(result) if result else None
