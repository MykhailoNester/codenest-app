"""Unit tests for agent_runs_service.

Coverage:
1. persist_on_launch — inserts a row with status='running'.
2. mark_ended_by_pane — transitions status to 'ended'; returns row count.
3. session link (deterministic) — link_session back-fills session_id.
4. Concurrent same-project case — two runs in the same project get distinct
   session_ids after two independent link_session calls (no cross-attribution).
5. link_session is a no-op when session_id is already set.
6. list_runs filters by provider and status.
7. get_run_by_pane returns the most-recent row for a pane.
"""

from __future__ import annotations

import uuid
from unittest import mock

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import agents as agents_router
from app.services import agent_runs_service

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gen_uuid() -> str:
    return str(uuid.uuid4())


async def _provider_id(db: aiosqlite.Connection) -> int:
    """Return the id of a test provider, inserting one if the DB is clean-slate (E0.1)."""
    row = await db.execute(
        "SELECT id FROM providers WHERE name = 'test-anthropic' LIMIT 1"
    )
    r = await row.fetchone()
    if r is not None:
        return r["id"]
    cur = await db.execute(
        "INSERT INTO providers (name, display_name, command_template, is_enabled) "
        "VALUES (?, ?, ?, 1)",
        ("test-anthropic", "Test Anthropic", "claude {extra_args}"),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


async def _project_id(db: aiosqlite.Connection) -> int:
    """Return the id of the first project (may be the seeded 'Unassigned' catch-all)."""
    row = await db.execute("SELECT id FROM projects LIMIT 1")
    r = await row.fetchone()
    assert r is not None, "no projects seeded"
    return r["id"]


# ---------------------------------------------------------------------------
# persist_on_launch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_persist_on_launch_inserts_running_row(migrated_db: aiosqlite.Connection):
    pane_id = _gen_uuid()
    session_id = _gen_uuid()
    pid = await _provider_id(migrated_db)

    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=session_id,
        provider_id=pid,
        project_id=None,
        pane_id=pane_id,
        model="claude-sonnet-4-6",
        prompt_preview="test prompt",
        source_kind=None,
        source_id=None,
    )
    assert isinstance(run_id, int) and run_id > 0

    row = await migrated_db.execute("SELECT * FROM agent_runs WHERE id = ?", (run_id,))
    r = await row.fetchone()
    assert r is not None
    assert r["status"] == "running"
    assert r["session_id"] == session_id
    assert r["pane_id"] == pane_id
    assert r["provider_id"] == pid
    assert r["model"] == "claude-sonnet-4-6"
    assert r["prompt_preview"] == "test prompt"
    assert r["ended_at"] is None


@pytest.mark.asyncio
async def test_persist_on_launch_no_session_id(migrated_db: aiosqlite.Connection):
    """Non-Claude providers may not supply a session_id; row is still created."""
    pid = await _provider_id(migrated_db)

    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=pid,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )
    row = await migrated_db.execute(
        "SELECT session_id, status FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    assert r["status"] == "running"
    assert r["session_id"] is None


# ---------------------------------------------------------------------------
# mark_ended_by_pane
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_ended_by_pane_transitions_status(migrated_db: aiosqlite.Connection):
    pane_id = _gen_uuid()
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )

    updated = await agent_runs_service.mark_ended_by_pane(
        migrated_db, pane_id, exit_code=0
    )
    assert updated == 1

    row = await migrated_db.execute(
        "SELECT status, ended_at FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    assert r["status"] == "ended"
    assert r["ended_at"] is not None


@pytest.mark.asyncio
async def test_mark_ended_by_pane_idempotent(migrated_db: aiosqlite.Connection):
    """Calling mark_ended_by_pane twice on the same pane returns 0 the second time."""
    pane_id = _gen_uuid()
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )

    first = await agent_runs_service.mark_ended_by_pane(migrated_db, pane_id)
    second = await agent_runs_service.mark_ended_by_pane(migrated_db, pane_id)
    assert first == 1
    assert second == 0


@pytest.mark.asyncio
async def test_mark_ended_by_unknown_pane_returns_zero(
    migrated_db: aiosqlite.Connection,
):
    updated = await agent_runs_service.mark_ended_by_pane(migrated_db, "does-not-exist")
    assert updated == 0


# ---------------------------------------------------------------------------
# link_session (deterministic enrichment)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_session_backfills_session_id(migrated_db: aiosqlite.Connection):
    """When persist_on_launch stores session_id=None, link_session can fill it."""
    pane_id = _gen_uuid()
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )

    new_session_id = _gen_uuid()
    await agent_runs_service.link_session(migrated_db, run_id, new_session_id)

    row = await migrated_db.execute(
        "SELECT session_id FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    assert r["session_id"] == new_session_id


@pytest.mark.asyncio
async def test_link_session_noop_when_already_set(migrated_db: aiosqlite.Connection):
    """link_session must NOT overwrite an existing session_id (set at launch)."""
    original_session_id = _gen_uuid()
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=original_session_id,
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )

    other_session_id = _gen_uuid()
    await agent_runs_service.link_session(migrated_db, run_id, other_session_id)

    row = await migrated_db.execute(
        "SELECT session_id FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    # Must still hold the original id — link_session is a no-op when already set.
    assert r["session_id"] == original_session_id


# ---------------------------------------------------------------------------
# Concurrent same-project case (determinism assertion)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_same_project_no_cross_attribution(
    migrated_db: aiosqlite.Connection,
):
    """Two concurrent launches in the same project link to distinct sessions.

    This verifies the B3 determinism guarantee: each agent_runs row carries its
    own session_id so link_session(run_id_A, session_A) and
    link_session(run_id_B, session_B) never cross-pollinate.
    """
    project_id = await _project_id(migrated_db)

    session_a = _gen_uuid()
    session_b = _gen_uuid()
    pane_a = _gen_uuid()
    pane_b = _gen_uuid()

    # Simulate two nearly-simultaneous launches in the same project.
    run_id_a = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,  # not yet known at persist time
        provider_id=None,
        project_id=project_id,
        pane_id=pane_a,
        model=None,
        prompt_preview="prompt A",
        source_kind=None,
        source_id=None,
    )
    run_id_b = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=project_id,
        pane_id=pane_b,
        model=None,
        prompt_preview="prompt B",
        source_kind=None,
        source_id=None,
    )

    # First hook for run B arrives before run A (out-of-order is the hard case).
    await agent_runs_service.link_session(migrated_db, run_id_b, session_b)
    await agent_runs_service.link_session(migrated_db, run_id_a, session_a)

    row_a = await migrated_db.execute(
        "SELECT session_id FROM agent_runs WHERE id = ?", (run_id_a,)
    )
    row_b = await migrated_db.execute(
        "SELECT session_id FROM agent_runs WHERE id = ?", (run_id_b,)
    )
    r_a = await row_a.fetchone()
    r_b = await row_b.fetchone()

    assert r_a is not None and r_b is not None
    assert r_a["session_id"] == session_a, "run A must link to session A"
    assert r_b["session_id"] == session_b, "run B must link to session B"
    assert r_a["session_id"] != r_b["session_id"], "sessions must remain distinct"


# ---------------------------------------------------------------------------
# list_runs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_runs_returns_rows(migrated_db: aiosqlite.Connection):
    pid = await _provider_id(migrated_db)
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=_gen_uuid(),
        provider_id=pid,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )

    runs = await agent_runs_service.list_runs(migrated_db)
    assert len(runs) >= 1
    assert all("id" in r for r in runs)
    assert all("status" in r for r in runs)
    assert all("provider_name" in r for r in runs)


@pytest.mark.asyncio
async def test_list_runs_filters_by_status(migrated_db: aiosqlite.Connection):
    pane_id = _gen_uuid()
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )
    await agent_runs_service.mark_ended_by_pane(migrated_db, pane_id)

    running = await agent_runs_service.list_runs(migrated_db, status="running")
    ended = await agent_runs_service.list_runs(migrated_db, status="ended")

    assert all(r["status"] == "running" for r in running)
    assert all(r["status"] == "ended" for r in ended)
    # The row we ended must appear in ended.
    ended_panes = {r["pane_id"] for r in ended}
    assert pane_id in ended_panes


# ---------------------------------------------------------------------------
# get_run_by_pane
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_run_by_pane_returns_most_recent(migrated_db: aiosqlite.Connection):
    pane_id = _gen_uuid()
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model="test-model",
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )

    result = await agent_runs_service.get_run_by_pane(migrated_db, pane_id)
    assert result is not None
    assert result["id"] == run_id
    assert result["model"] == "test-model"


@pytest.mark.asyncio
async def test_get_run_by_pane_unknown_returns_none(migrated_db: aiosqlite.Connection):
    result = await agent_runs_service.get_run_by_pane(migrated_db, "does-not-exist")
    assert result is None


# ---------------------------------------------------------------------------
# profile column (migration 051)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_persist_on_launch_stores_profile(migrated_db: aiosqlite.Connection):
    """profile name is stored when supplied at launch time."""
    pane_id = _gen_uuid()
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=_gen_uuid(),
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        profile="work",
    )

    row = await migrated_db.execute(
        "SELECT profile FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    assert r["profile"] == "work"


@pytest.mark.asyncio
async def test_persist_on_launch_profile_nullable(migrated_db: aiosqlite.Connection):
    """profile defaults to NULL when not supplied (pre-migration / no-profile launches)."""
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        # profile not supplied — default is None
    )
    row = await migrated_db.execute(
        "SELECT profile FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    assert r["profile"] is None


@pytest.mark.asyncio
async def test_list_runs_profile_filter(migrated_db: aiosqlite.Connection):
    """list_runs(profile=...) returns only rows matching that profile."""
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        profile="work",
    )
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        profile="personal",
    )

    work_runs = await agent_runs_service.list_runs(migrated_db, profile="work")
    personal_runs = await agent_runs_service.list_runs(migrated_db, profile="personal")

    # All returned rows have row_kind='run' with the correct profile
    work_run_rows = [r for r in work_runs if r["row_kind"] == "run"]
    personal_run_rows = [r for r in personal_runs if r["row_kind"] == "run"]

    assert all(r["profile"] == "work" for r in work_run_rows)
    assert all(r["profile"] == "personal" for r in personal_run_rows)
    # Each profile filter must not return the other profile's rows
    work_profiles = {r["profile"] for r in work_run_rows}
    personal_profiles = {r["profile"] for r in personal_run_rows}
    assert "personal" not in work_profiles
    assert "work" not in personal_profiles


# ---------------------------------------------------------------------------
# Unified list: observe-only sessions (unlinked agent_sessions)
# ---------------------------------------------------------------------------


async def _insert_agent_session(
    db: aiosqlite.Connection,
    *,
    session_id: str,
    profile: str = "work",
    status: str = "active",
    project_id: int | None = None,
) -> None:
    """Insert a minimal agent_sessions row for test fixtures."""
    import datetime

    now = datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds")
    await db.execute(
        """
        INSERT INTO agent_sessions
            (session_id, profile, status, started_at, last_event_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (session_id, profile, status, now, now),
    )
    await db.commit()


@pytest.mark.asyncio
async def test_list_runs_includes_unlinked_sessions(migrated_db: aiosqlite.Connection):
    """Unlinked agent_sessions rows appear as row_kind='observe' in list_runs."""
    # A session that has no agent_runs row is an observe-only (external) session.
    ext_session_id = _gen_uuid()
    await _insert_agent_session(migrated_db, session_id=ext_session_id, status="active")

    runs = await agent_runs_service.list_runs(migrated_db)
    obs_rows = [r for r in runs if r["row_kind"] == "observe"]
    obs_session_ids = {r["session_id"] for r in obs_rows}
    assert ext_session_id in obs_session_ids


@pytest.mark.asyncio
async def test_list_runs_linked_session_not_duplicated(
    migrated_db: aiosqlite.Connection,
):
    """A session that IS linked to an agent_runs row must NOT appear as observe-only."""
    session_id = _gen_uuid()
    pane_id = _gen_uuid()
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=session_id,
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )
    # Insert a matching agent_sessions row (simulates a hook arriving).
    await _insert_agent_session(migrated_db, session_id=session_id, status="active")

    runs = await agent_runs_service.list_runs(migrated_db)
    # Must appear exactly once (as row_kind='run'), never as 'observe'.
    matching = [r for r in runs if r["session_id"] == session_id]
    assert len(matching) == 1, f"Expected 1 row for session, got {len(matching)}"
    assert matching[0]["row_kind"] == "run"


@pytest.mark.asyncio
async def test_list_runs_linked_session_not_duplicated_end_to_end(
    migrated_db: aiosqlite.Connection,
):
    """End-to-end ordering: run persisted with dashboard UUID → hook session
    created with the same UUID → list_runs returns exactly ONE row.

    This is the canonical test for the session-linking wiring fix.  Before the fix
    the template lacked {session_id}, so claude generated its own UUID, the
    hook session did NOT match agent_runs.session_id, and list_runs emitted
    two rows (one 'run', one 'observe').

    After the fix:
    1. The dashboard mints a UUID (``dashboard_session_id``) at launch time.
    2. persist_on_launch stores it on the agent_runs row.
    3. Claude is launched with --session-id <dashboard_session_id>.
    4. The session-start hook arrives with that exact UUID and upserts an
       agent_sessions row.
    5. list_runs: the agent_sessions row matches agent_runs.session_id via the
       LEFT JOIN and is therefore excluded from the observe-only UNION branch.
    6. Exactly ONE row is returned with row_kind='run', carrying session
       enrichment (session_status) from the joined agent_sessions row.
    """
    dashboard_session_id = _gen_uuid()
    pane_id = _gen_uuid()
    pid = await _provider_id(migrated_db)

    # Step 1-2: persist the launch row (the dashboard minted the UUID up front).
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=dashboard_session_id,
        provider_id=pid,
        project_id=None,
        pane_id=pane_id,
        model="claude-sonnet-4-6",
        prompt_preview="Do the thing",
        source_kind=None,
        source_id=None,
    )
    assert run_id > 0

    # Step 3 is handled by the CLI; we simulate step 4: hook arrives with the
    # same UUID and creates an agent_sessions row (status='active').
    await _insert_agent_session(
        migrated_db, session_id=dashboard_session_id, status="active"
    )

    # Step 5-6: list_runs must return exactly ONE row for this session.
    runs = await agent_runs_service.list_runs(migrated_db)
    matching = [r for r in runs if r["session_id"] == dashboard_session_id]

    assert len(matching) == 1, (
        f"Expected exactly 1 unified row for session {dashboard_session_id}, "
        f"got {len(matching)}: {[r['row_kind'] for r in matching]}"
    )
    row = matching[0]
    assert row["row_kind"] == "run", "Unified row must be row_kind='run', not 'observe'"
    assert row["pane_id"] == pane_id, (
        "run row must carry the PTY pane_id for Focus/Stop"
    )
    # The session enrichment from the hook must be present on the single row.
    assert row["session_status"] == "active", (
        "Session enrichment must be available on the run row (joined from agent_sessions)"
    )


@pytest.mark.asyncio
async def test_list_runs_row_kind_field_present(migrated_db: aiosqlite.Connection):
    """Every row returned by list_runs must have a row_kind field."""
    pid = await _provider_id(migrated_db)
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=_gen_uuid(),
        provider_id=pid,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )
    runs = await agent_runs_service.list_runs(migrated_db)
    assert all("row_kind" in r for r in runs)
    assert all(r["row_kind"] in ("run", "observe") for r in runs)


# ---------------------------------------------------------------------------
# target column (migration 052)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_persist_on_launch_stores_embedded_target(
    migrated_db: aiosqlite.Connection,
):
    """target='embedded' is stored when the pane lives in the main-window grid."""
    pane_id = _gen_uuid()
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=_gen_uuid(),
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        target="embedded",
    )

    row = await migrated_db.execute(
        "SELECT target FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    assert r["target"] == "embedded"


@pytest.mark.asyncio
async def test_persist_on_launch_stores_popout_target(
    migrated_db: aiosqlite.Connection,
):
    """target='popout' is stored when the pane lives in the detached terminals window."""
    pane_id = _gen_uuid()
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=_gen_uuid(),
        provider_id=None,
        project_id=None,
        pane_id=pane_id,
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        target="popout",
    )

    row = await migrated_db.execute(
        "SELECT target FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    assert r["target"] == "popout"


@pytest.mark.asyncio
async def test_persist_on_launch_target_nullable(migrated_db: aiosqlite.Connection):
    """target defaults to NULL when not supplied (pre-migration / legacy rows)."""
    run_id = await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=None,
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        # target not supplied — default is None
    )
    row = await migrated_db.execute(
        "SELECT target FROM agent_runs WHERE id = ?", (run_id,)
    )
    r = await row.fetchone()
    assert r is not None
    assert r["target"] is None


@pytest.mark.asyncio
async def test_list_runs_exposes_target_field(migrated_db: aiosqlite.Connection):
    """list_runs returns the target column for run rows."""
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=_gen_uuid(),
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        target="popout",
    )
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=_gen_uuid(),
        provider_id=None,
        project_id=None,
        pane_id=_gen_uuid(),
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
        target="embedded",
    )

    runs = await agent_runs_service.list_runs(migrated_db)
    run_rows = [r for r in runs if r["row_kind"] == "run"]

    # target field must be present on every run row
    assert all("target" in r for r in run_rows)

    targets = {r["target"] for r in run_rows}
    assert "popout" in targets
    assert "embedded" in targets


@pytest.mark.asyncio
async def test_list_runs_observe_rows_have_null_target(
    migrated_db: aiosqlite.Connection,
):
    """Observe-only (external session) rows always expose target=NULL."""
    ext_session_id = _gen_uuid()
    await _insert_agent_session(migrated_db, session_id=ext_session_id, status="active")

    runs = await agent_runs_service.list_runs(migrated_db)
    obs_rows = [r for r in runs if r["row_kind"] == "observe"]
    assert len(obs_rows) >= 1
    assert all(r["target"] is None for r in obs_rows)


# ---------------------------------------------------------------------------
# resolve_project_id_for_cwd — agent panes report a cwd, not a project id
# ---------------------------------------------------------------------------


async def _insert_project(db: aiosqlite.Connection, name: str, path: str) -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, status, path) VALUES (?, 'active', ?)",
        (name, path),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


@pytest.mark.asyncio
async def test_resolve_project_id_for_cwd_matches_exact_and_subdirectory(
    migrated_db: aiosqlite.Connection,
):
    pid = await _insert_project(migrated_db, "acme", "/w/acme")

    assert (
        await agent_runs_service.resolve_project_id_for_cwd(migrated_db, "/w/acme")
        == pid
    )
    # A pane opened deeper in the tree still belongs to the project.
    assert (
        await agent_runs_service.resolve_project_id_for_cwd(
            migrated_db, "/w/acme/frontend/src"
        )
        == pid
    )


@pytest.mark.asyncio
async def test_resolve_project_id_for_cwd_prefers_the_longest_path(
    migrated_db: aiosqlite.Connection,
):
    """An umbrella repo's path is a prefix of every repo nested inside it.

    The nested project is the right answer for a pane opened inside it — which
    is only true if the longest match wins rather than the first one found.
    """
    await _insert_project(migrated_db, "umbrella", "/w/umbrella")
    inner = await _insert_project(migrated_db, "inner", "/w/umbrella/inner")

    assert (
        await agent_runs_service.resolve_project_id_for_cwd(
            migrated_db, "/w/umbrella/inner/app"
        )
        == inner
    )


@pytest.mark.asyncio
async def test_resolve_project_id_for_cwd_does_not_match_a_sibling_prefix(
    migrated_db: aiosqlite.Connection,
):
    """`/w/app` must not claim a pane in `/w/app-legacy` — match on separators."""
    await _insert_project(migrated_db, "app", "/w/app")

    assert (
        await agent_runs_service.resolve_project_id_for_cwd(
            migrated_db, "/w/app-legacy"
        )
        is None
    )


@pytest.mark.asyncio
async def test_resolve_project_id_for_cwd_handles_no_match_and_no_cwd(
    migrated_db: aiosqlite.Connection,
):
    await _insert_project(migrated_db, "acme", "/w/acme")

    assert (
        await agent_runs_service.resolve_project_id_for_cwd(migrated_db, "/elsewhere")
        is None
    )
    assert (
        await agent_runs_service.resolve_project_id_for_cwd(migrated_db, None) is None
    )
    assert await agent_runs_service.resolve_project_id_for_cwd(migrated_db, "") is None


@pytest.mark.asyncio
async def test_resolve_project_id_for_cwd_ignores_a_trailing_separator(
    migrated_db: aiosqlite.Connection,
):
    pid = await _insert_project(migrated_db, "acme", "/w/acme/")

    assert (
        await agent_runs_service.resolve_project_id_for_cwd(migrated_db, "/w/acme/src")
        == pid
    )


# ---------------------------------------------------------------------------
# POST /agents/events/launch — the contract an agent pane posts against
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def launch_client(
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


@pytest.mark.asyncio
async def test_launch_resolves_project_from_cwd(
    launch_client: tuple[TestClient, aiosqlite.Connection],
):
    """An agent pane posts `cwd` because it has no project lookup of its own."""
    client, db = launch_client
    pid = await _insert_project(db, "acme", "/w/acme")

    resp = client.post(
        "/api/v1/agents/events/launch",
        json={
            "pane_id": "leaf-1",
            "session_id": _gen_uuid(),
            "cwd": "/w/acme/frontend",
            "target": "popout",
            "model": "claude-opus-5",
        },
    )
    assert resp.status_code == 200

    run = await agent_runs_service.get_run_by_pane(db, "leaf-1")
    assert run is not None
    assert run["project_id"] == pid
    assert run["target"] == "popout"
    assert run["status"] == "running"


@pytest.mark.asyncio
async def test_launch_explicit_project_id_wins_over_cwd(
    launch_client: tuple[TestClient, aiosqlite.Connection],
):
    client, db = launch_client
    await _insert_project(db, "from-cwd", "/w/from-cwd")
    explicit = await _insert_project(db, "explicit", "/w/explicit")

    resp = client.post(
        "/api/v1/agents/events/launch",
        json={
            "pane_id": "leaf-2",
            "cwd": "/w/from-cwd/deep",
            "project_id": explicit,
        },
    )
    assert resp.status_code == 200

    run = await agent_runs_service.get_run_by_pane(db, "leaf-2")
    assert run is not None
    assert run["project_id"] == explicit


@pytest.mark.asyncio
async def test_launch_without_cwd_or_project_still_records_the_run(
    launch_client: tuple[TestClient, aiosqlite.Connection],
):
    """A pane outside every known project is still a run — just unattributed."""
    client, db = launch_client

    resp = client.post(
        "/api/v1/agents/events/launch",
        json={"pane_id": "leaf-3", "cwd": "/tmp/scratch"},
    )
    assert resp.status_code == 200

    run = await agent_runs_service.get_run_by_pane(db, "leaf-3")
    assert run is not None
    assert run["project_id"] is None


# ---------------------------------------------------------------------------
# mark_ended_by_pane — a pane id outlives the run that used it
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_ended_by_pane_scoped_to_one_session(
    migrated_db: aiosqlite.Connection,
):
    """A Restart reuses the pane id, so the outgoing run's report must not end
    the replacement.

    Both reports are fire-and-forget HTTP calls with no ordering guarantee
    between them, so a late "the old session ended" could otherwise land after
    the new row exists and mark a live session dead — losing its Focus/Stop
    actions for the rest of its life.
    """
    provider_id = await _provider_id(migrated_db)
    old_session, new_session = _gen_uuid(), _gen_uuid()
    for session_id in (old_session, new_session):
        await agent_runs_service.persist_on_launch(
            migrated_db,
            session_id=session_id,
            provider_id=provider_id,
            project_id=None,
            pane_id="leaf-restart",
            model=None,
            prompt_preview=None,
            source_kind=None,
            source_id=None,
        )

    updated = await agent_runs_service.mark_ended_by_pane(
        migrated_db, "leaf-restart", 0, old_session
    )
    assert updated == 1

    cur = await migrated_db.execute(
        "SELECT session_id, status FROM agent_runs WHERE pane_id = 'leaf-restart'"
    )
    status = {r["session_id"]: r["status"] for r in await cur.fetchall()}
    assert status[old_session] == "ended"
    assert status[new_session] == "running"


@pytest.mark.asyncio
async def test_mark_ended_by_pane_unscoped_still_ends_every_run(
    migrated_db: aiosqlite.Connection,
):
    """The PTY path has no session id — `pty-exited` does not carry one."""
    provider_id = await _provider_id(migrated_db)
    for _ in range(2):
        await agent_runs_service.persist_on_launch(
            migrated_db,
            session_id=_gen_uuid(),
            provider_id=provider_id,
            project_id=None,
            pane_id="pty-1",
            model=None,
            prompt_preview=None,
            source_kind=None,
            source_id=None,
        )

    assert await agent_runs_service.mark_ended_by_pane(migrated_db, "pty-1", 0) == 2


@pytest.mark.asyncio
async def test_mark_ended_by_pane_unknown_session_ends_nothing(
    migrated_db: aiosqlite.Connection,
):
    provider_id = await _provider_id(migrated_db)
    await agent_runs_service.persist_on_launch(
        migrated_db,
        session_id=_gen_uuid(),
        provider_id=provider_id,
        project_id=None,
        pane_id="leaf-x",
        model=None,
        prompt_preview=None,
        source_kind=None,
        source_id=None,
    )

    updated = await agent_runs_service.mark_ended_by_pane(
        migrated_db, "leaf-x", 0, _gen_uuid()
    )
    assert updated == 0


@pytest.mark.asyncio
async def test_runs_exited_endpoint_forwards_the_session_id(
    launch_client: tuple[TestClient, aiosqlite.Connection],
):
    client, db = launch_client
    old_session, new_session = _gen_uuid(), _gen_uuid()
    for session_id in (old_session, new_session):
        client.post(
            "/api/v1/agents/events/launch",
            json={"pane_id": "leaf-http", "session_id": session_id},
        )

    resp = client.post(
        "/api/v1/agents/runs/exited",
        json={"pane_id": "leaf-http", "exit_code": 0, "session_id": old_session},
    )
    assert resp.status_code == 200
    assert resp.json()["updated"] == 1

    cur = await db.execute(
        "SELECT session_id, status FROM agent_runs WHERE pane_id = 'leaf-http'"
    )
    status = {r["session_id"]: r["status"] for r in await cur.fetchall()}
    assert status[old_session] == "ended"
    assert status[new_session] == "running"


# ---------------------------------------------------------------------------
# reconcile_running_runs — the sweep for ends that were never reported
# ---------------------------------------------------------------------------


async def _insert_run_started_at(
    db: aiosqlite.Connection, pane_id: str, started_at: str
) -> int:
    """A running run with an explicit start time, for grace-window tests."""
    cur = await db.execute(
        """
        INSERT INTO agent_runs (session_id, pane_id, status, started_at)
        VALUES (?, ?, 'running', ?)
        """,
        (_gen_uuid(), pane_id, started_at),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


def _ago(seconds: int) -> str:
    from datetime import UTC, datetime, timedelta

    return (datetime.now(UTC) - timedelta(seconds=seconds)).isoformat(
        timespec="seconds"
    )


@pytest.mark.asyncio
async def test_reconcile_ends_runs_whose_pane_is_gone(
    migrated_db: aiosqlite.Connection,
):
    """The leak the per-event reports cannot cover.

    A popout window torn down mid-report, the app quitting, a crash, or an
    unreachable sidecar all leave a row claiming the session is live — with a
    Focus and a Stop that act on nothing.
    """
    alive = await _insert_run_started_at(migrated_db, "leaf-alive", _ago(600))
    dead = await _insert_run_started_at(migrated_db, "leaf-dead", _ago(600))

    ended = await agent_runs_service.reconcile_running_runs(migrated_db, ["leaf-alive"])
    assert ended == 1

    cur = await migrated_db.execute(
        "SELECT id, status, ended_at FROM agent_runs WHERE id IN (?, ?)", (alive, dead)
    )
    rows = {r["id"]: r for r in await cur.fetchall()}
    assert rows[alive]["status"] == "running"
    assert rows[dead]["status"] == "ended"
    assert rows[dead]["ended_at"] is not None


@pytest.mark.asyncio
async def test_reconcile_spares_a_run_younger_than_the_grace_window(
    migrated_db: aiosqlite.Connection,
):
    """The live list is a snapshot taken just before the request.

    A pane that started in between is legitimately absent from it, and ending
    its run would kill the row of a session the user just launched.
    """
    fresh = await _insert_run_started_at(migrated_db, "leaf-new", _ago(2))

    ended = await agent_runs_service.reconcile_running_runs(migrated_db, [])
    assert ended == 0

    cur = await migrated_db.execute(
        "SELECT status FROM agent_runs WHERE id = ?", (fresh,)
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["status"] == "running"


@pytest.mark.asyncio
async def test_reconcile_leaves_already_ended_runs_alone(
    migrated_db: aiosqlite.Connection,
):
    run_id = await _insert_run_started_at(migrated_db, "leaf-done", _ago(600))
    await migrated_db.execute(
        "UPDATE agent_runs SET status = 'ended', ended_at = ? WHERE id = ?",
        ("2026-07-30T10:00:00+00:00", run_id),
    )
    await migrated_db.commit()

    assert await agent_runs_service.reconcile_running_runs(migrated_db, []) == 0

    cur = await migrated_db.execute(
        "SELECT ended_at FROM agent_runs WHERE id = ?", (run_id,)
    )
    row = await cur.fetchone()
    assert row is not None
    # The original end time must survive — reconciliation is not a re-stamp.
    assert row["ended_at"] == "2026-07-30T10:00:00+00:00"


@pytest.mark.asyncio
async def test_reconcile_endpoint_requires_a_list(
    launch_client: tuple[TestClient, aiosqlite.Connection],
):
    """A missing list must not be read as "nothing is alive".

    That reading would end every running run in the table — the worst possible
    failure for a sweep whose whole job is telling live from dead.
    """
    client, db = launch_client
    run_id = await _insert_run_started_at(db, "leaf-guard", _ago(600))

    resp = client.post("/api/v1/agents/runs/reconcile", json={})
    assert resp.status_code == 400

    cur = await db.execute("SELECT status FROM agent_runs WHERE id = ?", (run_id,))
    row = await cur.fetchone()
    assert row is not None
    assert row["status"] == "running"


@pytest.mark.asyncio
async def test_reconcile_endpoint_ends_stale_runs(
    launch_client: tuple[TestClient, aiosqlite.Connection],
):
    client, db = launch_client
    await _insert_run_started_at(db, "leaf-gone", _ago(600))

    resp = client.post(
        "/api/v1/agents/runs/reconcile", json={"live_pane_ids": ["leaf-other"]}
    )
    assert resp.status_code == 200
    assert resp.json()["ended"] == 1


# ---------------------------------------------------------------------------
# Path matching — the two sides come from different places (B2)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_project_id_matches_across_separator_styles(
    migrated_db: aiosqlite.Connection,
):
    """A Windows cwd arrives with backslashes; the stored path may not have them.

    A literal compare simply never matched, so every run on Windows would read
    as project "unknown".
    """
    pid = await _insert_project(migrated_db, "acme", "C:/w/acme")

    assert (
        await agent_runs_service.resolve_project_id_for_cwd(
            migrated_db, "C:\\w\\acme\\frontend"
        )
        == pid
    )
    assert (
        await agent_runs_service.resolve_project_id_for_cwd(migrated_db, "C:/w/acme")
        == pid
    )


@pytest.mark.asyncio
async def test_resolve_project_id_is_case_sensitive_where_the_filesystem_is(
    migrated_db: aiosqlite.Connection,
):
    """`/w/App` and `/w/app` are two projects on Linux and one on Windows."""
    pid = await _insert_project(migrated_db, "acme", "/w/App")

    assert (
        await agent_runs_service.resolve_project_id_for_cwd(migrated_db, "/w/app/src")
        is None
    )

    with mock.patch.object(
        agent_runs_service, "_paths_are_case_insensitive", return_value=True
    ):
        assert (
            await agent_runs_service.resolve_project_id_for_cwd(
                migrated_db, "/w/app/src"
            )
            == pid
        )


@pytest.mark.asyncio
async def test_resolve_project_id_still_rejects_a_sibling_prefix_on_windows(
    migrated_db: aiosqlite.Connection,
):
    """Normalisation must not weaken the separator boundary."""
    await _insert_project(migrated_db, "app", "C:/w/app")

    assert (
        await agent_runs_service.resolve_project_id_for_cwd(
            migrated_db, "C:\\w\\app-legacy\\src"
        )
        is None
    )
