"""Behaviour tests for agent_sessions provenance ingest (epic #153, P0).

Coverage:
- UserPromptSubmit, PreToolUse and Stop store `permission_mode` / `effort`
  when the payload carries them, verbatim.
- COALESCE no-clobber semantics: a later hook that omits a field keeps the
  stored value; a later hook that carries a different value overwrites
  (last-known-wins).
- Blank, non-string or absent values normalise to NULL — never the literal
  "unknown".
- The write is an UPDATE over an already-INSERTed row (session-start first,
  then a prompt), not dependent on `_upsert_session_start`'s INSERT branch.
- A hook POSTed against a database that has not yet run
  `009_agent_sessions_provenance` still returns `{"continue": true}` *and*
  still commits the rest of the hook's work (the `agent_events` row, the
  `current_tool` transition) — proving the guard lives inside the service,
  not in the router's `_safe_handle` rollback.
"""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.database import apply_migration_file
from app.routers import agents as agents_router

_M009 = "009_agent_sessions_provenance"
_MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


@pytest_asyncio.fixture
async def provenance_client(
    migrated_db: aiosqlite.Connection,
) -> tuple[TestClient, aiosqlite.Connection]:
    """Mount the agents router against the shared migrated DB."""
    original_db = db_module._db
    db_module._db = migrated_db
    application = FastAPI()
    application.include_router(agents_router.router)
    client = TestClient(application, raise_server_exceptions=True)
    yield client, migrated_db
    db_module._db = original_db


async def _row(
    db: aiosqlite.Connection, session_id: str
) -> tuple[str | None, str | None]:
    cur = await db.execute(
        "SELECT permission_mode, effort FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    )
    row = await cur.fetchone()
    assert row is not None
    return row["permission_mode"], row["effort"]


@pytest.mark.asyncio
async def test_user_prompt_stores_permission_mode(
    provenance_client: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = provenance_client
    resp = client.post(
        "/api/v1/hooks/user-prompt",
        json={
            "session_id": "sess-prompt-1",
            "cwd": "/repo",
            "prompt": "do the thing",
            "permission_mode": "acceptEdits",
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"continue": True}
    permission_mode, effort = await _row(db, "sess-prompt-1")
    assert permission_mode == "acceptEdits"
    # UserPromptSubmit in the live-DB sample carries no effort field.
    assert effort is None


@pytest.mark.asyncio
async def test_pre_tool_stores_permission_mode_and_effort(
    provenance_client: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = provenance_client
    resp = client.post(
        "/api/v1/hooks/pre-tool",
        json={
            "session_id": "sess-pretool-1",
            "cwd": "/repo",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "permission_mode": "plan",
            "effort": "high",
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"continue": True}
    permission_mode, effort = await _row(db, "sess-pretool-1")
    assert permission_mode == "plan"
    assert effort == "high"


@pytest.mark.asyncio
async def test_stop_stores_permission_mode_and_effort(
    provenance_client: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = provenance_client
    resp = client.post(
        "/api/v1/hooks/stop",
        json={
            "session_id": "sess-stop-1",
            "cwd": "/repo",
            # No transcript_path: _read_last_turn_usage short-circuits to
            # ({}, None), so this test needs no transcript fixture.
            "permission_mode": "acceptEdits",
            "effort": "low",
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"continue": True}
    permission_mode, effort = await _row(db, "sess-stop-1")
    assert permission_mode == "acceptEdits"
    assert effort == "low"


@pytest.mark.asyncio
async def test_session_start_then_prompt_updates_the_existing_row(
    provenance_client: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = provenance_client
    resp1 = client.post(
        "/api/v1/hooks/session-start",
        json={"session_id": "sess-start-then-prompt", "cwd": "/repo"},
    )
    assert resp1.status_code == 200
    assert resp1.json() == {"continue": True}
    # session-start writes no provenance.
    permission_mode, effort = await _row(db, "sess-start-then-prompt")
    assert permission_mode is None
    assert effort is None

    resp2 = client.post(
        "/api/v1/hooks/user-prompt",
        json={
            "session_id": "sess-start-then-prompt",
            "cwd": "/repo",
            "prompt": "continue",
            "permission_mode": "plan",
        },
    )
    assert resp2.status_code == 200
    assert resp2.json() == {"continue": True}
    permission_mode, effort = await _row(db, "sess-start-then-prompt")
    assert permission_mode == "plan"
    assert effort is None


@pytest.mark.asyncio
async def test_a_later_hook_omitting_the_fields_does_not_clobber(
    provenance_client: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = provenance_client
    resp1 = client.post(
        "/api/v1/hooks/pre-tool",
        json={
            "session_id": "sess-no-clobber",
            "cwd": "/repo",
            "tool_name": "Bash",
            "permission_mode": "plan",
            "effort": "high",
        },
    )
    assert resp1.status_code == 200

    resp2 = client.post(
        "/api/v1/hooks/stop",
        json={"session_id": "sess-no-clobber", "cwd": "/repo"},
    )
    assert resp2.status_code == 200
    assert resp2.json() == {"continue": True}

    permission_mode, effort = await _row(db, "sess-no-clobber")
    assert permission_mode == "plan"
    assert effort == "high"


@pytest.mark.asyncio
async def test_a_changed_value_overwrites(
    provenance_client: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = provenance_client
    resp1 = client.post(
        "/api/v1/hooks/pre-tool",
        json={
            "session_id": "sess-overwrite",
            "cwd": "/repo",
            "tool_name": "Bash",
            "permission_mode": "plan",
            "effort": "high",
        },
    )
    assert resp1.status_code == 200

    resp2 = client.post(
        "/api/v1/hooks/pre-tool",
        json={
            "session_id": "sess-overwrite",
            "cwd": "/repo",
            "tool_name": "Read",
            "permission_mode": "acceptEdits",
            "effort": "low",
        },
    )
    assert resp2.status_code == 200
    assert resp2.json() == {"continue": True}

    permission_mode, effort = await _row(db, "sess-overwrite")
    assert permission_mode == "acceptEdits"
    assert effort == "low"


@pytest.mark.asyncio
async def test_absent_fields_stay_null_never_unknown(
    provenance_client: tuple[TestClient, aiosqlite.Connection],
) -> None:
    client, db = provenance_client
    resp = client.post(
        "/api/v1/hooks/user-prompt",
        json={"session_id": "sess-absent", "cwd": "/repo", "prompt": "hi"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"continue": True}
    permission_mode, effort = await _row(db, "sess-absent")
    assert permission_mode is None
    assert permission_mode != "unknown"
    assert effort is None
    assert effort != "unknown"


@pytest.mark.asyncio
@pytest.mark.parametrize("junk", ["", "   ", 123, None, {"mode": "plan"}])
async def test_blank_or_non_string_values_are_null(
    provenance_client: tuple[TestClient, aiosqlite.Connection],
    junk: object,
) -> None:
    client, db = provenance_client
    session_id = f"sess-junk-{junk!r}"

    resp = client.post(
        "/api/v1/hooks/pre-tool",
        json={
            "session_id": session_id,
            "cwd": "/repo",
            "tool_name": "Bash",
            "permission_mode": junk,
            "effort": junk,
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"continue": True}
    permission_mode, effort = await _row(db, session_id)
    assert permission_mode is None
    assert effort is None

    # A junk value on a later hook must not clobber a real value already set.
    resp2 = client.post(
        "/api/v1/hooks/pre-tool",
        json={
            "session_id": session_id,
            "cwd": "/repo",
            "tool_name": "Bash",
            "permission_mode": "plan",
            "effort": "high",
        },
    )
    assert resp2.status_code == 200

    resp3 = client.post(
        "/api/v1/hooks/pre-tool",
        json={
            "session_id": session_id,
            "cwd": "/repo",
            "tool_name": "Bash",
            "permission_mode": junk,
            "effort": junk,
        },
    )
    assert resp3.status_code == 200
    permission_mode, effort = await _row(db, session_id)
    assert permission_mode == "plan"
    assert effort == "high"


@pytest.mark.asyncio
async def test_ingest_survives_a_db_without_migration_009(tmp_path) -> None:
    """A hook POSTed to a DB that has not run 009 still: (1) responds
    {"continue": true}, (2) commits the current_tool transition on
    agent_sessions, and (3) commits the agent_events row. The last two are
    what prove the guard sits inside the service rather than relying on
    _safe_handle's rollback — with an unguarded UPDATE the event row would be
    gone and only the first assertion would still pass."""
    conn = await aiosqlite.connect(str(tmp_path / "pre-009.db"))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    for migration_file in sorted(
        f for f in _MIGRATIONS_DIR.glob("*.sql") if f.stem < _M009
    ):
        await apply_migration_file(conn, migration_file)

    original_db = db_module._db
    db_module._db = conn
    try:
        application = FastAPI()
        application.include_router(agents_router.router)
        client = TestClient(application, raise_server_exceptions=True)

        resp = client.post(
            "/api/v1/hooks/pre-tool",
            json={
                "session_id": "sess-pre-009",
                "cwd": "/repo",
                "tool_name": "Bash",
                "tool_input": {"command": "ls"},
                "permission_mode": "plan",
                "effort": "high",
            },
        )
        assert resp.status_code == 200
        assert resp.json() == {"continue": True}

        session_row = await (
            await conn.execute(
                "SELECT current_tool FROM agent_sessions WHERE session_id = ?",
                ("sess-pre-009",),
            )
        ).fetchone()
        assert session_row is not None
        assert session_row["current_tool"] == "Bash"

        event_row = await (
            await conn.execute(
                "SELECT id FROM agent_events WHERE session_id = ? AND event_type = ?",
                ("sess-pre-009", "PreToolUse"),
            )
        ).fetchone()
        assert event_row is not None
    finally:
        db_module._db = original_db
        await conn.close()
