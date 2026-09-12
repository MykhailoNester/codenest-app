from __future__ import annotations

import aiosqlite
import pytest

from app.services import lane_reconciler_service as lane_reconciler
from app.services import session_inspector_service

pytestmark = pytest.mark.asyncio


async def _session(db: aiosqlite.Connection, session_id: str = "s1", **cols) -> None:
    keys = ["session_id", *cols]
    await db.execute(
        f"INSERT INTO agent_sessions ({', '.join(keys)}) "
        f"VALUES ({', '.join('?' for _ in keys)})",
        (session_id, *cols.values()),
    )
    await db.commit()


async def _claim(
    db: aiosqlite.Connection, lane: str, field: str, value, session_id: str = "s1"
) -> None:
    result = await lane_reconciler.apply(db, session_id, lane, field, value)
    assert result.applied, result.reason
    await db.commit()


async def test_missing_session_is_none(migrated_db: aiosqlite.Connection) -> None:
    assert await session_inspector_service.inspect(migrated_db, "nope") is None


async def test_money_field_shows_the_winning_lane_and_the_earlier_claim(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(migrated_db, cost_usd=4.25)
    await _claim(migrated_db, lane_reconciler.LANE_HOOK, "cost_usd", 1.10)
    await _claim(migrated_db, lane_reconciler.LANE_OTLP, "cost_usd", 4.25)

    report = await session_inspector_service.inspect(migrated_db, "s1")
    cost = next(f for f in report["fields"] if f["field"] == "cost_usd")

    assert cost["winning_lane"] == lane_reconciler.LANE_OTLP
    assert cost["state"] == "claimed"
    assert [(c["lane"], c["value_text"]) for c in cost["claims"]] == [
        (lane_reconciler.LANE_HOOK, "1.1"),
        (lane_reconciler.LANE_OTLP, "4.25"),
    ]


async def test_lane_a_only_session_reports_lane_b_unobserved(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(migrated_db, cost_usd=0.0, tokens_in=0)
    await migrated_db.execute(
        "INSERT INTO agent_events (session_id, event_type, payload_json) VALUES (?, ?, ?)",
        ("s1", "SessionStart", "{}"),
    )
    await migrated_db.commit()

    report = await session_inspector_service.inspect(migrated_db, "s1")
    by_lane = {lane["lane"]: lane for lane in report["lanes"]}

    assert by_lane[lane_reconciler.LANE_HOOK]["observed"] is True
    assert by_lane[lane_reconciler.LANE_OTLP]["observed"] is False
    assert report["operations"] == []
    # An untouched 0.0 is not a measurement of zero.
    cost = next(f for f in report["fields"] if f["field"] == "cost_usd")
    assert cost["state"] == "unobserved"


async def test_value_without_a_claim_is_not_attributed_to_a_lane(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(migrated_db, cost_usd=2.0)
    report = await session_inspector_service.inspect(migrated_db, "s1")
    cost = next(f for f in report["fields"] if f["field"] == "cost_usd")
    assert cost["state"] == "untracked"
    assert cost["winning_lane"] is None


async def test_project_spans_are_listed_in_order_with_a_duration(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(migrated_db)
    await migrated_db.executemany(
        "INSERT INTO session_project_spans "
        "(session_id, seq, cwd, started_at, ended_at, last_seen_at) VALUES (?,?,?,?,?,?)",
        [
            (
                "s1",
                0,
                "/Users/test/a",
                "2026-09-12T10:00:00",
                "2026-09-12T10:05:00",
                "2026-09-12T10:04:00",
            ),
            (
                "s1",
                1,
                "/Users/test/b",
                "2026-09-12T10:05:00",
                None,
                "2026-09-12T10:11:00",
            ),
        ],
    )
    await migrated_db.commit()

    spans = (await session_inspector_service.inspect(migrated_db, "s1"))["spans"]
    assert [s["cwd"] for s in spans] == ["/Users/test/a", "/Users/test/b"]
    assert spans[0]["seconds"] == 300.0
    assert spans[1]["open"] is True
    assert spans[1]["seconds"] == 360.0


async def test_span_stats_carry_their_category_and_average(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(migrated_db)
    await migrated_db.execute(
        "INSERT INTO otlp_span_stats "
        "(session_id, span_name, operation, count, error_count, total_duration_ms,"
        " min_duration_ms, max_duration_ms) VALUES (?,?,?,?,?,?,?,?)",
        ("s1", "claude_code.tool", "Bash", 4, 1, 800.0, 100.0, 400.0),
    )
    await migrated_db.commit()

    op = (await session_inspector_service.inspect(migrated_db, "s1"))["operations"][0]
    assert op["category"] == "tool"
    assert op["avg_duration_ms"] == 200.0
    assert op["error_count"] == 1
