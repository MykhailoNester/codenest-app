"""Tests for `migrations/012_session_field_provenance.sql` and
`app/services/lane_reconciler_service.py`.

The point of these is behavioural: precedence is asserted by making two lanes
actually contest a field through the public contract, not by reading
`FIELD_LANES` back and restating it. The two exceptions are the registry-shape
tests, which exist precisely so the enumeration and any number quoted about it
cannot drift apart.
"""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest

from app.services import agent_service
from app.services import lane_reconciler_service as lrs

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"

A = lrs.LANE_HOOK
B = lrs.LANE_OTLP
C = lrs.LANE_TRANSCRIPT


async def _seed_session(db: aiosqlite.Connection, session_id: str = "s1") -> str:
    await db.execute(
        """INSERT INTO agent_sessions (session_id, profile, cwd, status)
           VALUES (?, 'claude', '/tmp/x', 'active')""",
        (session_id,),
    )
    await db.commit()
    return session_id


async def _claims(db: aiosqlite.Connection, session_id: str) -> list[tuple[str, str]]:
    cur = await db.execute(
        "SELECT field, lane FROM session_field_provenance WHERE session_id = ? ORDER BY field, lane",
        (session_id,),
    )
    return [(r["field"], r["lane"]) for r in await cur.fetchall()]


# ─── migration shape ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_migration_creates_the_table_with_the_three_part_key(migrated_db):
    cur = await migrated_db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_field_provenance'"
    )
    assert await cur.fetchone() is not None

    cur = await migrated_db.execute("PRAGMA table_info(session_field_provenance)")
    cols = {r["name"]: r for r in await cur.fetchall()}
    assert set(cols) == {"session_id", "field", "lane", "value_text", "claimed_at"}
    # PK is (session_id, field, lane) — one row per lane per field.
    assert [c["name"] for c in cols.values() if c["pk"]] == [
        "session_id",
        "field",
        "lane",
    ]


@pytest.mark.asyncio
async def test_migration_ships_the_table_empty(migrated_db):
    cur = await migrated_db.execute(
        "SELECT COUNT(*) AS n FROM session_field_provenance"
    )
    assert (await cur.fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_no_check_constraint_on_lane_or_field(migrated_db):
    cur = await migrated_db.execute(
        "SELECT sql FROM sqlite_master WHERE name='session_field_provenance'"
    )
    assert "CHECK" not in (await cur.fetchone())["sql"].upper()


# ─── registry shape ─────────────────────────────────────────────────────────


def test_field_lanes_covers_exactly_twenty_fields():
    assert len(lrs.FIELD_LANES) == 20


def test_field_lanes_enumeration_is_exactly_the_documented_set():
    assert set(lrs.FIELD_LANES) == {
        # money and tokens (5)
        "tokens_in",
        "tokens_out",
        "cost_usd",
        "context_tokens",
        "model",
        # provenance (5)
        "source_app",
        "source_detail",
        "cli_version",
        "title",
        "title_source",
        # branch (1)
        "git_branch",
        # live switches (2)
        "permission_mode",
        "effort",
        # liveness (4)
        "status",
        "last_event_at",
        "ended_at",
        "current_tool",
        # attribution (3)
        "project_id",
        "cwd",
        "session_kind",
    }


def test_every_registered_lane_is_a_known_lane():
    for field, lanes in lrs.FIELD_LANES.items():
        assert lanes, f"{field} permits no lane"
        assert len(set(lanes)) == len(lanes), f"{field} repeats a lane"
        for lane in lanes:
            assert lane in lrs.LANES, f"{field} names unknown lane {lane!r}"


def test_lane_rank_is_derived_from_field_lanes():
    # Not an independent table that could disagree.
    for field, lanes in lrs.FIELD_LANES.items():
        assert lrs.LANE_RANK[field] == {ln: i for i, ln in enumerate(lanes)}


# ─── precedence, asserted behaviourally ─────────────────────────────────────


@pytest.mark.asyncio
async def test_money_precedence_is_b_over_c_over_a(migrated_db):
    sid = await _seed_session(migrated_db)

    # A claims first and wins, because nothing has claimed it yet.
    assert (await lrs.apply(migrated_db, sid, A, "cost_usd", 1.0)).applied is True
    # C outranks A on money.
    assert (await lrs.apply(migrated_db, sid, C, "cost_usd", 2.0)).applied is True
    # A now loses to C's standing claim.
    lost = await lrs.apply(migrated_db, sid, A, "cost_usd", 3.0)
    assert lost.applied is False
    assert lost.reason == "outranked"
    assert lost.winning_lane == C
    # B outranks both.
    assert (await lrs.apply(migrated_db, sid, B, "cost_usd", 4.0)).applied is True
    # And now C loses too.
    assert (await lrs.apply(migrated_db, sid, C, "cost_usd", 5.0)).applied is False


@pytest.mark.asyncio
async def test_provenance_precedence_is_c_over_a(migrated_db):
    sid = await _seed_session(migrated_db)
    assert (await lrs.apply(migrated_db, sid, C, "source_app", "cli")).applied is True
    beaten = await lrs.apply(migrated_db, sid, A, "source_app", "guess")
    assert beaten.applied is False
    assert beaten.winning_lane == C


@pytest.mark.asyncio
async def test_liveness_precedence_is_a_over_c(migrated_db):
    sid = await _seed_session(migrated_db)
    assert (await lrs.apply(migrated_db, sid, A, "status", "active")).applied is True
    beaten = await lrs.apply(migrated_db, sid, C, "status", "ended")
    assert beaten.applied is False
    assert beaten.winning_lane == A


@pytest.mark.asyncio
async def test_live_switch_fields_are_a_over_c(migrated_db):
    """permission_mode and effort change mid-session, so a hook beats a file."""
    sid = await _seed_session(migrated_db)
    for field in ("permission_mode", "effort"):
        assert (await lrs.apply(migrated_db, sid, A, field, "x")).applied is True
        assert (await lrs.apply(migrated_db, sid, C, field, "y")).applied is False


@pytest.mark.asyncio
async def test_git_branch_is_c_over_a(migrated_db):
    sid = await _seed_session(migrated_db)
    assert (await lrs.apply(migrated_db, sid, C, "git_branch", "main")).applied is True
    assert (await lrs.apply(migrated_db, sid, A, "git_branch", "wip")).applied is False


@pytest.mark.asyncio
async def test_same_lane_rewrite_upserts_one_row(migrated_db):
    sid = await _seed_session(migrated_db)
    for value in ("a", "b", "c"):
        assert (await lrs.apply(migrated_db, sid, C, "title", value)).applied is True
    assert await _claims(migrated_db, sid) == [("title", C)]
    cur = await migrated_db.execute(
        "SELECT value_text FROM session_field_provenance WHERE session_id=? AND field='title'",
        (sid,),
    )
    assert (await cur.fetchone())["value_text"] == "c"


@pytest.mark.asyncio
async def test_a_rejected_write_records_no_claim(migrated_db):
    """The table records effective writes, not attempts.

    A lane that was outranked did not change the column, so recording a claim
    for it would make `read` able to name a lane that never wrote the value on
    display. Two rows for one field therefore only ever mean "a weaker lane
    wrote it first, then a stronger one took over" — which is exactly the
    history the Session Inspector needs.
    """
    sid = await _seed_session(migrated_db)
    await lrs.apply(migrated_db, sid, C, "source_app", "cli")
    await lrs.apply(migrated_db, sid, A, "source_app", "guess")
    assert await _claims(migrated_db, sid) == [("source_app", C)]


@pytest.mark.asyncio
async def test_both_rows_survive_when_the_weaker_lane_wrote_first(migrated_db):
    """The case the three-part primary key exists for."""
    sid = await _seed_session(migrated_db)
    await lrs.apply(migrated_db, sid, A, "cost_usd", 1.0)  # wins, nothing claimed yet
    await lrs.apply(migrated_db, sid, B, "cost_usd", 2.0)  # outranks A, also wins
    assert await _claims(migrated_db, sid) == [("cost_usd", A), ("cost_usd", B)]
    assert (await lrs.read(migrated_db, sid))["cost_usd"]["lane"] == B


# ─── rejection paths ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unregistered_field_is_refused_not_raised(migrated_db):
    sid = await _seed_session(migrated_db)
    res = await lrs.apply(migrated_db, sid, A, "not_a_field", 1)
    assert res.applied is False
    assert res.reason == "unregistered-field"


@pytest.mark.asyncio
async def test_unknown_lane_is_refused_not_raised(migrated_db):
    sid = await _seed_session(migrated_db)
    res = await lrs.apply(migrated_db, sid, "Z", "cost_usd", 1)
    assert res.applied is False
    assert res.reason == "unknown-lane"


@pytest.mark.asyncio
async def test_lane_not_permitted_for_that_field_is_refused(migrated_db):
    """A lane absent from a field's tuple loses without a special case."""
    sid = await _seed_session(migrated_db)
    original = lrs.FIELD_LANES["title"]
    assert B not in original  # precondition of this test
    res = await lrs.apply(migrated_db, sid, B, "title", "x")
    assert res.applied is False
    assert res.reason == "lane-not-permitted"


@pytest.mark.asyncio
async def test_apply_never_raises_when_the_table_is_missing(tmp_path):
    """A database short of 012 must not take a hook down."""
    conn = await aiosqlite.connect(str(tmp_path / "no-012.db"))
    conn.row_factory = aiosqlite.Row
    res = await lrs.apply(conn, "s1", A, "cost_usd", 1.0)
    assert res.applied is False
    assert res.reason == "error"
    await conn.close()


@pytest.mark.asyncio
async def test_accumulate_shares_the_precedence_decision(migrated_db):
    sid = await _seed_session(migrated_db)
    assert (await lrs.accumulate(migrated_db, sid, A, "tokens_in", 10)).applied is True
    assert (await lrs.accumulate(migrated_db, sid, B, "tokens_in", 20)).applied is True
    assert (await lrs.accumulate(migrated_db, sid, A, "tokens_in", 30)).applied is False


# ─── read path ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_read_reports_the_winning_lane_per_field(migrated_db):
    sid = await _seed_session(migrated_db)
    await lrs.apply(migrated_db, sid, A, "cost_usd", 1.0)
    await lrs.apply(migrated_db, sid, B, "cost_usd", 2.0)
    await lrs.apply(migrated_db, sid, C, "source_app", "cli")

    got = await lrs.read(migrated_db, sid)
    assert got["cost_usd"]["lane"] == B
    assert got["source_app"]["lane"] == C


@pytest.mark.asyncio
async def test_read_rejects_an_unregistered_field(migrated_db):
    """The read path may raise — it is reachable from no hook."""
    sid = await _seed_session(migrated_db)
    with pytest.raises(ValueError):
        await lrs.read(migrated_db, sid, field="not_a_field")


# ─── hook-path integration ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hook_handlers_do_not_import_the_reconciler():
    """The router must reach it only through agent_service."""
    src = (
        pathlib.Path(__file__).parents[2] / "app" / "routers" / "agents.py"
    ).read_text()
    assert "lane_reconciler_service" not in src


@pytest.mark.asyncio
async def test_a_raising_reconciler_leaves_the_event_row_committed(
    migrated_db, monkeypatch
):
    """The guard is inside the reconciler, not a rollback of the shared connection."""

    async def boom(*_args, **_kwargs):
        raise RuntimeError("provenance is down")

    monkeypatch.setattr(lrs, "_decide", boom)

    await agent_service.record_stop(
        migrated_db,
        {"session_id": "hook-1", "cwd": "/tmp/x", "transcript_path": None},
    )

    cur = await migrated_db.execute(
        "SELECT COUNT(*) AS n FROM agent_events WHERE session_id='hook-1' AND event_type='Stop'"
    )
    assert (await cur.fetchone())["n"] == 1


@pytest.mark.asyncio
async def test_record_stop_claims_the_five_money_fields(migrated_db):
    await agent_service.record_stop(
        migrated_db,
        {
            "session_id": "hook-2",
            "cwd": "/tmp/x",
            "transcript_path": None,
            "model": "claude-opus-5",
        },
    )
    claimed = {f for f, _ln in await _claims(migrated_db, "hook-2")}
    assert {"tokens_in", "tokens_out", "cost_usd", "context_tokens", "model"} <= claimed


@pytest.mark.asyncio
async def test_only_the_three_converted_writers_touch_the_reconciler():
    """`_upsert_session_start` and the backfill stay on their own SQL."""
    src = (
        pathlib.Path(__file__).parents[2]
        / "app"
        / "services"
        / "session_backfill_service.py"
    ).read_text()
    assert "lane_reconciler_service" not in src


def test_precedence_lives_only_in_the_reconciler():
    """The grep the acceptance criteria name, as a test."""
    app_dir = pathlib.Path(__file__).parents[2] / "app"
    offenders = []
    for py in app_dir.rglob("*.py"):
        text = py.read_text()
        if "LANE_RANK" in text and py.name != "lane_reconciler_service.py":
            offenders.append(str(py))
        if "CASE WHEN lane" in text and py.name != "lane_reconciler_service.py":
            offenders.append(str(py))
    assert offenders == []
