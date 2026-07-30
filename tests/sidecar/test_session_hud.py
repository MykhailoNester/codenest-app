"""Tests for session_hud_service — the per-pane session-state HUD read path —
and the two agent_service.record_stop behaviours the HUD depends on.

Coverage:
1. Pane resolution: agent_sessions.pane_id vs. the agent_runs fallback, and
   which wins when both exist (D5).
2. list_live_huds: exactly one row per pane, ended sessions excluded, clean
   database yields [].
3. TodoWrite progress: newest-wins, absent-when-missing, absent-on-malformed.
4. The "thinking" inference state machine (D7).
5. record_stop's context_tokens write: the exact formula, and that it
   overwrites (not sums) across turns.
6. context_tokens' 0-maps-to-null and context_window-for-an-unmapped-model
   honesty rules.
7. Regression net for the (defective, deliberately untouched) Sonnet-4 cost
   arithmetic — see D8.
"""

from __future__ import annotations

import json
import uuid

import aiosqlite
import pytest

from app.services import agent_service, session_hud_service

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
    context_tokens: int = 0,
    current_tool: str | None = None,
    current_tool_started_at: str | None = None,
) -> None:
    await db.execute(
        """INSERT INTO agent_sessions
           (session_id, status, cost_usd, pane_id, model, context_tokens,
            current_tool, current_tool_started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session_id,
            status,
            cost_usd,
            pane_id,
            model,
            context_tokens,
            current_tool,
            current_tool_started_at,
        ),
    )
    await db.commit()


async def _insert_run(db: aiosqlite.Connection, session_id: str, pane_id: str) -> None:
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


async def _get_session(
    db: aiosqlite.Connection, session_id: str
) -> aiosqlite.Row | None:
    cursor = await db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    return await cursor.fetchone()


# ---------------------------------------------------------------------------
# Pane resolution (D5)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pane_hud_resolves_via_agent_runs(migrated_db: aiosqlite.Connection):
    """The common case: a pane's first session has pane_id NULL, so
    resolution must fall back through agent_runs."""
    session_id = _gen_uuid()
    pane_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=None)
    await _insert_run(migrated_db, session_id, pane_id)

    hud = await session_hud_service.build_hud_for_pane(migrated_db, pane_id)
    assert hud is not None
    assert hud["session_id"] == session_id
    assert hud["pane_id"] == pane_id


@pytest.mark.asyncio
async def test_pane_hud_prefers_stamped_session_pane_id(
    migrated_db: aiosqlite.Connection,
):
    """After a /clear stamp, agent_sessions.pane_id wins over any agent_runs
    row for the same session."""
    session_id = _gen_uuid()
    stamped_pane_id = _gen_uuid()
    other_pane_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=stamped_pane_id)
    await _insert_run(migrated_db, session_id, other_pane_id)

    hud = await session_hud_service.build_hud_for_pane(migrated_db, stamped_pane_id)
    assert hud is not None
    assert hud["session_id"] == session_id
    assert hud["pane_id"] == stamped_pane_id


@pytest.mark.asyncio
async def test_pane_hud_none_for_unknown_pane(migrated_db: aiosqlite.Connection):
    """An unresolvable pane returns None outright, never a half-filled dict."""
    hud = await session_hud_service.build_hud_for_pane(migrated_db, _gen_uuid())
    assert hud is None


# ---------------------------------------------------------------------------
# list_live_huds
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_live_huds_one_row_per_pane(migrated_db: aiosqlite.Connection):
    """Two sessions bound to the same pane (idle + active, as after /clear)
    dedupe to exactly one entry: the active one (D5)."""
    pane_id = _gen_uuid()
    idle_id = _gen_uuid()
    active_id = _gen_uuid()
    await _insert_session(migrated_db, idle_id, pane_id=pane_id, status="idle")
    await _insert_session(migrated_db, active_id, pane_id=pane_id, status="active")

    huds = await session_hud_service.list_live_huds(migrated_db)
    matching = [h for h in huds if h["pane_id"] == pane_id]
    assert len(matching) == 1
    assert matching[0]["session_id"] == active_id


@pytest.mark.asyncio
async def test_live_huds_excludes_ended(migrated_db: aiosqlite.Connection):
    ended_id = _gen_uuid()
    active_id = _gen_uuid()
    await _insert_session(migrated_db, ended_id, pane_id=_gen_uuid(), status="ended")
    await _insert_session(migrated_db, active_id, pane_id=_gen_uuid(), status="active")

    huds = await session_hud_service.list_live_huds(migrated_db)
    ids = {h["session_id"] for h in huds}
    assert ended_id not in ids
    assert active_id in ids


@pytest.mark.asyncio
async def test_live_huds_empty_on_clean_db(migrated_db: aiosqlite.Connection):
    assert await session_hud_service.list_live_huds(migrated_db) == []


# ---------------------------------------------------------------------------
# TodoWrite progress
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_todo_progress_reads_newest_todowrite(migrated_db: aiosqlite.Connection):
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

    hud = await session_hud_service.build_hud_for_session(migrated_db, session_id)
    assert hud is not None
    assert (hud["todo_done"], hud["todo_total"]) == (5, 8)


@pytest.mark.asyncio
async def test_todo_absent_without_todowrite(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=_gen_uuid())
    await _insert_event(migrated_db, session_id, "UserPromptSubmit")
    await _insert_event(migrated_db, session_id, "PreToolUse", tool_name="Edit")

    hud = await session_hud_service.build_hud_for_session(migrated_db, session_id)
    assert hud is not None
    # Explicitly not (0, 0) — a real-but-empty todo list would be a lie here.
    assert (hud["todo_done"], hud["todo_total"]) == (None, None)


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

    hud = await session_hud_service.build_hud_for_session(migrated_db, session_id)
    assert hud is not None
    assert (hud["todo_done"], hud["todo_total"]) == (None, None)


# ---------------------------------------------------------------------------
# Thinking inference (D7)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_thinking_true_after_post_tool(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=_gen_uuid(), status="active")
    await _insert_event(migrated_db, session_id, "PostToolUse", tool_name="Edit")

    hud = await session_hud_service.build_hud_for_session(migrated_db, session_id)
    assert hud is not None
    assert hud["thinking"] is True


@pytest.mark.asyncio
async def test_thinking_false_while_tool_running(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(
        migrated_db,
        session_id,
        pane_id=_gen_uuid(),
        status="active",
        current_tool="Edit",
    )
    await _insert_event(migrated_db, session_id, "PreToolUse", tool_name="Edit")

    hud = await session_hud_service.build_hud_for_session(migrated_db, session_id)
    assert hud is not None
    assert hud["thinking"] is False


@pytest.mark.asyncio
async def test_thinking_false_when_idle(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(migrated_db, session_id, pane_id=_gen_uuid(), status="idle")
    await _insert_event(migrated_db, session_id, "Stop")

    hud = await session_hud_service.build_hud_for_session(migrated_db, session_id)
    assert hud is not None
    assert hud["thinking"] is False


# ---------------------------------------------------------------------------
# context_window_for (pure)
# ---------------------------------------------------------------------------


def test_context_window_for_rules():
    assert session_hud_service.context_window_for("claude-opus-4-5-20251101") == 200_000
    assert session_hud_service.context_window_for("claude-opus-5[1m]") == 1_000_000
    assert session_hud_service.context_window_for("gpt-5") is None
    assert session_hud_service.context_window_for(None) is None


@pytest.mark.asyncio
async def test_context_window_unknown_model_is_none(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await _insert_session(
        migrated_db,
        session_id,
        pane_id=_gen_uuid(),
        model="gpt-5",
        context_tokens=12_345,
    )

    hud = await session_hud_service.build_hud_for_session(migrated_db, session_id)
    assert hud is not None
    assert hud["context_window"] is None


@pytest.mark.asyncio
async def test_context_zero_maps_to_null(migrated_db: aiosqlite.Connection):
    """The migration's DEFAULT 0 backfill must never render as a fake 0%."""
    session_id = _gen_uuid()
    await _insert_session(
        migrated_db, session_id, pane_id=_gen_uuid(), model="claude-opus-4-5"
    )

    hud = await session_hud_service.build_hud_for_session(migrated_db, session_id)
    assert hud is not None
    assert hud["context_tokens"] is None


# ---------------------------------------------------------------------------
# record_stop's context_tokens write
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_context_tokens_written_on_stop(
    migrated_db: aiosqlite.Connection, tmp_path
):
    session_id = _gen_uuid()
    transcript = tmp_path / "transcript.jsonl"
    usage = {
        "input_tokens": 1000,
        "cache_creation_input_tokens": 200,
        "cache_read_input_tokens": 300,
        "output_tokens": 500,
    }
    transcript.write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {"model": "claude-opus-4-5", "usage": usage},
            }
        )
        + "\n"
    )

    await agent_service.record_stop(
        migrated_db, {"session_id": session_id, "transcript_path": str(transcript)}
    )

    row = await _get_session(migrated_db, session_id)
    assert row is not None
    assert row["context_tokens"] == 1000 + 300 + 200

    # A second Stop with a different-sized turn must overwrite, not sum.
    usage2 = {
        "input_tokens": 50,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 10,
        "output_tokens": 5,
    }
    transcript.write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {"model": "claude-opus-4-5", "usage": usage2},
            }
        )
        + "\n"
    )
    await agent_service.record_stop(
        migrated_db, {"session_id": session_id, "transcript_path": str(transcript)}
    )
    row_after = await _get_session(migrated_db, session_id)
    assert row_after is not None
    assert row_after["context_tokens"] == 50 + 10 + 0


@pytest.mark.asyncio
async def test_record_stop_cost_arithmetic_unchanged(
    migrated_db: aiosqlite.Connection, tmp_path
):
    """Regression net for a deliberate non-change (D8).

    Sonnet-4 pricing ($3/M input, cached $0.30/M, $15/M output) is a known
    accuracy defect — it prices every model at these rates — tracked as its
    own follow-up. This test only pins that THIS branch does not change the
    number it produces. If it starts failing because the pricing bug was
    fixed, that is expected and correct — move the fix to its own branch,
    do not "repair" this test in place.
    """
    session_id = _gen_uuid()
    transcript = tmp_path / "transcript.jsonl"
    usage = {
        "input_tokens": 1_000_000,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
    }
    transcript.write_text(
        json.dumps({"type": "assistant", "message": {"usage": usage}}) + "\n"
    )

    await agent_service.record_stop(
        migrated_db, {"session_id": session_id, "transcript_path": str(transcript)}
    )

    row = await _get_session(migrated_db, session_id)
    assert row is not None
    expected_cost = (1_000_000 * 3 + 1_000_000 * 0.30 + 1_000_000 * 15) / 1_000_000
    assert row["cost_usd"] == pytest.approx(expected_cost)
