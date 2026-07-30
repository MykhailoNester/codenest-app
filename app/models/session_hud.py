"""Pydantic response shape for the per-pane session-state HUD strip.

Free of database imports, per the note at the top of ``app/models/hooks.py`` —
``app/services/session_hud_service.py`` builds these fields as a plain dict and
the router wraps them into ``PaneHud`` on the way out.

Honesty contract: every optional field below is ``None`` only when the app
genuinely does not know the value. The frontend must omit the corresponding
HUD cell rather than substitute a placeholder, a zero, or an em dash for a
``None`` — an absent cell is honest; a guessed one is not.
"""

from __future__ import annotations

from pydantic import BaseModel


class PaneHud(BaseModel):
    """One pane's worth of session-state facts, keyed by ``pane_id``.

    One entry represents one *pane*, not one session — a pane can outlive
    several sessions (e.g. across ``/clear``), and ``session_hud_service``
    is responsible for resolving which session currently owns it.
    """

    pane_id: str
    session_id: str
    status: str
    model: str | None = None
    context_tokens: int | None = None
    context_window: int | None = None
    cost_usd: float
    started_at: str
    ended_at: str | None = None
    current_tool: str | None = None
    current_tool_started_at: str | None = None
    thinking: bool
    todo_done: int | None = None
    todo_total: int | None = None
