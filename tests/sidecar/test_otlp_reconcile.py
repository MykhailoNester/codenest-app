"""Tests for Lane B's writer — vendor cost superseding the estimate (#153 / #176).

#175's tests pin that the receiver *stores* the right numbers. These pin the
much more dangerous half: what the app does to a session's displayed money once
those numbers are allowed to win.

**The zero.** Telemetry is opt-in and off by default, so the overwhelming
majority of rows in any real database have no OTLP series at all, and
`session_totals` answers for such a session with a zero-filled dict because that
is the right contract for a read. Reconciling that answer would write
`cost_usd = 0` over every Lane A estimate in the database and — because Lane B
outranks both other lanes on money — leave no lane able to repair it.
`test_a_database_of_sessions_without_lane_b_is_left_entirely_alone` is the
headline: a database where eight of nine sessions have no series must come out
of a pass byte-identical, with an empty provenance ledger for those eight.
`test_a_session_with_tokens_but_no_cost_series_keeps_its_estimated_cost` is the
same failure one level down, where per-session presence would have passed and
still zeroed a real number.

**The arithmetic.** Lane B reports a session TOTAL and the exporter restates it
on a timer. `test_repeated_identical_exports_do_not_inflate_the_total` posts the
same body thirty times and pins the session's cost at one export's worth — the
`apply`-not-`accumulate` decision, as a test. `test_reconciled_cost_is_the_sum_
of_the_series` pins that the number came from `session_totals` rather than from
arithmetic re-derived here.

**The clobber.** Lane A's Stop hook accumulates an estimate every turn.
`test_a_stop_hook_after_reconciliation_does_not_add_to_the_vendor_total` is the
regression that matters most after the zero: it would look like the vendor
figure slowly drifting upward, with provenance still claiming Lane B wrote it.

**The trace.** A late vendor figure replaces an estimate the user has already
been shown. `test_the_superseded_estimate_survives_in_the_ledger` pins that the
disagreement is inspectable afterwards — Lane A's row is still there and Lane
B's `value_text` names the figure it displaced.
"""

from __future__ import annotations

import pathlib
from typing import Any

import aiosqlite
import pytest
import pytest_asyncio

from app.services import agent_service
from app.services import lane_reconciler_service as lrs
from app.services import otlp_receiver_service as receiver
from app.services import otlp_reconcile_service as svc

pytestmark = pytest.mark.asyncio

SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
MODEL = "claude-opus-4-5-20260514"
CHEAP_MODEL = "claude-haiku-4-5-20260514"


# ─── Fixtures and helpers ────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def db(migrated_db: aiosqlite.Connection) -> aiosqlite.Connection:
    return migrated_db


async def _seed_session(
    conn: aiosqlite.Connection,
    session_id: str = SESSION,
    *,
    cost: float = 0.0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    model: str | None = None,
) -> str:
    await conn.execute(
        "INSERT INTO agent_sessions"
        " (session_id, profile, cwd, status, cost_usd, tokens_in, tokens_out, model)"
        " VALUES (?, 'test', '/tmp/x', 'idle', ?, ?, ?, ?)",
        (session_id, cost, tokens_in, tokens_out, model),
    )
    await conn.commit()
    return session_id


async def _seed_series(
    conn: aiosqlite.Connection,
    session_id: str,
    metric_key: str,
    value: float,
    *,
    series_key: str = "s1",
    model: str | None = MODEL,
    temporality: str = receiver.TEMPORALITY_CUMULATIVE,
) -> None:
    """One Lane B series row, written the way the receiver writes them.

    Uses the receiver's own `_UPSERT_SQL` and `_now()` rather than a literal
    INSERT, so a test cannot drift from the storage semantics it is standing
    in for — in particular the cumulative `MAX(stored, arrived)` rule the
    regression guard depends on.
    """
    now = receiver._now()
    await conn.execute(
        receiver._UPSERT_SQL,
        (session_id, metric_key, series_key, model, temporality, value, now, now),
    )
    await conn.commit()


async def _session_money(conn: aiosqlite.Connection, session_id: str) -> dict[str, Any]:
    async with conn.execute(
        "SELECT cost_usd, tokens_in, tokens_out, context_tokens, model"
        "  FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    ) as cur:
        row = await cur.fetchone()
    return dict(row) if row else {}


async def _provenance(conn: aiosqlite.Connection, session_id: str) -> list[tuple]:
    async with conn.execute(
        "SELECT field, lane, value_text FROM session_field_provenance"
        " WHERE session_id = ? ORDER BY field, lane",
        (session_id,),
    ) as cur:
        return [(r["field"], r["lane"], r["value_text"]) for r in await cur.fetchall()]


# ─── Absence of evidence is not a zero ───────────────────────────────────────


async def test_a_database_of_sessions_without_lane_b_is_left_entirely_alone(db):
    """The state of every real database today: telemetry off, no series at all.

    Nine sessions carrying Lane A estimates, one of which has Lane B data. A
    pass must leave the other eight untouched in every respect — column values,
    and no provenance row claiming Lane B ever had an opinion about them.
    """
    quiet = []
    for i in range(8):
        sid = await _seed_session(
            db, f"quiet-{i}", cost=0.25 + i, tokens_in=1000 + i, tokens_out=100 + i
        )
        quiet.append(sid)
    loud = await _seed_session(db, "loud", cost=0.99, tokens_in=5, tokens_out=5)
    await _seed_series(db, loud, "cost_usd", 0.42)

    before = {sid: await _session_money(db, sid) for sid in quiet}

    result = await svc.reconcile_recent(db)

    for sid in quiet:
        assert await _session_money(db, sid) == before[sid], sid
        assert await _provenance(db, sid) == [], sid
    # And the one session that did have data was still reconciled, so the test
    # is not passing because the pass did nothing at all.
    assert (await _session_money(db, loud))["cost_usd"] == pytest.approx(0.42)
    assert result.sessions_written == 1


async def test_reconcile_session_on_a_session_with_no_series_writes_nothing(db):
    """The single-session form of the same rule, with its reason named."""
    sid = await _seed_session(db, cost=1.23)
    result = await svc.reconcile_session(db, sid)
    assert result.skipped == "no-lane-b-observation"
    assert result.applied == {}
    assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(1.23)
    assert await _provenance(db, sid) == []


async def test_a_session_with_tokens_but_no_cost_series_keeps_its_estimated_cost(db):
    """Presence is per metric key, not per session.

    A session whose cost export was lost (or whose cost series hit the series
    cap) has rows — so a per-session presence check passes — and a zero
    `cost_usd` total. Writing it would zero a real estimate on a session that
    demonstrably *is* reporting telemetry, which is the harder version of the
    bug to notice.
    """
    sid = await _seed_session(db, cost=0.75, tokens_in=10, tokens_out=2)
    await _seed_series(db, sid, "tokens_input", 4000)
    await _seed_series(db, sid, "tokens_output", 900)

    result = await svc.reconcile_session(db, sid)
    await db.commit()

    money = await _session_money(db, sid)
    assert money["cost_usd"] == pytest.approx(0.75)
    assert money["tokens_in"] == 4000
    assert money["tokens_out"] == 900
    assert result.refused["cost_usd"] == "not-observed"
    # `model` goes with it: `session_totals` reads the model off the
    # highest-cost series, so a session with no cost series has no Lane B model
    # either, however many token series carried the attribute.
    assert {f for f, _lane, _v in await _provenance(db, sid)} == {
        "tokens_in",
        "tokens_out",
    }
    assert result.refused["model"] == "not-observed"


async def test_a_session_whose_series_carry_no_model_does_not_have_its_model_blanked(
    db,
):
    sid = await _seed_session(db, model="claude-sonnet-4-5")
    await _seed_series(db, sid, "cost_usd", 0.1, model=None)

    result = await svc.reconcile_session(db, sid)
    await db.commit()

    assert result.refused["model"] == "not-observed"
    assert (await _session_money(db, sid))["model"] == "claude-sonnet-4-5"


# ─── Superseding, and the arithmetic ────────────────────────────────────────


async def test_lane_b_supersedes_a_lane_a_estimate(db):
    """The ticket, in one test: the vendor figure replaces the app's guess."""
    sid = await _seed_session(db, cost=0.5039, tokens_in=9, tokens_out=9, model="guess")
    await _record_lane_a_claims(db, sid, cost=0.5039)
    await _seed_series(db, sid, "cost_usd", 0.4123)
    await _seed_series(db, sid, "tokens_input", 12000)
    await _seed_series(db, sid, "tokens_output", 3400)

    await svc.reconcile_recent(db)

    money = await _session_money(db, sid)
    assert money["cost_usd"] == pytest.approx(0.4123)
    assert money["tokens_in"] == 12000
    assert money["tokens_out"] == 3400
    assert money["model"] == MODEL
    claims = await lrs.read(db, sid)
    assert claims["cost_usd"]["lane"] == lrs.LANE_OTLP
    assert claims["tokens_in"]["lane"] == lrs.LANE_OTLP
    assert claims["model"]["lane"] == lrs.LANE_OTLP


async def test_superseding_downward_is_allowed(db):
    """Lane A over-prices cheap models, so the first real figure is often lower.

    The regression guard must not mistake this for evidence going missing — it
    applies only once Lane B already owns the column.
    """
    sid = await _seed_session(db, cost=2.0)
    await _record_lane_a_claims(db, sid, cost=2.0)
    await _seed_series(db, sid, "cost_usd", 0.07, model=CHEAP_MODEL)

    await svc.reconcile_recent(db)

    assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(0.07)


async def test_reconciled_cost_is_the_sum_of_the_series(db):
    """Four series, four models, one total — and it is `session_totals`'.

    Pinned against the receiver's own function rather than against a literal,
    so the day the two disagree this fails rather than quietly encoding a
    second copy of the arithmetic.
    """
    sid = await _seed_session(db)
    for i, value in enumerate((0.10, 0.25, 0.03, 0.62)):
        await _seed_series(db, sid, "cost_usd", value, series_key=f"s{i}")

    expected = (await receiver.session_totals(db, sid))["cost_usd"]
    await svc.reconcile_recent(db)

    assert expected == pytest.approx(1.00)
    assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(expected)


async def test_the_model_is_the_highest_cost_series_model(db):
    sid = await _seed_session(db)
    await _seed_series(db, sid, "cost_usd", 0.02, series_key="cheap", model=CHEAP_MODEL)
    await _seed_series(db, sid, "cost_usd", 0.90, series_key="main", model=MODEL)

    await svc.reconcile_recent(db)

    assert (await _session_money(db, sid))["model"] == MODEL


async def test_repeated_identical_exports_do_not_inflate_the_total(db):
    """`apply`, not `accumulate` — the 720x error, pinned.

    A cumulative exporter restates the same running total every interval. The
    receiver collapses those restatements onto one row; reconciliation must not
    then re-add that row's value once per pass. Thirty passes, one export's
    worth of money.
    """
    sid = await _seed_session(db)
    for _ in range(30):
        await _seed_series(db, sid, "cost_usd", 0.4200)
        await _seed_series(db, sid, "tokens_input", 8000)
        await svc.reconcile_recent(db)

    money = await _session_money(db, sid)
    assert money["cost_usd"] == pytest.approx(0.42)
    assert money["tokens_in"] == 8000


async def test_a_growing_cumulative_total_is_followed_upward(db):
    """The legitimate growth case, so the previous test is not passing by
    refusing every second write."""
    sid = await _seed_session(db)
    for value in (0.10, 0.35, 0.80):
        await _seed_series(db, sid, "cost_usd", value)
        await svc.reconcile_recent(db)
        assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(value)


async def test_a_total_that_falls_after_lane_b_owns_it_is_refused(db):
    """Per-series values cannot fall, so a falling sum means rows were deleted.

    `event_retention_service`'s `otlp` class prunes this table daily. Applying
    the smaller sum would walk a session's recorded spend backwards because we
    pruned our own receipts.
    """
    sid = await _seed_session(db)
    await _seed_series(db, sid, "cost_usd", 0.30, series_key="a")
    await _seed_series(db, sid, "cost_usd", 0.50, series_key="b")
    await svc.reconcile_recent(db)
    assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(0.80)

    await db.execute(
        "DELETE FROM otlp_metric_series WHERE session_id = ? AND series_key = 'b'",
        (sid,),
    )
    await db.commit()

    result = await svc.reconcile_recent(db)

    assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(0.80)
    assert result.results[0].refused["cost_usd"] == "regressed"


async def test_a_fully_pruned_session_keeps_lane_bs_last_figure(db):
    """And the end state of pruning: no observation, so nothing is touched.

    Lane B keeps the column because Lane A is outranked and cannot take it
    back. The money was real; the receipts aged out.
    """
    sid = await _seed_session(db)
    await _seed_series(db, sid, "cost_usd", 0.66)
    await svc.reconcile_recent(db)

    await db.execute("DELETE FROM otlp_metric_series WHERE session_id = ?", (sid,))
    await db.commit()

    result = await svc.reconcile_session(db, sid)

    assert result.skipped == "no-lane-b-observation"
    assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(0.66)
    assert (await lrs.read(db, sid))["cost_usd"]["lane"] == lrs.LANE_OTLP


# ─── Provenance, and the disagreement ───────────────────────────────────────


async def test_provenance_is_written_for_every_field_lane_b_claims(db):
    sid = await _seed_session(db)
    await _seed_series(db, sid, "cost_usd", 0.21)
    await _seed_series(db, sid, "tokens_input", 100)
    await _seed_series(db, sid, "tokens_output", 20)

    await svc.reconcile_recent(db)

    claimed = {
        field for field, lane, _v in await _provenance(db, sid) if lane == lrs.LANE_OTLP
    }
    assert claimed == {"cost_usd", "tokens_in", "tokens_out", "model"}


async def test_lane_b_never_claims_context_tokens(db):
    """It is ranked first for it and must still refuse it.

    `context_tokens` is per-turn context-window occupancy (migration 003) and
    Lane B has only cumulative session totals; claiming it would both put a
    meaningless number in the column and permanently outrank Lane A, which has
    the right one.
    """
    sid = await _seed_session(db)
    await _seed_series(db, sid, "tokens_input", 500_000)
    await _seed_series(db, sid, "tokens_cache_read", 4_000_000)
    await _seed_series(db, sid, "tokens_cache_creation", 60_000)

    await svc.reconcile_recent(db)

    fields = {field for field, _lane, _v in await _provenance(db, sid)}
    assert "context_tokens" not in fields
    assert "context_tokens" not in svc.FIELD_SOURCES
    # And the ranking itself is untouched — the refusal belongs to the writer.
    assert lrs.FIELD_LANES["context_tokens"][0] == lrs.LANE_OTLP


async def test_the_superseded_estimate_survives_in_the_ledger(db):
    """A late vendor figure replaces a number the user was already shown.

    Silent on the surface, loud in the ledger: Lane A's row is still there, and
    Lane B's `value_text` names the figure it displaced. Without that, the
    magnitude of the disagreement would be unrecoverable — Lane A's own row
    holds the last turn's delta, not the running total it had built.
    """
    sid = await _seed_session(db, cost=0.5039)
    await _record_lane_a_claims(db, sid, cost=0.5039)
    await _seed_series(db, sid, "cost_usd", 0.4123)

    await svc.reconcile_recent(db)

    rows = {(f, ln): v for f, ln, v in await _provenance(db, sid)}
    assert (
        "cost_usd",
        lrs.LANE_HOOK,
    ) in rows, "lane A's claim must not be erased by the supersede"
    lane_b_text = rows[("cost_usd", lrs.LANE_OTLP)]
    assert lane_b_text.startswith("0.412300")
    assert "superseded lane-A 0.503900" in lane_b_text


async def test_the_trace_survives_later_exports(db):
    """The note must outlive the export interval that follows it.

    One row per (session, field, lane) means every later Lane B claim
    *overwrites* this text, and a cumulative exporter claims again every few
    seconds. Without carrying the suffix forward, the record of what Lane B
    displaced would last one interval — long enough to pass a test that posts
    once, and gone by the time anyone looked.
    """
    sid = await _seed_session(db, cost=0.5039)
    await _record_lane_a_claims(db, sid, cost=0.5039)

    for total in (0.4123, 0.5500, 0.8000):
        await _seed_series(db, sid, "cost_usd", total)
        await svc.reconcile_recent(db)

    claims = await lrs.read(db, sid)
    assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(0.80)
    assert claims["cost_usd"]["value_text"] == ("0.800000 (superseded lane-A 0.503900)")


async def test_an_unchanged_total_is_not_re_claimed(db):
    """Steady state costs nothing, and `claimed_at` means "last moved"."""
    sid = await _seed_session(db)
    await _seed_series(db, sid, "cost_usd", 0.42)
    await svc.reconcile_recent(db)

    second = await svc.reconcile_recent(db)

    assert second.results[0].refused["cost_usd"] == "unchanged"
    assert second.results[0].applied == {}


async def test_an_agreeing_figure_is_not_annotated(db):
    """No disagreement, no annotation — the note means something."""
    sid = await _seed_session(db, cost=0.25)
    await _record_lane_a_claims(db, sid, cost=0.25)
    await _seed_series(db, sid, "cost_usd", 0.25)

    await svc.reconcile_recent(db)

    rows = {(f, ln): v for f, ln, v in await _provenance(db, sid)}
    assert rows[("cost_usd", lrs.LANE_OTLP)] == "0.250000"


# ─── The reconciler is not bypassed ─────────────────────────────────────────


async def test_reconciliation_goes_through_the_reconciler(db, monkeypatch):
    """A reconciler that refuses everything must leave the columns alone.

    The structural guarantee behind "Lane B MUST go through `apply`": if this
    module ever grew a direct UPDATE, the column would move anyway and this
    would fail.
    """
    sid = await _seed_session(db, cost=1.5, tokens_in=7, tokens_out=3, model="keep-me")
    await _seed_series(db, sid, "cost_usd", 0.01)
    await _seed_series(db, sid, "tokens_input", 1)

    async def refuse(_db, _sid, lane, field, _value):
        return lrs.ReconcileResult(False, field, lane, "outranked", winning_lane="A")

    monkeypatch.setattr(lrs, "apply", refuse)

    await svc.reconcile_recent(db)

    money = await _session_money(db, sid)
    assert money["cost_usd"] == pytest.approx(1.5)
    assert money["tokens_in"] == 7
    assert money["model"] == "keep-me"


async def test_the_writer_issues_no_unreconciled_update():
    """Every `UPDATE agent_sessions` in this module is the one after `apply`."""
    src = (
        pathlib.Path(__file__).parents[2]
        / "app"
        / "services"
        / "otlp_reconcile_service.py"
    ).read_text()
    assert src.count("UPDATE agent_sessions") == 1
    assert "cost_usd = cost_usd +" not in src


async def test_a_raising_reconciler_does_not_escape_into_the_route(db, monkeypatch):
    sid = await _seed_session(db, cost=1.0)
    await _seed_series(db, sid, "cost_usd", 0.5)

    async def boom(*_a, **_k):
        raise RuntimeError("ledger is down")

    monkeypatch.setattr(lrs, "apply", boom)

    result = await svc.reconcile_recent(db)

    assert result.results[0].skipped == "error"
    assert (await _session_money(db, sid))["cost_usd"] == pytest.approx(1.0)
    assert await _provenance(db, sid) == []


# ─── Lane A must not add to Lane B's total ──────────────────────────────────


async def test_a_stop_hook_after_reconciliation_does_not_add_to_the_vendor_total(
    db, tmp_path
):
    """The clobber, which would look like the vendor figure drifting upward.

    `record_stop` accumulates an estimate every turn. Once Lane B owns
    `cost_usd` the reconciler refuses that accumulation, and — since #176 —
    `record_stop` honours the refusal instead of running its SQL anyway.
    Liveness still lands: the session must still go idle.
    """
    sid = await _seed_session(db, session_id="stop-1")
    await _seed_series(db, sid, "cost_usd", 0.4000)
    await _seed_series(db, sid, "tokens_input", 5000)
    await _seed_series(db, sid, "tokens_output", 700)
    await svc.reconcile_recent(db)

    transcript = _write_transcript(tmp_path, sid)
    await agent_service.record_stop(
        db,
        {"session_id": sid, "cwd": "/tmp/x", "transcript_path": transcript},
    )
    await db.commit()

    money = await _session_money(db, sid)
    assert money["cost_usd"] == pytest.approx(0.4000)
    assert money["tokens_in"] == 5000
    assert money["tokens_out"] == 700
    # Lane A still owns the fields it is ranked first for.
    assert money["context_tokens"] > 0
    async with db.execute(
        "SELECT status FROM agent_sessions WHERE session_id = ?", (sid,)
    ) as cur:
        assert (await cur.fetchone())["status"] == "idle"


async def test_lane_a_still_accumulates_when_lane_b_is_absent(db, tmp_path):
    """The other side of that gate: with no Lane B claim nothing changes.

    Lane C claims none of the five money fields, so on a database without
    telemetry every verdict in `record_stop` is still `applied=True` and the
    hook path behaves exactly as it did before #176.
    """
    sid = await _seed_session(db, session_id="stop-2")
    transcript = _write_transcript(tmp_path, sid)

    await agent_service.record_stop(
        db, {"session_id": sid, "cwd": "/tmp/x", "transcript_path": transcript}
    )
    await db.commit()
    first = await _session_money(db, sid)
    assert first["cost_usd"] > 0

    await agent_service.record_stop(
        db, {"session_id": sid, "cwd": "/tmp/x", "transcript_path": transcript}
    )
    await db.commit()
    second = await _session_money(db, sid)
    assert second["cost_usd"] == pytest.approx(first["cost_usd"] * 2)
    assert second["tokens_in"] == first["tokens_in"] * 2


# ─── Local helpers that need the services above ─────────────────────────────


async def _record_lane_a_claims(
    conn: aiosqlite.Connection, session_id: str, *, cost: float
) -> None:
    """Put Lane A on the money fields, the way `record_stop` does.

    Through the reconciler rather than by inserting provenance rows directly,
    so the fixture cannot encode a claim shape the real writer would not
    produce.
    """
    for field_name, value in (
        ("cost_usd", cost),
        ("tokens_in", 9),
        ("tokens_out", 9),
    ):
        await lrs.accumulate(conn, session_id, lrs.LANE_HOOK, field_name, value)
    await lrs.apply(conn, session_id, lrs.LANE_HOOK, "model", "guess")
    await conn.commit()


_TRANSCRIPT_LINE = (
    '{"type":"assistant","message":{"model":"claude-sonnet-4-5","usage":'
    '{"input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":500,'
    '"cache_creation_input_tokens":100}}}'
)


def _write_transcript(tmp_path: pathlib.Path, session_id: str) -> str:
    """A one-turn JSONL transcript for `record_stop` to price.

    `record_stop` reads usage off the file rather than the hook payload, so a
    test that wants Lane A to produce a non-zero estimate has to give it one.
    """
    path = tmp_path / f"{session_id}.jsonl"
    path.write_text(_TRANSCRIPT_LINE + "\n", encoding="utf-8")
    return str(path)


# ─── The wiring: reconciliation runs on the ingest path ─────────────────────


def _attr(key: str, value: Any) -> dict[str, Any]:
    if isinstance(value, int) and not isinstance(value, bool):
        return {"key": key, "value": {"intValue": str(value)}}
    return {"key": key, "value": {"stringValue": value}}


def _export(session_id: str, cost: float, tokens_in: int) -> dict[str, Any]:
    """A cumulative OTLP/JSON export shaped the way the CLI sends one.

    `session.id` on the data point (not the resource), `aggregationTemporality`
    2 (CUMULATIVE, the CLI's default). Hand-built here rather than imported
    from `test_otlp_receiver` so this file's wiring test does not depend on
    another module's private fixture.
    """
    common = [_attr("session.id", session_id), _attr("model", MODEL)]

    def sum_block(points: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "dataPoints": points,
            "aggregationTemporality": 2,
            "isMonotonic": True,
        }

    return {
        "resourceMetrics": [
            {
                "resource": {"attributes": [_attr("service.name", "claude-code")]},
                "scopeMetrics": [
                    {
                        "metrics": [
                            {
                                "name": "claude_code.cost.usage",
                                "unit": "USD",
                                "sum": sum_block(
                                    [{"attributes": common, "asDouble": cost}]
                                ),
                            },
                            {
                                "name": "claude_code.token.usage",
                                "sum": sum_block(
                                    [
                                        {
                                            "attributes": common
                                            + [_attr("type", "input")],
                                            "asInt": str(tokens_in),
                                        }
                                    ]
                                ),
                            },
                        ]
                    }
                ],
            }
        ]
    }


async def test_posting_an_export_reconciles_the_session(db):
    """End to end: the vendor figure reaches `agent_sessions` through the route.

    Two identical posts, because that is what a cumulative exporter does on its
    timer — the session's cost must be one export's worth, and Lane B must own
    the column afterwards.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import app.database as db_module
    from app.routers import otlp as otlp_router

    sid = await _seed_session(db, cost=0.9999, tokens_in=1, tokens_out=1)
    await _record_lane_a_claims(db, sid, cost=0.9999)

    original = db_module._db
    db_module._db = db
    try:
        application = FastAPI()
        application.include_router(otlp_router.router)
        client = TestClient(application, raise_server_exceptions=False)
        body = _export(sid, 0.3300, 7000)
        for _ in range(2):
            assert client.post("/v1/metrics", json=body).status_code == 200
    finally:
        db_module._db = original

    money = await _session_money(db, sid)
    assert money["cost_usd"] == pytest.approx(0.33)
    assert money["tokens_in"] == 7000
    claims = await lrs.read(db, sid)
    assert claims["cost_usd"]["lane"] == lrs.LANE_OTLP
    assert "superseded lane-A 0.999900" in claims["cost_usd"]["value_text"]


# ─── The two defects independent verification found ──────────────────────────


async def test_a_cost_series_of_zero_does_not_zero_a_good_estimate(db):
    """A row that exists and says zero is not an observation.

    The neighbour of "absence of evidence is not a zero", one step further in:
    "no rows" was handled from the start, "one row saying zero" was not. A
    single export carrying cost 0.0 passed the presence test, reconciled as a
    real figure, stamped Lane B, and — Lane B outranking every other lane —
    locked the truth out permanently. Verification reproduced exactly that
    against the live route: $4.50 became $0.00 and Lane A's repair attempt came
    back `applied=False reason=outranked`.

    The regression guard is no help here by construction: it only engages once
    Lane B already owns the field, so a first claim is unguarded at any value.
    """
    sid = await _seed_session(db, "zero-cost", cost=4.50, tokens_in=900)
    await _seed_series(db, sid, "cost_usd", 0.0)
    await _seed_series(db, sid, "tokens_input", 12000)

    result = await svc.reconcile_session(db, sid)
    await db.commit()

    money = await _session_money(db, sid)
    assert money["cost_usd"] == 4.50, "a zero-valued series must not be applied"
    assert result.refused["cost_usd"] == "not-observed"
    assert not any(
        field == "cost_usd" and lane == svc.LANE
        for field, lane, _ in await _provenance(db, sid)
    ), "Lane B must not stamp a field it did not observe"

    # The session is genuinely reporting telemetry, so the key that DID carry a
    # real value is still reconciled. Refusing the zero must not refuse the row.
    assert money["tokens_in"] == 12000


async def test_the_regression_guard_reads_lane_b_own_prior_not_the_column(db):
    """A torn claim must self-correct rather than lock Lane B out forever.

    If a claim is recorded without its column write — a lost write, a fault, a
    discarded transaction — provenance says Lane B owns the field while the
    column still holds Lane A's number. A guard that compares against the
    COLUMN then measures Lane B's real total against a Lane A figure, and when
    Lane A's was higher it refuses the truth as a regression on every future
    export, permanently, on the one field Lane B exists to own.

    Reading the prior figure out of the ledger instead makes the guard correct
    regardless of transaction state, which is what allowed the destructive
    shared-connection `rollback()` to be removed.
    """
    sid = await _seed_session(db, "torn", cost=9.99, tokens_in=10)
    await _seed_series(db, sid, "cost_usd", 1.00)
    await svc.reconcile_session(db, sid)
    await db.commit()
    assert (await _session_money(db, sid))["cost_usd"] == 1.00

    # Tear it: put Lane A's higher number back in the column while Lane B's
    # provenance row keeps saying Lane B owns the field at 1.00.
    await db.execute(
        "UPDATE agent_sessions SET cost_usd = 9.99 WHERE session_id = ?", (sid,)
    )
    await db.commit()

    await _seed_series(db, sid, "cost_usd", 2.00)
    result = await svc.reconcile_session(db, sid)
    await db.commit()

    assert result.refused.get("cost_usd") != "regressed", (
        "2.00 is a rise against Lane B's own prior 1.00; only a column-based "
        "guard would read it as a fall from 9.99"
    )
    assert (await _session_money(db, sid))["cost_usd"] == 2.00


async def test_a_reconcile_fault_does_not_roll_back_another_caller(db, monkeypatch):
    """The #172-class defect, on the one route whose input comes from outside.

    `get_db()` hands every request the same connection and SQLite has no nested
    transactions, so a bare `rollback()` discards whatever is uncommitted on the
    connection — not "this session's claims". Verification reproduced a hook
    mid-transaction losing its cost_usd and its agent_events row to a reconcile
    fault on an unrelated session.

    The fault has to be induced: a healthy session never reaches the error
    branch, so an earlier version of this test passed with the defect still in
    place and proved nothing.
    """
    victim = await _seed_session(db, "victim", cost=0.0)
    await _seed_session(db, "faulty", cost=1.0)
    await _seed_series(db, "faulty", "cost_usd", 5.0)

    real_totals = receiver.session_totals

    async def _boom(conn, session_id):
        if session_id == "faulty":
            raise RuntimeError("induced reconcile fault")
        return await real_totals(conn, session_id)

    monkeypatch.setattr(receiver, "session_totals", _boom)

    # Another caller's work, uncommitted on the shared connection.
    await db.execute(
        "UPDATE agent_sessions SET cost_usd = 42.0 WHERE session_id = ?", (victim,)
    )

    pass_result = await svc.reconcile_recent(db)
    assert any(r.skipped == "error" for r in pass_result.results), (
        "the fault must actually reach the error branch, or this proves nothing"
    )

    async with db.execute(
        "SELECT cost_usd FROM agent_sessions WHERE session_id = ?", (victim,)
    ) as cur:
        row = await cur.fetchone()
    assert row["cost_usd"] == 42.0, (
        "a reconcile pass must not discard another caller's uncommitted writes"
    )
