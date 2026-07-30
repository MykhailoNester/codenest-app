"""Per-pane session-state HUD — read-only SQL and derivation.

Backs the ``<SessionHud/>`` strip rendered under every terminal pane: model,
context occupancy, tokens/window, session cost, elapsed, the live tool, an
inferred "thinking" state, and TodoWrite progress. Every field on
``SessionHudPane`` is ``None`` when the app genuinely does not know the
value — see the honesty contract documented on that model.

Imports nothing from ``agent_service`` so ``agent_service`` can import this
module at top level (to attach ``hud`` to its SSE broadcasts) with no import
cycle.
"""

from __future__ import annotations

import json
import logging

import aiosqlite

from app.models.session_hud import SessionHudPane

log = logging.getLogger(__name__)

# Published context windows, longest-match-first. A model that matches no rule
# yields None and the context cells are omitted — never guessed. Add a rule
# here when a new window size ships.
_CONTEXT_WINDOW_RULES: tuple[tuple[str, int], ...] = (
    ("[1m]", 1_000_000),  # 1M-context variants advertise it in the model id
    ("claude-", 200_000),  # every shipped Claude model
)

# How far back to look for the newest TodoWrite PreToolUse. Bounds the index
# walk on long sessions; a todo list older than this yields None (cell absent)
# rather than an unbounded scan.
_TODO_LOOKBACK_EVENTS = 400

# Newest-event types that mean "the model is working". No thinking hook exists
# (research §05 calls this out as the one real gap in the hook surface) — this
# is an inference, not a fact. A PreToolUse newest event makes this False by
# construction (current_tool becomes non-NULL then), so the tool cell and the
# thinking cell never both render for the same pane.
_THINKING_EVENT_TYPES = frozenset({"UserPromptSubmit", "PostToolUse"})

_ROW_QUERY = """
    SELECT s.session_id, s.status, s.model, s.cost_usd, s.started_at,
           s.last_event_at, s.current_tool, s.current_tool_started_at,
           s.context_tokens,
           COALESCE(s.pane_id, (
               SELECT r.pane_id FROM agent_runs r
               WHERE r.session_id = s.session_id AND r.pane_id IS NOT NULL
               ORDER BY r.started_at DESC LIMIT 1
           )) AS pane_id,
           pm.display_name AS model_display,
           (SELECT e.event_type FROM agent_events e
            WHERE e.session_id = s.session_id
            ORDER BY e.id DESC LIMIT 1) AS latest_event_type
    FROM agent_sessions s
    LEFT JOIN provider_models pm ON pm.model_name = s.model
    WHERE {where}
"""

_TODO_QUERY = """
    SELECT payload_json FROM (
        SELECT id, event_type, tool_name, payload_json
        FROM agent_events WHERE session_id = ?
        ORDER BY id DESC LIMIT ?
    ) WHERE event_type = 'PreToolUse' AND tool_name = 'TodoWrite'
    ORDER BY id DESC LIMIT 1
"""


def context_window_for(model: str | None) -> int | None:
    """First matching rule in ``_CONTEXT_WINDOW_RULES``, else ``None``."""
    if not model:
        return None
    for needle, window in _CONTEXT_WINDOW_RULES:
        if needle in model:
            return window
    return None


def _iso_t(value: str | None) -> str | None:
    """Normalize a SQLite timestamp to a ``T``-separated ISO-8601 string.

    Row timestamps are naive UTC (``agent_service._now()``), but rows
    inserted via ``DEFAULT CURRENT_TIMESTAMP`` (e.g. in tests) are
    space-separated. The frontend's ``parseUtcMs`` expects one consistent
    separator before it appends ``Z``.
    """
    if value is None:
        return None
    return value.replace(" ", "T")


def _thinking(status: str, latest_event_type: str | None) -> bool:
    return status == "active" and latest_event_type in _THINKING_EVENT_TYPES


async def _todo_progress(
    db: aiosqlite.Connection, session_id: str
) -> tuple[int | None, int | None]:
    """Return (done, total) from the newest TodoWrite PreToolUse payload.

    ``(None, None)`` when there is no TodoWrite in the lookback window, or
    when the payload does not parse into the expected shape — never
    ``(0, 0)``, which would claim a real-but-empty todo list.
    """
    cursor = await db.execute(_TODO_QUERY, (session_id, _TODO_LOOKBACK_EVENTS))
    row = await cursor.fetchone()
    if row is None:
        return None, None
    try:
        payload = json.loads(row["payload_json"])
        todos = payload.get("tool_input", {}).get("todos")
        if not isinstance(todos, list) or not todos:
            return None, None
        total = len(todos)
        done = sum(
            1 for t in todos if isinstance(t, dict) and t.get("status") == "completed"
        )
        return done, total
    except (
        json.JSONDecodeError,
        TypeError,
        ValueError,
        AttributeError,
    ):
        return None, None


def _row_to_pane(
    row: aiosqlite.Row, todo_done: int | None, todo_total: int | None
) -> SessionHudPane | None:
    pane_id = row["pane_id"]
    if not pane_id:
        return None
    return SessionHudPane(
        pane_id=pane_id,
        session_id=row["session_id"],
        status=row["status"],
        model=row["model"],
        model_display=row["model_display"],
        context_tokens=row["context_tokens"],
        context_window=context_window_for(row["model"]),
        # cost_usd is passed through exactly as agent_service.record_stop stored
        # it. That computation (app/services/agent_service.py:444-445) prices
        # EVERY model at Sonnet-4 rates, which is a real accuracy defect
        # tracked as its own P1 item. Do not "fix" it here — this strip only
        # surfaces the stored value.
        cost_usd=row["cost_usd"] or 0.0,
        started_at=_iso_t(row["started_at"]) or "",
        current_tool=row["current_tool"],
        current_tool_started_at=_iso_t(row["current_tool_started_at"]),
        thinking=_thinking(row["status"], row["latest_event_type"]),
        todo_done=todo_done,
        todo_total=todo_total,
    )


async def get_hud(db: aiosqlite.Connection, session_id: str) -> SessionHudPane | None:
    """Return the HUD facts for one session, or ``None`` if it — or its
    pane — cannot be resolved."""
    cursor = await db.execute(
        _ROW_QUERY.format(where="s.session_id = ?"), (session_id,)
    )
    row = await cursor.fetchone()
    if row is None:
        return None
    done, total = await _todo_progress(db, session_id)
    return _row_to_pane(row, done, total)


async def list_hud(db: aiosqlite.Connection, limit: int = 50) -> list[SessionHudPane]:
    """Return HUD facts for every pane-bound, non-ended session.

    Ordered newest-active-first, bounded by ``limit``.
    """
    inner = _ROW_QUERY.format(where="s.status IN ('active', 'idle', 'stopped')")
    # `pane_id` is a result-column alias produced by the COALESCE inside the
    # row query above. SQLite tolerates referencing an alias in an outer
    # WHERE, but doing it in the SAME select's WHERE clause is a non-standard
    # extension that reads as a bug — so the filter is applied to a wrapping
    # SELECT instead, where `pane_id` is an ordinary output column.
    cursor = await db.execute(
        f"SELECT * FROM ({inner}) WHERE pane_id IS NOT NULL "
        f"ORDER BY last_event_at DESC LIMIT ?",
        (limit,),
    )
    rows = await cursor.fetchall()
    panes: list[SessionHudPane] = []
    for row in rows:
        done, total = await _todo_progress(db, row["session_id"])
        pane = _row_to_pane(row, done, total)
        if pane is not None:
            panes.append(pane)
    return panes
