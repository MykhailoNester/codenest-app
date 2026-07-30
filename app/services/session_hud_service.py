"""Per-pane session-state HUD — read-only SQL and derivation.

Backs the ``<SessionHud/>`` strip rendered under every terminal pane: model,
context occupancy, tokens/window, session cost, elapsed, the live tool, an
inferred "thinking" state, and TodoWrite progress. Every optional field this
module returns is ``None`` when the app genuinely does not know the value —
see the honesty contract documented on ``app.models.session_hud.PaneHud``.

Imports nothing from ``agent_service``, so ``agent_service`` can import this
module (locally, inside the function that needs it — see ``_broadcast``) with
no import cycle.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import aiosqlite

log = logging.getLogger(__name__)

# Published context windows, keyed by a substring of the model id. Checked in
# insertion order, so the more specific "[1m]" rule is tried before the
# blanket "claude-" fallback. A model that matches nothing yields None and
# both ctx cells are omitted — never guessed. Add a rule here when a new
# window size ships.
#
# Known limitation (documented, not fixed): a session running under the
# 1M-context beta is indistinguishable from a 200k one once the model id
# itself doesn't say so, so it would under-report fill. The rendered
# "76k/200k" cell always shows its denominator, which makes this assumption
# visible to the user instead of hiding it.
_CONTEXT_WINDOWS: dict[str, int] = {
    "[1m]": 1_000_000,
    "claude-": 200_000,
}

# Newest-event types that mean "the model is composing, not running a tool
# and not idle." There is no hook for this — research §05 names it as the one
# real gap in the hook surface — so this is an inference, not a fact (D7).
# `current_tool is None` is what rules out "a tool is running" (that state
# gets its own cell), so the tool cell and the thinking cell never both
# render for the same pane.
_THINKING_EVENT_TYPES = frozenset({"UserPromptSubmit", "PostToolUse"})


def context_window_for(model: str | None) -> int | None:
    """First matching rule in ``_CONTEXT_WINDOWS``, else ``None``."""
    if not model:
        return None
    for needle, window in _CONTEXT_WINDOWS.items():
        if needle in model:
            return window
    return None


async def _pane_id_for_session(db: aiosqlite.Connection, session_id: str) -> str | None:
    """Resolve the pane a session is bound to.

    ``agent_sessions.pane_id`` is only stamped on the ``/clear`` relink path —
    a pane's *first* session leaves it NULL — so the fallback through the
    newest ``agent_runs`` row for this session is the common case, not an
    edge case.
    """
    cursor = await db.execute(
        "SELECT pane_id FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    row = await cursor.fetchone()
    if row is not None and row["pane_id"]:
        pane_id: str = row["pane_id"]
        return pane_id
    cursor = await db.execute(
        """SELECT pane_id FROM agent_runs
           WHERE session_id = ? AND pane_id IS NOT NULL
           ORDER BY started_at DESC LIMIT 1""",
        (session_id,),
    )
    run_row = await cursor.fetchone()
    return run_row["pane_id"] if run_row is not None else None


# Status priority used whenever more than one session could answer for the
# same pane (e.g. after `/clear`, the superseded session lingers `idle`
# alongside the new `active` one) — `active` wins, then `idle`, then
# `stopped`. Shared between `_session_id_for_pane` and `list_live_huds` (D5).
def _status_priority_sql(column: str) -> str:
    return (
        f"CASE {column} WHEN 'active' THEN 0 WHEN 'idle' THEN 1 "
        "WHEN 'stopped' THEN 2 ELSE 3 END"
    )


async def _session_id_for_pane(db: aiosqlite.Connection, pane_id: str) -> str | None:
    """Resolve the live session for a pane — the inverse of `_pane_id_for_session`.

    Prefers a session directly stamped with this ``pane_id``; falls back to a
    join through ``agent_runs`` for a pane whose current session was never
    relinked. Both branches break ties the same way (D5): `active` before
    `idle` before `stopped`, then most-recently-active first.
    """
    cursor = await db.execute(
        f"""SELECT session_id FROM agent_sessions
           WHERE pane_id = ?
           ORDER BY {_status_priority_sql("status")}, last_event_at DESC
           LIMIT 1""",
        (pane_id,),
    )
    row = await cursor.fetchone()
    if row is not None:
        session_id: str = row["session_id"]
        return session_id
    cursor = await db.execute(
        f"""SELECT s.session_id FROM agent_sessions s
           JOIN agent_runs r ON r.session_id = s.session_id
           WHERE r.pane_id = ?
           ORDER BY {_status_priority_sql("s.status")}, s.last_event_at DESC
           LIMIT 1""",
        (pane_id,),
    )
    run_row = await cursor.fetchone()
    return run_row["session_id"] if run_row is not None else None


_TODO_QUERY = """
    SELECT payload_json FROM agent_events
    WHERE session_id = ? AND event_type = 'PreToolUse' AND tool_name = 'TodoWrite'
    ORDER BY id DESC LIMIT 1
"""


async def _todo_progress(
    db: aiosqlite.Connection, session_id: str
) -> tuple[int | None, int | None]:
    """Return (done, total) from the newest TodoWrite PreToolUse payload.

    ``(None, None)`` when there is no TodoWrite event for this session, or
    when the payload does not parse into the expected shape — never
    ``(0, 0)``, which would claim a real-but-empty todo list.
    """
    cursor = await db.execute(_TODO_QUERY, (session_id,))
    row = await cursor.fetchone()
    if row is None:
        return None, None
    try:
        payload = json.loads(row["payload_json"])
        todos = payload.get("tool_input", {}).get("todos")
    except (json.JSONDecodeError, AttributeError, TypeError):
        return None, None
    if not isinstance(todos, list) or not todos:
        return None, None
    total = len(todos)
    done = sum(
        1 for t in todos if isinstance(t, dict) and t.get("status") == "completed"
    )
    return done, total


async def _newest_event_type(db: aiosqlite.Connection, session_id: str) -> str | None:
    cursor = await db.execute(
        "SELECT event_type FROM agent_events WHERE session_id = ? "
        "ORDER BY id DESC LIMIT 1",
        (session_id,),
    )
    row = await cursor.fetchone()
    return row["event_type"] if row is not None else None


def _thinking(
    status: str, current_tool: str | None, newest_event_type: str | None
) -> bool:
    """D7 — there is no "thinking" hook (research §05). This infers it:
    `active` excludes a stopped/ended session; `current_tool is None`
    excludes "a tool is running" (that has its own cell); a newest event of
    prompt-submitted or tool-just-finished is the only remaining window in
    which the model could plausibly be composing a reply. This is an
    approximation, not a hook-backed fact — the cell it drives is a boolean
    pulse with no attached number, so it never claims a precision it does
    not have.
    """
    return (
        status == "active"
        and current_tool is None
        and newest_event_type in _THINKING_EVENT_TYPES
    )


def _row_to_hud(
    row: aiosqlite.Row,
    pane_id: str,
    todo_done: int | None,
    todo_total: int | None,
    thinking: bool,
) -> dict[str, Any]:
    context_tokens = row["context_tokens"] or None
    model = row["model"]
    return {
        "pane_id": pane_id,
        "session_id": row["session_id"],
        "status": row["status"],
        "model": model,
        "context_tokens": context_tokens,
        "context_window": context_window_for(model),
        # cost_usd is passed through exactly as agent_service.record_stop
        # stored it. That computation (app/services/agent_service.py, around
        # the cost_delta assignment in record_stop) prices EVERY model at
        # Sonnet-4 rates, which is a real accuracy defect tracked as its own
        # P1 item. Do not "fix" it here — this strip only surfaces the
        # stored value.
        "cost_usd": row["cost_usd"] or 0.0,
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "current_tool": row["current_tool"],
        "current_tool_started_at": row["current_tool_started_at"],
        "thinking": thinking,
        "todo_done": todo_done,
        "todo_total": todo_total,
    }


async def build_hud_for_session(
    db: aiosqlite.Connection, session_id: str
) -> dict[str, Any] | None:
    """Build the HUD facts for one session, or ``None`` if the session or its
    pane cannot be resolved."""
    pane_id = await _pane_id_for_session(db, session_id)
    if pane_id is None:
        return None
    cursor = await db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    row = await cursor.fetchone()
    if row is None:
        return None
    newest_event_type = await _newest_event_type(db, session_id)
    todo_done, todo_total = await _todo_progress(db, session_id)
    thinking = _thinking(row["status"], row["current_tool"], newest_event_type)
    return _row_to_hud(row, pane_id, todo_done, todo_total, thinking)


async def build_hud_for_pane(
    db: aiosqlite.Connection, pane_id: str
) -> dict[str, Any] | None:
    """Build the HUD facts for whichever session currently owns ``pane_id``."""
    session_id = await _session_id_for_pane(db, pane_id)
    if session_id is None:
        return None
    return await build_hud_for_session(db, session_id)


# One round trip to resolve every candidate (session, pane) pair, ordered so
# that — once deduped in Python by pane_id — the first row kept per pane is
# the live one (D5). The subquery wrapper is required because a `COALESCE`
# alias cannot be referenced from the same SELECT's WHERE clause.
_LIVE_PANE_QUERY = f"""
    SELECT * FROM (
      SELECT s.session_id,
             COALESCE(
               s.pane_id,
               (SELECT r.pane_id FROM agent_runs r
                 WHERE r.session_id = s.session_id AND r.pane_id IS NOT NULL
                 ORDER BY r.started_at DESC LIMIT 1)
             ) AS pane_id,
             s.status, s.last_event_at
        FROM agent_sessions s
       WHERE s.status IN ('active', 'idle', 'stopped')
    ) WHERE pane_id IS NOT NULL
    ORDER BY {_status_priority_sql("status")}, last_event_at DESC
"""


async def list_live_huds(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    """Return one HUD row per pane with a live (non-ended) session.

    Two sessions can map to the same pane after a `/clear` (the superseded
    one lingers `idle`). ``_LIVE_PANE_QUERY``'s ordering makes the first
    occurrence of a given `pane_id` the one to keep (D5) — this dedupes
    in Python rather than in SQL, since the per-row HUD facts need a second,
    per-session query anyway (`build_hud_for_session`).
    """
    cursor = await db.execute(_LIVE_PANE_QUERY)
    rows = await cursor.fetchall()
    seen_panes: set[str] = set()
    huds: list[dict[str, Any]] = []
    for row in rows:
        pane_id: str = row["pane_id"]
        if pane_id in seen_panes:
            continue
        seen_panes.add(pane_id)
        hud = await build_hud_for_session(db, row["session_id"])
        if hud is not None:
            huds.append(hud)
    return huds
