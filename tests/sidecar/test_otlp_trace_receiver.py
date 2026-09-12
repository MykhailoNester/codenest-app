"""Tests for the Lane B OTLP trace receiver (#178).

The wire shape here is the one a real export has: resourceSpans → scopeSpans →
spans, `session.id` on the *span* attributes rather than on the resource, and
nanosecond timestamps as JSON strings.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import otlp as otlp_router
from app.services import event_retention_service
from app.services import otlp_trace_receiver_service as svc

pytestmark = pytest.mark.asyncio

SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


@pytest.fixture(autouse=True)
def _fresh_stats():
    svc.reset_receiver_stats()
    yield
    svc.reset_receiver_stats()


@pytest_asyncio.fixture
async def session_db(migrated_db: aiosqlite.Connection) -> aiosqlite.Connection:
    await migrated_db.execute(
        "INSERT INTO agent_sessions (session_id, profile, cwd, status)"
        " VALUES (?, 'test', '/Users/test/project', 'active')",
        (SESSION,),
    )
    await migrated_db.commit()
    return migrated_db


@pytest.fixture
def client(session_db: aiosqlite.Connection):
    original = db_module._db
    db_module._db = session_db
    try:
        application = FastAPI()
        application.include_router(otlp_router.router)
        yield TestClient(application, raise_server_exceptions=False)
    finally:
        db_module._db = original


def _attr(key: str, value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    return {"key": key, "value": {"stringValue": str(value)}}


def _span(
    name: str,
    duration_ms: float,
    *,
    session_id: str | None = SESSION,
    attrs: dict[str, Any] | None = None,
    error: bool = False,
) -> dict[str, Any]:
    start = 1_700_000_000_000_000_000
    attributes = [] if session_id is None else [_attr("session.id", session_id)]
    for key, value in (attrs or {}).items():
        attributes.append(_attr(key, value))
    span: dict[str, Any] = {
        "traceId": "0" * 32,
        "spanId": "0" * 16,
        "name": name,
        "startTimeUnixNano": str(start),
        "endTimeUnixNano": str(start + int(duration_ms * 1_000_000)),
        "attributes": attributes,
    }
    if error:
        span["status"] = {"code": 2, "message": "boom"}
    return span


def _export(*spans: dict[str, Any]) -> dict[str, Any]:
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        _attr("service.name", "claude-code"),
                        _attr("os.type", "darwin"),
                    ]
                },
                "scopeSpans": [
                    {
                        "scope": {"name": svc.TRACER_NAME, "version": "2.1.251"},
                        "spans": list(spans),
                    }
                ],
            }
        ]
    }


async def _rows(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    async with db.execute(
        "SELECT * FROM otlp_span_stats ORDER BY span_name, operation"
    ) as cur:
        return [dict(row) for row in await cur.fetchall()]


async def test_spans_aggregate_per_tool_and_per_hook(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Count, failure count and duration, keyed by the operation that ran."""
    resp = client.post(
        "/v1/traces",
        json=_export(
            _span("claude_code.hook", 120.0, attrs={"hook.event": "PreToolUse"}),
            _span("claude_code.hook", 80.0, attrs={"hook.event": "PreToolUse"}),
            _span("claude_code.hook", 40.0, attrs={"hook.event": "Stop"}),
            _span("claude_code.tool", 500.0, attrs={"tool.name": "Bash"}),
            _span("claude_code.tool", 300.0, attrs={"tool.name": "Bash"}, error=True),
        ),
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"partialSuccess": {}}

    rows = {(r["span_name"], r["operation"]): r for r in await _rows(session_db)}
    assert set(rows) == {
        ("claude_code.hook", "PreToolUse"),
        ("claude_code.hook", "Stop"),
        ("claude_code.tool", "Bash"),
    }

    pre = rows[("claude_code.hook", "PreToolUse")]
    assert pre["count"] == 2
    assert pre["error_count"] == 0
    assert pre["total_duration_ms"] == pytest.approx(200.0)
    assert pre["min_duration_ms"] == pytest.approx(80.0)
    assert pre["max_duration_ms"] == pytest.approx(120.0)

    bash = rows[("claude_code.tool", "Bash")]
    assert bash["count"] == 2
    assert bash["error_count"] == 1
    assert bash["max_duration_ms"] == pytest.approx(500.0)


async def test_repeated_exports_accumulate_without_growing_the_table(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """The #159 regression in a new place: rows track operations, not activity."""
    body = _export(_span("claude_code.hook", 10.0, attrs={"hook.event": "Stop"}))
    for _ in range(20):
        assert (
            client.post(
                "/v1/traces", json=body, headers={"content-type": "application/json"}
            ).status_code
            == 200
        )

    rows = await _rows(session_db)
    assert len(rows) == 1
    assert rows[0]["count"] == 20
    assert rows[0]["total_duration_ms"] == pytest.approx(200.0)


async def test_a_span_naming_an_unknown_session_is_refused_and_counted(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    resp = client.post(
        "/v1/traces",
        json=_export(
            _span(
                "claude_code.hook",
                10.0,
                session_id="99999999-9999-9999-9999-999999999999",
                attrs={"hook.event": "Stop"},
            )
        ),
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 200
    assert resp.json()["partialSuccess"]["rejectedSpans"] == "1"
    assert await _rows(session_db) == []

    async with session_db.execute("SELECT COUNT(*) AS n FROM agent_sessions") as cur:
        row = await cur.fetchone()
    assert row["n"] == 1  # the receiver never invents the session it was told about

    assert svc.receiver_stats()["rejections"][svc.REJECT_UNKNOWN_SESSION] == 1


async def test_an_unknown_span_name_is_dropped(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """A closed allowlist, so the table cannot become arbitrary key/value storage."""
    resp = client.post(
        "/v1/traces",
        json=_export(_span("something.else", 10.0)),
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 200
    assert await _rows(session_db) == []
    assert svc.receiver_stats()["rejections"][svc.REJECT_UNKNOWN_SPAN] == 1


async def test_a_hostile_body_never_becomes_a_500(client: TestClient) -> None:
    assert (
        client.post(
            "/v1/traces",
            content=b"not json at all",
            headers={"content-type": "application/json"},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/v1/traces",
            json={"resourceSpans": "nonsense"},
            headers={"content-type": "application/json"},
        ).status_code
        == 200
    )


async def test_the_surface_read_rolls_up_across_sessions(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    client.post(
        "/v1/traces",
        json=_export(
            _span("claude_code.hook", 100.0, attrs={"hook.event": "PreToolUse"}),
            _span("claude_code.hook", 300.0, attrs={"hook.event": "PreToolUse"}),
            _span("claude_code.tool", 50.0, attrs={"tool.name": "Read"}),
        ),
        headers={"content-type": "application/json"},
    )

    report = await svc.operation_stats(session_db)
    assert report["span_count"] == 3
    assert report["session_count"] == 1

    by_op = {op["operation"]: op for op in report["operations"]}
    assert by_op["PreToolUse"]["category"] == "hook"
    assert by_op["PreToolUse"]["count"] == 2
    assert by_op["PreToolUse"]["avg_duration_ms"] == pytest.approx(200.0)
    assert by_op["Read"]["category"] == "tool"


async def test_retention_prunes_the_span_table_on_last_seen_at(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    client.post(
        "/v1/traces",
        json=_export(_span("claude_code.hook", 10.0, attrs={"hook.event": "Stop"})),
        headers={"content-type": "application/json"},
    )
    assert len(await _rows(session_db)) == 1

    cls = next(
        c
        for c in event_retention_service.RETENTION_CLASSES
        if c.table == "otlp_span_stats"
    )
    assert cls.timestamp_column == "last_seen_at"

    old = (datetime.now(UTC).replace(tzinfo=None) - timedelta(days=400)).isoformat(
        sep=" ", timespec="seconds"
    )
    await session_db.execute("UPDATE otlp_span_stats SET last_seen_at = ?", (old,))
    await session_db.commit()

    await event_retention_service.prune_agent_events(session_db)
    assert await _rows(session_db) == []
