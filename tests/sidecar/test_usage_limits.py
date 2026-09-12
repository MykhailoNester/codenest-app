from __future__ import annotations

from datetime import UTC, datetime

import aiosqlite
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import usage as usage_router
from app.services import usage_limits_service

NOW = datetime(2026, 9, 12, 12, 0, 0, tzinfo=UTC).replace(tzinfo=None)


async def _session(db: aiosqlite.Connection, session_id: str, **cols) -> None:
    keys = ["session_id", *cols]
    await db.execute(
        f"INSERT INTO agent_sessions ({', '.join(keys)}) "
        f"VALUES ({', '.join('?' for _ in keys)})",
        (session_id, *cols.values()),
    )
    await db.commit()


async def _series(
    db: aiosqlite.Connection, session_id: str, metric_key: str, value: float
) -> None:
    await db.execute(
        "INSERT INTO otlp_metric_series "
        "(session_id, metric_key, series_key, temporality, value, points) "
        "VALUES (?, ?, ?, 'cumulative', ?, 1)",
        (session_id, metric_key, f"{metric_key}-key", value),
    )
    await db.commit()


async def _claim(db: aiosqlite.Connection, session_id: str, field: str) -> None:
    await db.execute(
        "INSERT INTO session_field_provenance (session_id, field, lane, value_text) "
        "VALUES (?, ?, 'B', '1.0')",
        (session_id, field),
    )
    await db.commit()


@pytest.mark.asyncio
async def test_estimate_drops_the_sessions_lane_b_superseded(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(
        migrated_db, "estimated", started_at="2026-09-12T09:00:00", cost_usd=0.5
    )
    await _session(
        migrated_db, "vendor", started_at="2026-09-12T10:00:00", cost_usd=2.0
    )
    await _claim(migrated_db, "vendor", "cost_usd")
    await _series(migrated_db, "vendor", "cost_usd", 2.0)
    await _series(migrated_db, "vendor", "tokens_input", 900)

    report = await usage_limits_service.consumption(migrated_db, "7d", now=NOW)

    assert report["estimate"]["sessions"] == 1
    assert report["estimate"]["cost_usd"] == pytest.approx(0.5)
    assert report["vendor"]["sessions"] == 1
    assert report["vendor"]["cost_usd"] == pytest.approx(2.0)
    assert report["vendor"]["tokens_input"] == pytest.approx(900)
    assert report["sessions"] == {
        "total": 2,
        "vendor_observed": 1,
        "not_observed": 1,
        "superseded": 1,
    }


@pytest.mark.asyncio
async def test_a_metric_nothing_exported_is_none_not_zero(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(migrated_db, "s1", started_at="2026-09-12T09:00:00", cost_usd=0.25)
    await _series(migrated_db, "s1", "tokens_input", 100)

    report = await usage_limits_service.consumption(migrated_db, "7d", now=NOW)

    assert report["vendor"]["observed"] is True
    assert report["vendor"]["cost_usd"] is None
    assert report["vendor"]["tokens_cache_read"] is None
    assert report["estimate"]["cost_usd"] == pytest.approx(0.25)


@pytest.mark.asyncio
async def test_no_sessions_in_window_reads_as_unobserved_on_both_sides(
    migrated_db: aiosqlite.Connection,
) -> None:
    await _session(migrated_db, "old", started_at="2026-08-01T09:00:00", cost_usd=9.0)
    await _series(migrated_db, "old", "cost_usd", 9.0)

    report = await usage_limits_service.consumption(migrated_db, "24h", now=NOW)

    assert report["estimate"] == {
        "lane": "A",
        "observed": False,
        "sessions": 0,
        "cost_usd": None,
        "tokens_in": None,
        "tokens_out": None,
    }
    assert report["vendor"]["observed"] is False
    assert report["vendor"]["cost_usd"] is None
    assert report["sessions"]["total"] == 0


def test_route_refuses_a_window_it_does_not_know() -> None:
    application = FastAPI()
    application.include_router(usage_router.router)
    response = TestClient(application).get(
        "/api/v1/usage/consumption", params={"window": "all-time"}
    )
    assert response.status_code == 422
