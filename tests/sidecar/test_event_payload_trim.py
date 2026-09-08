"""Tests for the `agent_events.payload_json` trim (#159).

`_trim_event_payload` is the single function that decides what
`_append_event` stores; these tests drive the real `record_*` recorders
against a migrated database so the ordering invariant is exercised, not
stubbed: `_summarize_tool_input` (agent_service.py:360) and
`attribution_service.extract_touched_path` (agent_service.py:397-399) both
read the payload BEFORE the trim runs, and must keep doing so.
"""

from __future__ import annotations

import json
import os
import pathlib
import uuid

import aiosqlite
import pytest

from app.services import agent_service, session_hud_service

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gen_uuid() -> str:
    return str(uuid.uuid4())


async def _latest_event(
    db: aiosqlite.Connection, session_id: str, event_type: str | None = None
) -> aiosqlite.Row:
    if event_type is not None:
        cur = await db.execute(
            """SELECT * FROM agent_events
               WHERE session_id = ? AND event_type = ?
               ORDER BY id DESC LIMIT 1""",
            (session_id, event_type),
        )
    else:
        cur = await db.execute(
            """SELECT * FROM agent_events
               WHERE session_id = ?
               ORDER BY id DESC LIMIT 1""",
            (session_id,),
        )
    row = await cur.fetchone()
    assert row is not None
    return row


async def _get_session(
    db: aiosqlite.Connection, session_id: str
) -> aiosqlite.Row | None:
    cursor = await db.execute(
        "SELECT * FROM agent_sessions WHERE session_id = ?", (session_id,)
    )
    return await cursor.fetchone()


async def _insert_project(
    db: aiosqlite.Connection, name: str, root: pathlib.Path
) -> int:
    # Store the canonical (realpath) root, mirroring how import resolves
    # paths, so prefix matching is robust against the macOS /var ->
    # /private/var symlink (see tests/sidecar/test_attribution.py).
    root_path = os.path.realpath(str(root))
    cur = await db.execute(
        "INSERT INTO projects (name, status, path, root_path, is_workspace, is_active) "
        "VALUES (?, 'active', ?, ?, 0, 1)",
        (name, root_path, root_path),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


# ---------------------------------------------------------------------------
# Core trim behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_tool_with_huge_tool_response_stores_under_1kb(
    migrated_db: aiosqlite.Connection,
):
    session_id = _gen_uuid()
    await agent_service.record_post_tool(
        migrated_db,
        {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_use_id": "toolu_1",
            "tool_input": {"command": "x" * 50_000},
            "tool_response": {"stdout": "y" * 200_000, "stderr": ""},
        },
    )
    row = await _latest_event(migrated_db, session_id, "PostToolUse")
    assert len(row["payload_json"]) < 1024
    assert "tool_response" not in row["payload_json"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tool_name",
    ["Bash", "Read", "Write", "Edit", "Grep", "Task", "TodoWrite"],
)
async def test_tool_response_never_stored_for_any_tool(
    migrated_db: aiosqlite.Connection, tool_name: str
):
    session_id = _gen_uuid()
    await agent_service.record_post_tool(
        migrated_db,
        {
            "session_id": session_id,
            "tool_name": tool_name,
            "tool_use_id": "toolu_1",
            "tool_input": {"anything": "goes here"},
            "tool_response": {"result": "should never be stored"},
        },
    )
    row = await _latest_event(migrated_db, session_id, "PostToolUse")
    parsed = json.loads(row["payload_json"])
    assert "tool_response" not in parsed


@pytest.mark.asyncio
async def test_todowrite_pre_tool_still_feeds_todo_progress(
    migrated_db: aiosqlite.Connection,
):
    session_id = _gen_uuid()
    todos = [
        {"content": "a", "status": "completed", "activeForm": "doing a"},
        {"content": "b", "status": "pending", "activeForm": "doing b"},
        {"content": "c", "status": "pending", "activeForm": "doing c"},
    ]
    await agent_service.record_pre_tool(
        migrated_db,
        {
            "session_id": session_id,
            "tool_name": "TodoWrite",
            "tool_use_id": "toolu_1",
            "tool_input": {"todos": todos, "junk": "z" * 10_000},
        },
    )
    done, total = await session_hud_service._todo_progress(migrated_db, session_id)
    assert (done, total) == (1, 3)


@pytest.mark.asyncio
async def test_task_pre_tool_still_matches_invocation_queries(
    migrated_db: aiosqlite.Connection,
):
    session_id = _gen_uuid()
    await agent_service.record_pre_tool(
        migrated_db,
        {
            "session_id": session_id,
            "tool_name": "Task",
            "tool_use_id": "toolu_1",
            "tool_input": {
                "subagent_type": "planner-agent",
                "name": "Plan the release",
                "description": "Work out the rollout order",
                "prompt": "p" * 100_000,
            },
        },
    )
    stats = await agent_service.get_agent_invocation_stats(
        migrated_db, "planner-agent", "all"
    )
    assert stats["total_invocations"] == 1

    total, invocations = await agent_service.list_agent_invocations(
        migrated_db, "planner-agent", "all"
    )
    assert total == 1
    assert invocations[0]["label"] == "Plan the release"
    assert invocations[0]["description"] == "Work out the rollout order"


@pytest.mark.asyncio
async def test_source_attribution_fields_survive(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await agent_service.record_pre_tool(
        migrated_db,
        {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_use_id": "toolu_1",
            "tool_input": {"command": "ls"},
            "source_kind": "task",
            "source_id": 42,
        },
    )
    row = await _latest_event(migrated_db, session_id, "PreToolUse")
    parsed = json.loads(row["payload_json"])
    assert parsed["source_kind"] == "task"
    assert parsed["source_id"] == 42


@pytest.mark.asyncio
async def test_top_level_allowlist_kept_and_everything_else_dropped(
    migrated_db: aiosqlite.Connection,
):
    session_id = _gen_uuid()
    payload = {
        "session_id": session_id,
        "cwd": "/tmp/proj",
        "hook_event_name": "PreToolUse",
        "permission_mode": "acceptEdits",
        "effort": "high",
        "source_kind": "task",
        "source_id": 42,
        "tool_name": "Bash",
        "tool_use_id": "toolu_1",
        "prompt_id": "prompt-abc",
        "transcript_path": "/tmp/transcript.jsonl",
        "model": "claude-opus-4-5",
        "junk_field": "nope",
    }
    await agent_service.record_pre_tool(migrated_db, payload)
    row = await _latest_event(migrated_db, session_id, "PreToolUse")
    parsed = json.loads(row["payload_json"])

    for key in (
        "session_id",
        "cwd",
        "hook_event_name",
        "permission_mode",
        "effort",
        "source_kind",
        "source_id",
        "tool_name",
        "tool_use_id",
        "prompt_id",
    ):
        assert key in parsed, key

    for key in ("transcript_path", "model", "junk_field"):
        assert key not in parsed, key

    assert parsed["truncated"] is True


@pytest.mark.asyncio
async def test_long_strings_are_capped_and_flagged(migrated_db: aiosqlite.Connection):
    session_id = _gen_uuid()
    await agent_service.record_session_start(
        migrated_db,
        {"session_id": session_id, "cwd": "c" * 5000},
    )
    row = await _latest_event(migrated_db, session_id, "SessionStart")
    parsed = json.loads(row["payload_json"])
    assert len(parsed["cwd"]) == 2048
    assert parsed["truncated"] is True


@pytest.mark.asyncio
async def test_clean_payload_carries_no_truncated_flag(
    migrated_db: aiosqlite.Connection,
):
    session_id = _gen_uuid()
    await agent_service.record_session_start(
        migrated_db,
        {"session_id": session_id, "cwd": "/tmp/proj"},
    )
    row = await _latest_event(migrated_db, session_id, "SessionStart")
    parsed = json.loads(row["payload_json"])
    assert "truncated" not in parsed


# ---------------------------------------------------------------------------
# Ordering guard — the invariant that makes trimming-at-insert safe
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pre_tool_summary_is_computed_before_the_trim(
    migrated_db: aiosqlite.Connection,
):
    session_id = _gen_uuid()
    await agent_service.record_pre_tool(
        migrated_db,
        {
            "session_id": session_id,
            "tool_name": "Edit",
            "tool_use_id": "toolu_1",
            "tool_input": {"file_path": "/tmp/proj/a.py", "new_string": "x" * 50_000},
        },
    )
    row = await _latest_event(migrated_db, session_id, "PreToolUse")
    assert row["summary"] == "Edit: /tmp/proj/a.py"
    parsed = json.loads(row["payload_json"])
    assert "tool_input" not in parsed


@pytest.mark.asyncio
async def test_post_tool_attribution_is_computed_before_the_trim(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
):
    project_root = tmp_path / "proj"
    project_root.mkdir()
    project_id = await _insert_project(migrated_db, "proj", project_root)

    session_id = _gen_uuid()
    file_path = str(project_root / "a.py")
    await agent_service.record_post_tool(
        migrated_db,
        {
            "session_id": session_id,
            "tool_name": "Edit",
            "tool_use_id": "toolu_1",
            "tool_input": {"file_path": file_path},
            "tool_response": {"result": "y" * 200_000},
        },
    )
    row = await _latest_event(migrated_db, session_id, "PostToolUse")
    assert row["project_id"] == project_id
    assert row["summary"] == "Edit done"
    parsed = json.loads(row["payload_json"])
    assert "tool_input" not in parsed
    assert "tool_response" not in parsed


@pytest.mark.asyncio
async def test_user_prompt_body_is_dropped_but_session_keeps_full_prompt(
    migrated_db: aiosqlite.Connection,
):
    session_id = _gen_uuid()
    prompt = "p" * 5000
    await agent_service.record_user_prompt(
        migrated_db, {"session_id": session_id, "prompt": prompt}
    )
    row = await _latest_event(migrated_db, session_id, "UserPromptSubmit")
    parsed = json.loads(row["payload_json"])
    assert "prompt" not in parsed
    assert parsed["truncated"] is True

    sess = await _get_session(migrated_db, session_id)
    assert sess is not None
    assert sess["initial_prompt"] == prompt
    assert row["summary"] == prompt[:199] + "…"


def test_non_dict_payload_becomes_empty_object() -> None:
    assert agent_service._trim_event_payload("Bash", ["not", "a", "dict"]) == {}
