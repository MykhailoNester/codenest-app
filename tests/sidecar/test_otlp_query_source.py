"""#177 — Lane B spend split by `query_source`, with no vocabulary declared."""

from __future__ import annotations

import json
from typing import Any

import aiosqlite
import pytest
import pytest_asyncio

from app.services import otlp_receiver_service as svc

SESSION = "11111111-2222-4333-8444-555555555555"


@pytest_asyncio.fixture
async def session_db(migrated_db: aiosqlite.Connection) -> aiosqlite.Connection:
    await migrated_db.execute(
        "INSERT INTO agent_sessions (session_id, profile, cwd, status)"
        " VALUES (?, 'test', '/Users/test/work', 'active')",
        (SESSION,),
    )
    await migrated_db.commit()
    return migrated_db


def _attr(key: str, value: Any) -> dict[str, Any]:
    return {"key": key, "value": {"stringValue": value}}


def _export(cost: float, query_source: str | None) -> bytes:
    dimensions = [_attr("model", "claude-opus-4-5-20260514")]
    if query_source is not None:
        dimensions.append(_attr("query_source", query_source))
    body = {
        "resourceMetrics": [
            {
                "resource": {"attributes": [_attr("service.name", "claude-code")]},
                "scopeMetrics": [
                    {
                        "metrics": [
                            {
                                "name": "claude_code.cost.usage",
                                "sum": {
                                    "dataPoints": [
                                        {
                                            "attributes": [
                                                _attr("session.id", SESSION),
                                                *dimensions,
                                            ],
                                            "asDouble": cost,
                                        }
                                    ],
                                    "aggregationTemporality": 2,
                                    "isMonotonic": True,
                                },
                            }
                        ]
                    }
                ],
            }
        ]
    }
    return json.dumps(body).encode()


@pytest.mark.asyncio
async def test_split_discovers_values_and_keeps_unattributed_separate(
    session_db: aiosqlite.Connection,
) -> None:
    await svc.ingest(session_db, _export(0.50, "a_value_nobody_declared"))
    await svc.ingest(session_db, _export(0.25, "another_one"))
    await svc.ingest(session_db, _export(0.10, None))

    report = await svc.spend_by_query_source(session_db)
    by_source = {b["query_source"]: b["cost_usd"] for b in report["sources"]}

    assert by_source == {
        "a_value_nobody_declared": 0.50,
        "another_one": 0.25,
        None: 0.10,
    }
    assert report["sources"][0]["query_source"] == "a_value_nobody_declared"
    assert report["total_cost_usd"] == pytest.approx(0.85)


@pytest.mark.asyncio
async def test_attribution_gap_reports_lane_b_versus_project_ledger(
    session_db: aiosqlite.Connection,
) -> None:
    await svc.ingest(session_db, _export(1.00, "cli"))
    await session_db.execute(
        "INSERT INTO session_project_costs"
        " (session_id, project_id, tokens_in, tokens_out, cost_usd)"
        " VALUES (?, 1, 0, 0, 0.40)",
        (SESSION,),
    )
    await session_db.commit()

    gap = await svc.attribution_gap(session_db)
    assert gap["sessions"] == 1
    assert gap["lane_b_cost_usd"] == pytest.approx(1.00)
    assert gap["attributed_cost_usd"] == pytest.approx(0.40)
    assert gap["delta_usd"] == pytest.approx(0.60)
