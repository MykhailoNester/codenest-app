"""Tests for per-project cost attribution (Command Center, migration 062)."""

from __future__ import annotations

import os
import pathlib

import aiosqlite
import pytest

from app.services import attribution_service as attr

# ---------------------------------------------------------------------------
# extract_touched_path
# ---------------------------------------------------------------------------


def test_extract_touched_path_file_tools() -> None:
    for tool in ("Read", "Edit", "Write", "NotebookEdit"):
        assert attr.extract_touched_path(tool, {"file_path": "/a/b.py"}) == "/a/b.py"


def test_extract_touched_path_bash_uses_cwd() -> None:
    # Bash carries `command` in tool_input; the cwd is a separate top-level
    # payload field passed in explicitly.
    assert attr.extract_touched_path("Bash", {"command": "ls"}, "/a/proj") == "/a/proj"
    assert attr.extract_touched_path("Bash", {"command": "ls"}, None) is None
    assert attr.extract_touched_path("Bash", {"command": "ls"}) is None


def test_extract_touched_path_other_and_invalid() -> None:
    assert attr.extract_touched_path("Grep", {"pattern": "x"}) is None
    assert attr.extract_touched_path("Edit", {"file_path": "  "}) is None
    assert attr.extract_touched_path("Edit", "notadict") is None
    assert attr.extract_touched_path(None, {}) is None


# ---------------------------------------------------------------------------
# resolve_path_to_project
# ---------------------------------------------------------------------------


async def _insert_project(
    db: aiosqlite.Connection, name: str, root: pathlib.Path, *, is_workspace: int = 0
) -> int:
    # Store the canonical (realpath) root, mirroring how import resolves paths,
    # so prefix matching is robust against the macOS /var -> /private/var symlink.
    root_path = os.path.realpath(str(root))
    cur = await db.execute(
        "INSERT INTO projects (name, status, path, root_path, is_workspace, is_active) "
        "VALUES (?, 'active', ?, ?, ?, 1)",
        (name, root_path, root_path, is_workspace),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


@pytest.mark.asyncio
async def test_resolve_matches_longest_prefix(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    proj = tmp_path / "alpha"
    proj.mkdir()
    pid = await _insert_project(migrated_db, "alpha", proj)
    assert (
        await attr.resolve_path_to_project(migrated_db, str(proj / "src/x.py")) == pid
    )
    assert await attr.resolve_path_to_project(migrated_db, str(proj)) == pid
    assert (
        await attr.resolve_path_to_project(migrated_db, str(tmp_path / "beta/x.py"))
        is None
    )


@pytest.mark.asyncio
async def test_resolve_follows_symlink_back_to_project(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    proj = tmp_path / "gamma"
    agents = proj / ".claude" / "agents"
    agents.mkdir(parents=True)
    real_agent = agents / "a.md"
    real_agent.write_text("x")
    pid = await _insert_project(migrated_db, "gamma", proj)
    link = tmp_path / "workspace_link.md"
    link.symlink_to(real_agent)
    # A file edited through a workspace symlink resolves back to its project.
    assert await attr.resolve_path_to_project(migrated_db, str(link)) == pid


@pytest.mark.asyncio
async def test_resolve_excludes_workspace_project(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    ws = tmp_path / "ws"
    ws.mkdir()
    await _insert_project(migrated_db, "WS", ws, is_workspace=1)
    assert await attr.resolve_path_to_project(migrated_db, str(ws / "f.py")) is None


# ---------------------------------------------------------------------------
# attribute_turn_cost
# ---------------------------------------------------------------------------


async def _mk_session(
    db: aiosqlite.Connection, sid: str, project_id: int | None = None
) -> None:
    await db.execute(
        "INSERT INTO agent_sessions "
        "(session_id, profile, status, started_at, last_event_at, project_id) "
        "VALUES (?, 'unknown', 'active', datetime('now'), datetime('now'), ?)",
        (sid, project_id),
    )
    await db.commit()


async def _mk_event(
    db: aiosqlite.Connection, sid: str, event_type: str, project_id: int | None = None
) -> None:
    await db.execute(
        "INSERT INTO agent_events "
        "(session_id, event_type, payload_json, created_at, project_id) "
        "VALUES (?, ?, '{}', datetime('now'), ?)",
        (sid, event_type, project_id),
    )
    await db.commit()


async def _costs(db: aiosqlite.Connection, sid: str) -> dict[int, dict]:
    cur = await db.execute(
        "SELECT project_id, cost_usd, tokens_in, tokens_out "
        "FROM session_project_costs WHERE session_id = ? ORDER BY project_id",
        (sid,),
    )
    return {int(r["project_id"]): dict(r) for r in await cur.fetchall()}


@pytest.mark.asyncio
async def test_attribute_splits_proportionally(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _mk_session(migrated_db, "s1")
    for _ in range(3):
        await _mk_event(migrated_db, "s1", "PostToolUse", 10)
    await _mk_event(migrated_db, "s1", "PostToolUse", 20)
    await attr.attribute_turn_cost(migrated_db, "s1", 1.0, 400, 40)
    await migrated_db.commit()
    rows = await _costs(migrated_db, "s1")
    assert round(rows[10]["cost_usd"], 4) == 0.75
    assert round(rows[20]["cost_usd"], 4) == 0.25
    assert rows[10]["tokens_in"] == 300 and rows[20]["tokens_in"] == 100


@pytest.mark.asyncio
async def test_attribute_respects_turn_boundary(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _mk_session(migrated_db, "s2")
    await _mk_event(migrated_db, "s2", "PostToolUse", 10)  # previous turn
    await _mk_event(migrated_db, "s2", "Stop")  # boundary
    await _mk_event(migrated_db, "s2", "PostToolUse", 20)  # this turn
    await attr.attribute_turn_cost(migrated_db, "s2", 1.0, 100, 10)
    await migrated_db.commit()
    assert set(await _costs(migrated_db, "s2")) == {20}


@pytest.mark.asyncio
async def test_attribute_falls_back_to_session_bucket(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    # agent_sessions.project_id is a real FK, so use an imported project's id.
    pid = await _insert_project(migrated_db, "bucketproj", tmp_path / "bp")
    await _mk_session(migrated_db, "s3", project_id=pid)
    await _mk_event(migrated_db, "s3", "Stop")  # no tagged touches this turn
    await attr.attribute_turn_cost(migrated_db, "s3", 2.0, 0, 0)
    await migrated_db.commit()
    rows = await _costs(migrated_db, "s3")
    assert rows[pid]["cost_usd"] == 2.0


@pytest.mark.asyncio
async def test_attribute_falls_back_to_workspace(
    migrated_db: aiosqlite.Connection, tmp_path: pathlib.Path
) -> None:
    ws_id = await _insert_project(migrated_db, "WS", tmp_path / "ws", is_workspace=1)
    await _mk_session(migrated_db, "s4")  # no project_id
    await attr.attribute_turn_cost(migrated_db, "s4", 1.5, 0, 0)
    await migrated_db.commit()
    rows = await _costs(migrated_db, "s4")
    assert rows[ws_id]["cost_usd"] == 1.5


@pytest.mark.asyncio
async def test_attribute_noop_on_zero(migrated_db: aiosqlite.Connection) -> None:
    await _mk_session(migrated_db, "s5")
    await attr.attribute_turn_cost(migrated_db, "s5", 0.0, 0, 0)
    await migrated_db.commit()
    assert await _costs(migrated_db, "s5") == {}
