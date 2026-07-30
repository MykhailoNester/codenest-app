"""Tests for session_hud_service — the per-pane session-state HUD read path.

Coverage:
1. Pane resolution: agent_sessions.pane_id vs. the agent_runs fallback (D5).
2. list_hud excludes sessions with no resolvable pane_id and ended sessions.
3. TodoWrite progress: newest-wins, absent-when-missing, absent-on-malformed.
4. The "thinking" inference state machine (D4).
5. context_window_for's static rule table.
6. context_tokens NULL passthrough.
7. Naive-UTC timestamp normalization to a T separator (D6).
8. model_display resolution via provider_models.
"""

from __future__ import annotations

import json
import uuid

import aiosqlite
import pytest

from app.services import session_hud_service

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gen_uuid() -> str:
    return str(uuid.uuid4())


async def _insert_session(
    db: aiosqlite.Connection,
    session_id: str,
    *,
    pane_id: str | None = None,
    status: str = "active",
    model: str | None = None,
    cost_usd: float = 0.0,
    context_tokens: int | None = None,
    current_tool: str | None = None,
    current_tool_started_at: str | None = None,
    started_at: str | None = None,
) -> None:
    columns = ["session_id", "status", "cost_usd", "pane_id", "model"]
    values: list[object] = [session_id, status, cost_usd, pane_id, model]
    if context_tokens is not None:
        columns.append("context_tokens")
        values.append(context_tokens)
    if current_tool is not None:
        columns.append("current_tool")
        values.append(current_tool)
    if current_tool_started_at is not None:
        columns.append("current_tool_started_at")
        values.append(current_tool_started_at)
    if started_at is not None:
        columns.append("started_at")
        values.append(started_at)
    placeholders = ", ".join("?" for _ in columns)
    await db.execute(
        f"INSERT INTO agent_sessions ({', '.join(columns)}) VALUES ({placeholders})",
        values,
    )
    await db.commit()


async def _insert_run(
    db: aiosqlite.Connection,
    session_id: str,
    pane_id: str,
) -> None:
    await db.execute(
        """INSERT INTO agent_runs (session_id, pane_id, status, started_at)
           VALUES (?, ?, 'running', datetime('now', '-1 minute'))""",
        (session_id, pane_id),
    )
    await db.commit()


async def _insert_event(
    db: aiosqlite.Connection,
    session_id: str,
    event_type: str,
    tool_name: str | None = None,
    payload: dict | None = None,
) -> None:
    await db.execute(
        """INSERT INTO agent_events (session_id, event_type, tool_name, summary, payload_json)
           VALUES (?, ?, ?, 'summary', ?)""",
        (session_id, event_type, tool_name, json.dumps(payload or {})),
    )
    await db.commit()


async def _provider_and_model(
    db: aiosqlite.Connection, model_name: str, display_name: str
) -> None:
    cur = await db.execute(
        "INSERT INTO providers (name, display_name, command_template) "
        "VALUES ('test-provider', 'Test Provider', 'claude {extra_args}')",
    )
    provider_id = cur.lastrowid
    await db.execute(
        "INSERT INTO provider_models (provider_id, model_name, display_name) "
        "VALUES (?, ?, ?)",
        (provider_id, model_name, display_name),
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Pane resolution (D5)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pane_id_resolved_from_agent_runs(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    pane_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=None)
    await _insert_run(migrated_db, session_id, pane_id)

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is not None
    assert pane.pane_id == pane_id


@pytest.mark.asyncio
async def test_pane_id_prefers_session_column(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    session_pane_id = _gen_uuid()
    run_pane_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=session_pane_id)
    await _insert_run(migrated_db, session_id, run_pane_id)

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is not None
    assert pane.pane_id == session_pane_id


@pytest.mark.asyncio
async def test_no_pane_id_returns_none(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=None)

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is None

    panes = await session_hud_service.list_hud(migrated_db)
    assert session_id not in {p.session_id for p in panes}


@pytest.mark.asyncio
async def test_list_hud_excludes_ended(migrated_db: aiosqlite.Connection):
    ended_id = _gen_uuid()
    active_id = _gen_uuid()
    await _insert_session(migrated_db, ended_id, pane_id=_gen_uuid(), status="ended")
    await _insert_session(migrated_db, active_id, pane_id=_gen_uuid(), status="active")

    panes = await session_hud_service.list_hud(migrated_db)
    ids = {p.session_id for p in panes}
    assert ended_id not in ids
    assert active_id in ids


# ---------------------------------------------------------------------------
# TodoWrite progress
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_todo_progress_from_newest_todowrite(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=_gen_uuid())
    older_todos = [{"status": "completed"}] * 1 + [{"status": "pending"}] * 2
    newer_todos = [{"status": "completed"}] * 5 + [{"status": "pending"}] * 3
    await _insert_event(
        migrated_db,
        session_id,
        "PreToolUse",
        tool_name="TodoWrite",
        payload={"tool_input": {"todos": older_todos}},
    )
    await _insert_event(
        migrated_db,
        session_id,
        "PreToolUse",
        tool_name="TodoWrite",
        payload={"tool_input": {"todos": newer_todos}},
    )

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is not None
    assert (pane.todo_done, pane.todo_total) == (5, 8)


@pytest.mark.asyncio
async def test_todo_absent_without_todowrite(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=_gen_uuid())
    await _insert_event(migrated_db, session_id, "UserPromptSubmit")
    await _insert_event(migrated_db, session_id, "PreToolUse", tool_name="Edit")

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is not None
    assert (pane.todo_done, pane.todo_total) == (None, None)


@pytest.mark.asyncio
async def test_todo_absent_on_malformed_payload(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=_gen_uuid())
    await _insert_event(
        migrated_db,
        session_id,
        "PreToolUse",
        tool_name="TodoWrite",
        payload={"tool_input": {"todos": "not-a-list"}},
    )

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is not None
    assert (pane.todo_done, pane.todo_total) == (None, None)


# ---------------------------------------------------------------------------
# Thinking inference (D4)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("newest_event_type", "status", "expected"),
    [
        ("UserPromptSubmit", "active", True),
        ("PostToolUse", "active", True),
        ("PreToolUse", "active", False),
        ("Stop", "idle", False),
        ("PostToolUse", "idle", False),
    ],
)
async def test_thinking_state_machine(
    migrated_db: aiosqlite.Connection,
    newest_event_type: str,
    status: str,
    expected: bool,
):
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=_gen_uuid(), status=status)
    await _insert_event(migrated_db, session_id, newest_event_type)

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is not None
    assert pane.thinking is expected


# ---------------------------------------------------------------------------
# context_window_for (pure)
# ---------------------------------------------------------------------------


def test_context_window_rules():
    assert session_hud_service.context_window_for("claude-opus-4-5-20251101") == 200_000
    assert session_hud_service.context_window_for("claude-opus-5[1m]") == 1_000_000
    assert session_hud_service.context_window_for("gpt-5") is None
    assert session_hud_service.context_window_for(None) is None


@pytest.mark.asyncio
async def test_context_fields_none_when_column_null(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(
        migrated_db, session_id, pane_id=_gen_uuid(), model="claude-opus-4-5"
    )

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is not None
    assert pane.context_tokens is None


# ---------------------------------------------------------------------------
# Timestamp normalization (D6)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_started_at_normalized_to_t(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    # No explicit started_at: the column DEFAULTs to space-separated
    # CURRENT_TIMESTAMP, exactly like a row a test harness inserts by hand.
    await _insert_session(migrated_db, session_id, pane_id=_gen_uuid())

    pane = await session_hud_service.get_hud(migrated_db, session_id)
    assert pane is not None
    assert " " not in pane.started_at
    assert "T" in pane.started_at


# ---------------------------------------------------------------------------
# model_display via provider_models
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_model_display_from_provider_models(migrated_db: aiosqlite.Connection):
    await _provider_and_model(migrated_db, "claude-opus-4-5-20251101", "Opus 4.5")
    with_display_id = _gen_uuid()
    without_display_id = _gen_uuid()
    await _insert_session(
        migrated_db,
        with_display_id,
        pane_id=_gen_uuid(),
        model="claude-opus-4-5-20251101",
    )
    await _insert_session(
        migrated_db,
        without_display_id,
        pane_id=_gen_uuid(),
        model="claude-sonnet-4-6",
    )

    with_pane = await session_hud_service.get_hud(migrated_db, with_display_id)
    without_pane = await session_hud_service.get_hud(migrated_db, without_display_id)
    assert with_pane is not None
    assert with_pane.model_display == "Opus 4.5"
    assert without_pane is not None
    assert without_pane.model_display is None
