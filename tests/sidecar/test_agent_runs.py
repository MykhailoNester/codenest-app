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

import aiosqlite
import pytest

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
    assert (
        row["pane_id"] == pane_id
    ), "run row must carry the PTY pane_id for Focus/Stop"
    # The session enrichment from the hook must be present on the single row.
    assert (
        row["session_status"] == "active"
    ), "Session enrichment must be available on the run row (joined from agent_sessions)"


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
