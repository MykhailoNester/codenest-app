"""Tests for insights_service.

Covers each rule's threshold logic and the ledger-based "one card per
(rule, UTC day)" idempotency contract.
"""

from __future__ import annotations

import pathlib

import aiosqlite
import pytest
import pytest_asyncio

from app.services import insights_service

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await db.executescript(mig.read_text())


@pytest_asyncio.fixture
async def db(tmp_path):
    conn = await aiosqlite.connect(str(tmp_path / "test.db"))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    yield conn
    await conn.close()


async def _insert_session(
    db: aiosqlite.Connection,
    *,
    session_id: str,
    cost: float,
    days_ago: int,
    model: str | None = None,
) -> None:
    await db.execute(
        "INSERT INTO agent_sessions "
        "(session_id, profile, status, started_at, last_event_at, cost_usd, model) "
        f"VALUES (?, 'default', 'idle', datetime('now', '-{days_ago} days'), "
        f"datetime('now', '-{days_ago} days'), ?, ?)",
        (session_id, cost, model),
    )
    await db.commit()


# ─── Rule: cost spike ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_cost_spike_fires_when_ratio_doubles(db):
    await _insert_session(db, session_id="a", cost=10.0, days_ago=1)
    await _insert_session(db, session_id="b", cost=2.0, days_ago=10)
    insight = await insights_service.rule_cost_spike_week_over_week(db)
    assert insight is not None
    assert insight.rule_key == "cost_spike_week_over_week"
    assert insight.payload["ratio"] >= 2.0


@pytest.mark.asyncio
async def test_cost_spike_silent_when_below_min_usd(db):
    await _insert_session(db, session_id="a", cost=0.5, days_ago=1)
    await _insert_session(db, session_id="b", cost=0.05, days_ago=10)
    assert await insights_service.rule_cost_spike_week_over_week(db) is None


@pytest.mark.asyncio
async def test_cost_spike_silent_with_no_baseline(db):
    await _insert_session(db, session_id="a", cost=5.0, days_ago=2)
    assert await insights_service.rule_cost_spike_week_over_week(db) is None


# ─── Rule: dominant model share ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provider_dominant_share_fires(db):
    await _insert_session(db, session_id="a", cost=8.0, days_ago=1, model="opus-4-7")
    await _insert_session(db, session_id="b", cost=2.0, days_ago=1, model="sonnet-4-6")
    insight = await insights_service.rule_provider_dominant_share(db)
    assert insight is not None
    assert insight.payload["model"] == "opus-4-7"
    assert insight.payload["share"] >= 0.6


@pytest.mark.asyncio
async def test_provider_dominant_share_silent_below_min_total(db):
    await _insert_session(db, session_id="a", cost=2.0, days_ago=1, model="opus")
    await _insert_session(db, session_id="b", cost=0.5, days_ago=1, model="sonnet")
    assert await insights_service.rule_provider_dominant_share(db) is None


@pytest.mark.asyncio
async def test_provider_dominant_share_silent_when_evenly_split(db):
    await _insert_session(db, session_id="a", cost=5.0, days_ago=1, model="opus")
    await _insert_session(db, session_id="b", cost=5.0, days_ago=1, model="sonnet")
    assert await insights_service.rule_provider_dominant_share(db) is None


# ─── Publish dedup ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_generate_and_publish_is_idempotent_per_day(db):
    await _insert_session(db, session_id="a", cost=10.0, days_ago=1)
    await _insert_session(db, session_id="b", cost=2.0, days_ago=10)
    published = await insights_service.generate_and_publish(db)
    assert any(p["rule_key"] == "cost_spike_week_over_week" for p in published)
    again = await insights_service.generate_and_publish(db)
    assert again == []


@pytest.mark.asyncio
async def test_publish_writes_workflow_item_with_insight_source(db):
    await _insert_session(db, session_id="a", cost=10.0, days_ago=1)
    await _insert_session(db, session_id="b", cost=2.0, days_ago=10)
    published = await insights_service.generate_and_publish(db)
    assert published
    inbox_id = published[0]["inbox_id"]
    async with db.execute(
        "SELECT source, title, status FROM workflow_items WHERE id = ?",
        (inbox_id,),
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["source"] == "insight"
    assert row["status"] == "inbox"


@pytest.mark.asyncio
async def test_rule_that_didnt_fire_today_can_fire_later_same_day(db):
    # cost_spike fires on the first call (spike present). provider_dominant
    # rule has no candidate because total spend < $5. Later, after more
    # sessions land, the dominant rule's threshold is met; the next
    # generate_and_publish call must publish *only* the new rule's card.
    await _insert_session(db, session_id="a1", cost=2.0, days_ago=1, model="opus")
    await _insert_session(db, session_id="a2", cost=0.5, days_ago=10)
    first = await insights_service.generate_and_publish(db)
    keys_first = {p["rule_key"] for p in first}
    assert "cost_spike_week_over_week" in keys_first
    assert "provider_dominant_share" not in keys_first

    # Bump model spend over the $5 floor with opus still dominant.
    await _insert_session(db, session_id="a3", cost=8.0, days_ago=1, model="opus")
    second = await insights_service.generate_and_publish(db)
    keys_second = {p["rule_key"] for p in second}
    assert keys_second == {"provider_dominant_share"}, (
        f"expected only provider_dominant_share, got {keys_second}"
    )


# ─── Supersession ────────────────────────────────────────────────────────────
#
# These rules describe standing conditions, so a second day's card is the same
# fact with a fresher number rather than a second thing to do. Without
# supersession each rule added an inbox row every day it fired: 17 of 47 open
# items came from three rules.


async def _publish_on_day(db: aiosqlite.Connection, day_key: str) -> int:
    """Publish the cost-spike card as if it were `day_key`, return its inbox id."""
    await db.execute("DELETE FROM insight_runs WHERE day_key = ?", (day_key,))
    await db.commit()
    published = await insights_service.generate_and_publish(db, day_key=day_key)
    spike = [p for p in published if p["rule_key"] == "cost_spike_week_over_week"]
    assert spike, f"cost spike did not fire on {day_key}"
    return int(spike[0]["inbox_id"])


@pytest.mark.asyncio
async def test_a_new_card_supersedes_its_rules_untriaged_predecessor(db):
    await _insert_session(db, session_id="a", cost=10.0, days_ago=1)
    await _insert_session(db, session_id="b", cost=2.0, days_ago=10)

    first = await _publish_on_day(db, "2026-10-01")
    second = await _publish_on_day(db, "2026-10-02")
    assert first != second

    async with db.execute(
        "SELECT id, status, description FROM workflow_items WHERE id IN (?, ?)",
        (first, second),
    ) as cur:
        rows = {int(r["id"]): r for r in await cur.fetchall()}

    assert rows[first]["status"] == "rejected"
    assert f"Superseded by inbox #{second}" in rows[first]["description"]
    assert rows[second]["status"] == "inbox"


@pytest.mark.asyncio
async def test_supersession_never_overwrites_a_human_decision(db):
    await _insert_session(db, session_id="a", cost=10.0, days_ago=1)
    await _insert_session(db, session_id="b", cost=2.0, days_ago=10)

    first = await _publish_on_day(db, "2026-10-01")
    # Someone triaged it — that is a decision, not a stale card.
    await db.execute(
        "UPDATE workflow_items SET status = 'ready' WHERE id = ?", (first,)
    )
    await db.commit()

    await _publish_on_day(db, "2026-10-02")

    async with db.execute(
        "SELECT status FROM workflow_items WHERE id = ?", (first,)
    ) as cur:
        row = await cur.fetchone()
    assert row is not None
    assert row["status"] == "ready"


@pytest.mark.asyncio
async def test_supersession_is_keyed_per_rule(db):
    """Each rule replaces only its own card.

    Both rules re-fire on the second day, so both day-one cards are correctly
    superseded — the property that matters is *by which card*. A rule that
    swept every open insight would also reject its sibling's current one.
    """
    await _insert_session(db, session_id="a", cost=10.0, days_ago=1, model="opus")
    await _insert_session(db, session_id="b", cost=2.0, days_ago=10)

    day1 = await insights_service.generate_and_publish(db, day_key="2026-10-01")
    first = {p["rule_key"]: int(p["inbox_id"]) for p in day1}
    assert len(first) >= 2, f"need two rules to fire, got {first}"

    await db.execute("DELETE FROM insight_runs WHERE day_key = ?", ("2026-10-02",))
    await db.commit()
    day2 = await insights_service.generate_and_publish(db, day_key="2026-10-02")
    second = {p["rule_key"]: int(p["inbox_id"]) for p in day2}

    for rule_key, old_id in first.items():
        if rule_key not in second:
            continue
        async with db.execute(
            "SELECT status, description FROM workflow_items WHERE id = ?", (old_id,)
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["status"] == "rejected", f"{rule_key}'s old card should be closed"
        assert f"Superseded by inbox #{second[rule_key]}" in row["description"], (
            f"{rule_key}'s card must name its own successor, not another rule's"
        )

    # and every rule's current card is still open
    for rule_key, new_id in second.items():
        async with db.execute(
            "SELECT status FROM workflow_items WHERE id = ?", (new_id,)
        ) as cur:
            row = await cur.fetchone()
        assert row is not None
        assert row["status"] == "inbox", f"{rule_key}'s current card was closed"
