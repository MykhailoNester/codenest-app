"""Tests for the Lane B OTLP receiver (epic #153 / #175).

Four things can go wrong here in ways that look fine, and they are what these
tests are for.

**The arithmetic.** Claude Code's exporter defaults to CUMULATIVE temporality:
every export restates each counter's running total since process start, on a
timer, forever. A receiver that adds those arrivals multiplies a session's cost
by its export count and produces a number that is merely large, not obviously
broken. `test_cumulative_restatement_does_not_double_count` posts the same wire
body three times and pins the total. Its mirror,
`test_delta_series_accumulate`, pins that a delta series still sums — the two
arithmetics are chosen per row, and a receiver that got one right by hardcoding
it would get the other wrong.

**The join.** #176, #177 and #178 all read Lane B by session, so a join that
silently attaches the right money to the wrong session — or to no session —
makes every downstream figure wrong while looking plausible. The join tests
pin the four cases: present, absent, present-but-wrong-typed, and naming a
session that does not exist. The last two must leave the database untouched
and must be *counted*, never silently swallowed, and
`test_unknown_session_is_not_invented` asserts the receiver does not create the
session it was told about.

**The wire shape.** `_wire_export()` below is built to the shape a real
`claude 2.1.251` export has, not to a shape convenient for the parser: the
nesting is resourceMetrics → scopeMetrics → metrics → sum.dataPoints; the
`session.id` attribute sits on the *data point*, where the CLI's common
attribute map puts it, and not on the resource, which carries only
`service.name` / `service.version` / `os.*` / `host.arch`; and `asInt` is a
JSON *string*, as the proto3 JSON mapping requires for int64. A receiver tested
only against a hand-simplified body passes and then joins nothing against the
real thing.

**The growth.** `test_repeated_exports_do_not_grow_the_table` is the #159
regression in a new place: an exporter pushing on a timer must not add a row
per push. Storage is one row per series; sixty exports of the same body must
leave the row count exactly where one export left it.
"""

from __future__ import annotations

import gzip
import json
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
from app.services import otlp_receiver_service as svc

pytestmark = pytest.mark.asyncio

SESSION = "11111111-2222-3333-4444-555555555555"
MODEL = "claude-opus-4-5-20260514"

# Series per export when a test needs to walk a session up to
# `MAX_SERIES_PER_SESSION`. Small enough that the JSON stays well inside
# `MAX_BODY_BYTES` (which binds long before the series cap does), large enough
# that reaching the cap takes a handful of posts rather than hundreds.
_CAP_BATCH = 256


# ─── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _fresh_stats():
    """The receiver's counters are process-global; isolate each test."""
    svc.reset_receiver_stats()
    yield
    svc.reset_receiver_stats()


@pytest_asyncio.fixture
async def session_db(migrated_db: aiosqlite.Connection) -> aiosqlite.Connection:
    """A migrated DB with one real session for exports to join against."""
    await migrated_db.execute(
        "INSERT INTO agent_sessions (session_id, profile, cwd, status)"
        " VALUES (?, 'test', '/tmp/x', 'active')",
        (SESSION,),
    )
    await migrated_db.commit()
    return migrated_db


@pytest.fixture
def client(session_db: aiosqlite.Connection):
    """A TestClient whose handlers see the migrated test connection.

    `raise_server_exceptions=False` on purpose: several tests assert that a
    hostile body produces a *response* rather than an exception, and with the
    default the exception would escape into the test instead of becoming the
    500 we are asserting the absence of.
    """
    original = db_module._db
    db_module._db = session_db
    try:
        application = FastAPI()
        application.include_router(otlp_router.router)
        yield TestClient(application, raise_server_exceptions=False)
    finally:
        db_module._db = original


# ─── The wire shape ──────────────────────────────────────────────────────────


def _attr(key: str, value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        # int64 is a string in OTLP JSON.
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": value}}


def _common_attrs(session_id: str = SESSION) -> list[dict[str, Any]]:
    """The CLI's per-process common attribute map, as it lands on every point.

    This is the set the binary builds once and spreads into every counter's
    `add()` call. `session.id` is in here — on the data point — which is the
    single fact the whole join depends on.
    """
    return [
        _attr("user.id", "c0ffee" * 10),
        _attr("session.id", session_id),
        _attr("app.version", "2.1.251"),
        _attr("organization.id", "7f3c0e5e-0000-4000-8000-000000000001"),
        _attr("user.email", "dev@example.com"),
        _attr("terminal.type", "iTerm.app"),
    ]


def _point(
    value: float,
    extra: list[dict[str, Any]],
    *,
    session_id: str = SESSION,
    as_int: bool = False,
) -> dict[str, Any]:
    point: dict[str, Any] = {
        "attributes": _common_attrs(session_id) + extra,
        "startTimeUnixNano": "1757600000000000000",
        "timeUnixNano": "1757600060000000000",
    }
    if as_int:
        point["asInt"] = str(int(value))
    else:
        point["asDouble"] = float(value)
    return point


def _wire_export(
    *,
    cost: float = 0.0423,
    tokens: tuple[int, int, int, int] = (1200, 340, 18000, 2400),
    temporality: int = 2,
    session_id: str = SESSION,
    model: str = MODEL,
    include_dropped: bool = True,
) -> dict[str, Any]:
    """An OTLP/HTTP JSON metrics export shaped like a real one.

    `temporality` 2 is CUMULATIVE — the CLI's default — and 1 is DELTA.
    """
    dimensions = [_attr("model", model)]
    metrics: list[dict[str, Any]] = [
        {
            "name": "claude_code.cost.usage",
            "description": "Cost of the Claude Code session",
            "unit": "USD",
            "sum": {
                "dataPoints": [_point(cost, dimensions, session_id=session_id)],
                "aggregationTemporality": temporality,
                "isMonotonic": True,
            },
        },
        {
            "name": "claude_code.token.usage",
            "description": "Number of tokens used",
            "unit": "tokens",
            "sum": {
                "dataPoints": [
                    _point(
                        amount,
                        dimensions + [_attr("type", token_type)],
                        session_id=session_id,
                        as_int=True,
                    )
                    for amount, token_type in zip(
                        tokens,
                        ("input", "output", "cacheRead", "cacheCreation"),
                        strict=True,
                    )
                ],
                "aggregationTemporality": temporality,
                "isMonotonic": True,
            },
        },
    ]
    if include_dropped:
        metrics.append(
            {
                "name": "claude_code.session.count",
                "description": "Count of CLI sessions started",
                "sum": {
                    "dataPoints": [
                        _point(
                            1,
                            [_attr("start_type", "startup")],
                            session_id=session_id,
                            as_int=True,
                        )
                    ],
                    "aggregationTemporality": temporality,
                    "isMonotonic": True,
                },
            }
        )

    return {
        "resourceMetrics": [
            {
                "resource": {
                    "attributes": [
                        _attr("service.name", "claude-code"),
                        _attr("service.version", "2.1.251"),
                        _attr("os.type", "darwin"),
                        _attr("os.version", "25.6.0"),
                        _attr("host.arch", "arm64"),
                        _attr("telemetry.sdk.name", "opentelemetry"),
                        _attr("telemetry.sdk.language", "nodejs"),
                        _attr("telemetry.sdk.version", "2.1.0"),
                    ],
                    "droppedAttributesCount": 0,
                },
                "scopeMetrics": [
                    {
                        "scope": {
                            "name": "com.anthropic.claude_code",
                            "version": "2.1.251",
                        },
                        "metrics": metrics,
                    }
                ],
            }
        ]
    }


async def _rows(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    async with db.execute(
        "SELECT * FROM otlp_metric_series ORDER BY metric_key, series_key"
    ) as cur:
        return [dict(row) for row in await cur.fetchall()]


async def _count(db: aiosqlite.Connection, table: str) -> int:
    async with db.execute(f"SELECT COUNT(*) AS n FROM {table}") as cur:
        row = await cur.fetchone()
    assert row is not None
    return int(row["n"])


def _post(client: TestClient, body: Any, **kwargs: Any):
    return client.post("/v1/metrics", content=json.dumps(body).encode(), **kwargs)


# ─── The happy path, against the real shape ──────────────────────────────────


async def test_real_wire_shape_is_parsed_and_stored(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """The five stored metric keys land; the dropped counter does not."""
    resp = _post(client, _wire_export())
    assert resp.status_code == 200
    body = resp.json()
    assert "partialSuccess" in body

    totals = await svc.session_totals(session_db, SESSION)
    assert totals["cost_usd"] == pytest.approx(0.0423)
    assert totals["tokens_input"] == 1200
    assert totals["tokens_output"] == 340
    assert totals["tokens_cache_read"] == 18000
    assert totals["tokens_cache_creation"] == 2400
    assert totals["model"] == MODEL
    assert totals["lane"] == svc.LANE

    # Five series stored; `claude_code.session.count` stored nothing.
    assert {row["metric_key"] for row in await _rows(session_db)} == {
        "cost_usd",
        "tokens_input",
        "tokens_output",
        "tokens_cache_read",
        "tokens_cache_creation",
    }
    stats = svc.receiver_stats()
    assert stats["points_stored"] == 5
    assert stats["rejections"][svc.REJECT_DROPPED_INSTRUMENT] == 1


async def test_as_int_arrives_as_a_json_string(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """int64 is stringified by the proto3 JSON mapping, and must still parse.

    Pinned separately from the happy path because a receiver that read
    `asInt` as a number would pass every hand-written fixture and then record
    zero tokens against every real export.
    """
    _post(client, _wire_export(tokens=(7, 0, 0, 0)))
    totals = await svc.session_totals(session_db, SESSION)
    assert totals["tokens_input"] == 7


async def test_gzip_body_is_accepted(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """`OTEL_EXPORTER_OTLP_COMPRESSION=gzip` is a supported configuration."""
    raw = gzip.compress(json.dumps(_wire_export()).encode())
    resp = client.post(
        "/v1/metrics",
        content=raw,
        headers={"content-type": "application/json", "content-encoding": "gzip"},
    )
    assert resp.status_code == 200
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] == pytest.approx(
        0.0423
    )


# ─── Temporality: the arithmetic that must not be guessed ────────────────────


async def test_cumulative_restatement_does_not_double_count(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Three identical cumulative exports are one total, not three.

    This is the bug that would make Lane B worse than the estimate it
    supersedes: at a 5-second export interval an hour-long session restates its
    total 720 times, and a receiver that summed them would report roughly 720x
    the real cost while every individual number still looked like money.
    """
    for _ in range(3):
        assert _post(client, _wire_export(cost=0.25)).status_code == 200

    totals = await svc.session_totals(session_db, SESSION)
    assert totals["cost_usd"] == pytest.approx(0.25)
    assert totals["tokens_input"] == 1200


async def test_cumulative_total_follows_the_growing_restatement(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """A cumulative series tracks the latest (largest) restatement."""
    _post(client, _wire_export(cost=0.25))
    _post(client, _wire_export(cost=0.80))
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] == pytest.approx(
        0.80
    )


async def test_cumulative_never_walks_backwards(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """A late, smaller restatement (a retried older batch) does not lower it."""
    _post(client, _wire_export(cost=0.80))
    _post(client, _wire_export(cost=0.25))
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] == pytest.approx(
        0.80
    )


async def test_delta_series_accumulate(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """With DELTA temporality the same three exports DO add up."""
    for _ in range(3):
        _post(client, _wire_export(cost=0.25, temporality=1))
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] == pytest.approx(
        0.75
    )


async def test_missing_temporality_is_treated_as_cumulative(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """The safe default: under-report rather than silently multiply.

    An unlabelled series read as delta would sum restatements. Read as
    cumulative, a genuinely-delta series is under-counted to its largest
    increment — wrong, but wrong in the direction a human notices.
    """
    body = _wire_export(cost=0.25)
    for metric in body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]:
        metric["sum"].pop("aggregationTemporality")
    _post(client, body)
    _post(client, body)
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] == pytest.approx(
        0.25
    )


async def test_distinct_series_are_summed_not_collapsed(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Two models on one session are two cumulative counters, and both count.

    The failure this pins is the subtle one: keying rows by session+metric
    alone and taking `MAX` would keep the larger model's cost and silently
    discard the other's.
    """
    _post(client, _wire_export(cost=0.60, model="claude-opus-4-5-20260514"))
    _post(client, _wire_export(cost=0.10, model="claude-haiku-4-5-20260514"))

    totals = await svc.session_totals(session_db, SESSION)
    assert totals["cost_usd"] == pytest.approx(0.70)
    # And the session is labelled with the model that spent the most.
    assert totals["model"] == "claude-opus-4-5-20260514"


# ─── The session identity join ───────────────────────────────────────────────


async def test_session_id_is_read_from_the_data_point(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """The join works with `session.id` ONLY on the data point.

    Which is where the CLI puts it. The fixture's resource block deliberately
    carries no `session.id` at all, so a receiver that looked only at the
    resource would store nothing here.
    """
    body = _wire_export()
    resource_attrs = body["resourceMetrics"][0]["resource"]["attributes"]
    assert all(a["key"] != "session.id" for a in resource_attrs)

    _post(client, body)
    assert await _count(session_db, "otlp_metric_series") == 5


async def test_session_id_on_the_resource_is_honoured_as_a_fallback(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """A user who pins it via OTEL_RESOURCE_ATTRIBUTES still joins."""
    body = _wire_export()
    for resource_metrics in body["resourceMetrics"]:
        for scope_metrics in resource_metrics["scopeMetrics"]:
            for metric in scope_metrics["metrics"]:
                for point in metric["sum"]["dataPoints"]:
                    point["attributes"] = [
                        a for a in point["attributes"] if a["key"] != "session.id"
                    ]
    body["resourceMetrics"][0]["resource"]["attributes"].append(
        _attr("session.id", SESSION)
    )

    _post(client, body)
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] == pytest.approx(
        0.0423
    )


async def test_absent_session_id_is_rejected_and_counted(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """`OTEL_METRICS_INCLUDE_SESSION_ID=false` stores nothing, loudly."""
    body = _wire_export(include_dropped=False)
    for resource_metrics in body["resourceMetrics"]:
        for scope_metrics in resource_metrics["scopeMetrics"]:
            for metric in scope_metrics["metrics"]:
                for point in metric["sum"]["dataPoints"]:
                    point["attributes"] = [
                        a for a in point["attributes"] if a["key"] != "session.id"
                    ]

    resp = _post(client, body)
    assert resp.status_code == 200
    assert await _count(session_db, "otlp_metric_series") == 0

    # Not silent: reported to the sender through the protocol's own channel…
    partial = resp.json()["partialSuccess"]
    assert partial["rejectedDataPoints"] == "5"
    assert svc.REJECT_NO_SESSION_ID in partial["errorMessage"]
    # …and counted in-process.
    assert svc.receiver_stats()["rejections"][svc.REJECT_NO_SESSION_ID] == 5


async def test_malformed_session_id_is_distinguished_from_an_absent_one(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """A wrong-typed `session.id` is its own reason, not `no-session-id`.

    The two have different fixes — one is a config flag, the other is a broken
    sender — so collapsing them would leave a user unable to tell which they
    have.
    """
    body = _wire_export(include_dropped=False)
    for resource_metrics in body["resourceMetrics"]:
        for scope_metrics in resource_metrics["scopeMetrics"]:
            for metric in scope_metrics["metrics"]:
                for point in metric["sum"]["dataPoints"]:
                    point["attributes"] = [
                        a for a in point["attributes"] if a["key"] != "session.id"
                    ] + [{"key": "session.id", "value": {"intValue": "42"}}]

    resp = _post(client, body)
    assert resp.status_code == 200
    assert await _count(session_db, "otlp_metric_series") == 0
    rejections = svc.receiver_stats()["rejections"]
    assert rejections[svc.REJECT_MALFORMED_SESSION_ID] == 5
    assert rejections[svc.REJECT_NO_SESSION_ID] == 0


async def test_array_typed_session_id_is_malformed_not_flattened(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """An `arrayValue` is not a scalar and must not be coerced into one."""
    body = _wire_export(include_dropped=False)
    for resource_metrics in body["resourceMetrics"]:
        for scope_metrics in resource_metrics["scopeMetrics"]:
            for metric in scope_metrics["metrics"]:
                for point in metric["sum"]["dataPoints"]:
                    point["attributes"] = [
                        a for a in point["attributes"] if a["key"] != "session.id"
                    ] + [
                        {
                            "key": "session.id",
                            "value": {
                                "arrayValue": {"values": [{"stringValue": SESSION}]}
                            },
                        }
                    ]

    _post(client, body)
    assert await _count(session_db, "otlp_metric_series") == 0
    # An unreadable attribute is skipped entirely, so the id reads as absent
    # rather than as a wrong-typed value — which is the honest answer: nothing
    # usable arrived under that key.
    assert svc.receiver_stats()["rejections"][svc.REJECT_NO_SESSION_ID] == 5


async def test_unknown_session_is_not_invented(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """An export naming a session we have never seen creates nothing.

    Not the series row, and — the part that matters — not the session either.
    A receiver that upserted `agent_sessions` to make the join succeed would
    let any local process mint sessions with arbitrary cost attached.
    """
    ghost = "99999999-0000-0000-0000-000000000000"
    sessions_before = await _count(session_db, "agent_sessions")

    resp = _post(client, _wire_export(session_id=ghost, include_dropped=False))
    assert resp.status_code == 200

    assert await _count(session_db, "agent_sessions") == sessions_before
    assert await _count(session_db, "otlp_metric_series") == 0
    assert svc.receiver_stats()["rejections"][svc.REJECT_UNKNOWN_SESSION] == 5
    # Traceable: the id is remembered (bounded) so "why is nothing joining"
    # has an answer that names the id rather than only a count.
    assert ghost in svc.receiver_stats()["unknown_sessions"]


async def test_one_bad_session_does_not_reject_a_good_one(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Point-level rejection is per point, not per export."""
    good = _wire_export(cost=0.5, include_dropped=False)
    ghost = _wire_export(
        cost=9.0,
        session_id="00000000-dead-4000-8000-000000000000",
        include_dropped=False,
    )
    good["resourceMetrics"].extend(ghost["resourceMetrics"])

    resp = _post(client, good)
    assert resp.status_code == 200
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] == pytest.approx(
        0.5
    )
    assert resp.json()["partialSuccess"]["rejectedDataPoints"] == "5"


# ─── Robustness: pushed input from outside ───────────────────────────────────


async def test_malformed_json_is_400_not_500(client: TestClient) -> None:
    resp = client.post(
        "/v1/metrics",
        content=b"{not json at all",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 400


async def test_non_object_body_is_400(client: TestClient) -> None:
    resp = client.post(
        "/v1/metrics",
        content=b"[1, 2, 3]",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 400


async def test_empty_body_is_accepted_and_stores_nothing(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    resp = client.post(
        "/v1/metrics", content=b"", headers={"content-type": "application/json"}
    )
    assert resp.status_code == 200
    assert await _count(session_db, "otlp_metric_series") == 0


async def test_unknown_otlp_version_is_a_no_op_not_an_error(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """A body from a shape we do not model stores nothing and does not fail.

    The parser reads only the keys it recognises, so a future envelope — or a
    logs body posted to the metrics route — yields zero observations rather
    than an exception.
    """
    resp = _post(
        client,
        {
            "otlpVersion": "2.0",
            "resourceMetricsV2": [{"anything": True}],
            "resourceLogs": [{"scopeLogs": []}],
        },
    )
    assert resp.status_code == 200
    assert resp.json()["partialSuccess"] == {}
    assert await _count(session_db, "otlp_metric_series") == 0


async def test_missing_resource_block_still_joins(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """No `resource` key at all: the join lives on the data point anyway."""
    body = _wire_export(include_dropped=False)
    del body["resourceMetrics"][0]["resource"]
    resp = _post(client, body)
    assert resp.status_code == 200
    assert await _count(session_db, "otlp_metric_series") == 5


async def test_unknown_instrument_is_rejected_not_stored(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """The table is not arbitrary key/value storage for whoever can post."""
    body = _wire_export(include_dropped=False)
    body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"] = [
        {
            "name": "attacker.invented.metric",
            "sum": {
                "dataPoints": [_point(1.0, [])],
                "aggregationTemporality": 2,
                "isMonotonic": True,
            },
        }
    ]
    resp = _post(client, body)
    assert resp.status_code == 200
    assert await _count(session_db, "otlp_metric_series") == 0
    stats = svc.receiver_stats()
    assert stats["rejections"][svc.REJECT_UNKNOWN_INSTRUMENT] == 1
    assert "attacker.invented.metric" in stats["unknown_instruments"]


async def test_unknown_token_type_is_rejected(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """`type` is a closed vocabulary; an unseen value invents no metric key."""
    body = _wire_export(include_dropped=False)
    token_metric = body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][1]
    token_metric["sum"]["dataPoints"] = [
        _point(5, [_attr("model", MODEL), _attr("type", "somethingNew")], as_int=True)
    ]
    _post(client, body)
    assert svc.receiver_stats()["rejections"][svc.REJECT_UNKNOWN_TOKEN_TYPE] == 1


async def test_gauge_shaped_instrument_is_counted_as_unsupported(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """A known instrument arriving as a gauge means the CLI changed its kind.

    Counted rather than ignored, because silent drift is how a receiver stops
    working without anyone noticing.
    """
    body = _wire_export(include_dropped=False)
    metrics = body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
    metrics[0] = {
        "name": "claude_code.cost.usage",
        "gauge": {"dataPoints": [_point(1.0, [_attr("model", MODEL)])]},
    }
    _post(client, body)
    assert await _count(session_db, "otlp_metric_series") == 4
    assert svc.receiver_stats()["rejections"][svc.REJECT_UNSUPPORTED_SHAPE] == 1


async def test_enormous_body_is_413(client: TestClient) -> None:
    oversized = b'{"resourceMetrics":[]}' + b" " * (svc.MAX_BODY_BYTES + 1)
    resp = client.post(
        "/v1/metrics", content=oversized, headers={"content-type": "application/json"}
    )
    assert resp.status_code == 413


async def test_protobuf_content_type_is_415_with_the_fix(client: TestClient) -> None:
    """The one configuration mistake worth answering in words."""
    resp = client.post(
        "/v1/metrics",
        content=b"\x00\x01\x02",
        headers={"content-type": "application/x-protobuf"},
    )
    assert resp.status_code == 415
    assert "http/json" in resp.json()["message"]


async def test_broken_gzip_is_400_not_500(client: TestClient) -> None:
    resp = client.post(
        "/v1/metrics",
        content=b"not actually gzip",
        headers={"content-type": "application/json", "content-encoding": "gzip"},
    )
    assert resp.status_code == 400


# ─── Bounds on what one export may assert ────────────────────────────────────


@pytest.mark.parametrize(
    ("cost", "reason"),
    [
        (-1.0, svc.REJECT_VALUE_OUT_OF_RANGE),
        (svc.MAX_COST_USD_PER_POINT + 1, svc.REJECT_VALUE_OUT_OF_RANGE),
    ],
)
async def test_out_of_range_cost_is_refused(
    client: TestClient, session_db: aiosqlite.Connection, cost: float, reason: str
) -> None:
    """A single point cannot assert an arbitrary amount of money, or a refund."""
    body = _wire_export(cost=cost, include_dropped=False)
    _post(client, body)
    totals = await svc.session_totals(session_db, SESSION)
    assert totals["cost_usd"] == 0.0
    assert svc.receiver_stats()["rejections"][reason] == 1


async def test_non_finite_value_is_refused(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """NaN/Infinity are valid in some JSON dialects and are not money."""
    body = _wire_export(include_dropped=False)
    body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"][0]["sum"]["dataPoints"][0][
        "asDouble"
    ] = "NaN"
    _post(client, body)
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] == 0.0
    assert svc.receiver_stats()["rejections"][svc.REJECT_BAD_VALUE] == 1


async def test_series_cap_bounds_a_hostile_attribute(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Varying an attribute per export cannot grow the table without limit.

    Sends more distinct series than the cap allows and asserts the row count
    stops at it — and that the overflow is counted, not absorbed.
    """
    cap = svc.MAX_SERIES_PER_SESSION
    # The cap is a per-session bound, not a per-request one, and since the cap
    # was raised past what fits in `MAX_BODY_BYTES` it is no longer reachable
    # inside a single export — 1 MiB of JSON runs out first. Accumulating it
    # over several posts is also the honest shape: a real session grows its
    # series set across the exporter's timer, not in one burst.
    for start in range(0, cap + 25, _CAP_BATCH):
        body = _wire_export(include_dropped=False)
        metrics = body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        metrics.pop()  # cost only, so one metric_key carries every series
        metrics[0]["sum"]["dataPoints"] = [
            _point(0.001, [_attr("model", MODEL), _attr("query_source", f"q{i}")])
            for i in range(start, min(start + _CAP_BATCH, cap + 25))
        ]
        resp = _post(client, body)
        assert resp.status_code == 200, resp.text

    assert await _count(session_db, "otlp_metric_series") == cap
    assert svc.receiver_stats()["rejections"][svc.REJECT_SERIES_CAP] == 25


async def test_series_cap_does_not_block_updates_to_existing_rows(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Once at the cap, the series already there must keep updating.

    Otherwise a session that tripped the cap would stop recording the cost of
    the models it was already using — losing real money to a defence against
    a hypothetical one.
    """
    cap = svc.MAX_SERIES_PER_SESSION
    for start in range(0, cap, _CAP_BATCH):
        body = _wire_export(include_dropped=False)
        metrics = body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
        metrics.pop()
        metrics[0]["sum"]["dataPoints"] = [
            _point(0.001, [_attr("model", MODEL), _attr("query_source", f"q{i}")])
            for i in range(start, min(start + _CAP_BATCH, cap))
        ]
        assert _post(client, body).status_code == 200
    assert await _count(session_db, "otlp_metric_series") == cap

    body = _wire_export(include_dropped=False)
    metrics = body["resourceMetrics"][0]["scopeMetrics"][0]["metrics"]
    metrics.pop()
    metrics[0]["sum"]["dataPoints"] = [
        _point(5.0, [_attr("model", MODEL), _attr("query_source", "q0")])
    ]
    _post(client, body)
    assert (await svc.session_totals(session_db, SESSION))["cost_usd"] > 5.0


# ─── Growth: the #159 regression, in a new place ─────────────────────────────


async def test_repeated_exports_do_not_grow_the_table(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Sixty pushes of the same body leave the row count where one left it.

    The exporter is a timer, not an event source. A row per push would put
    database growth on a clock, which is a worse version of the payload-blob
    problem #159 had to repair.
    """
    _post(client, _wire_export())
    after_one = await _count(session_db, "otlp_metric_series")
    assert after_one == 5

    for i in range(60):
        _post(client, _wire_export(cost=0.01 * (i + 1)))

    assert await _count(session_db, "otlp_metric_series") == after_one
    # The `points` counter is how many arrivals a series absorbed, which is the
    # bounded record of a thing that would otherwise have been 61 rows.
    rows = await _rows(session_db)
    assert all(row["points"] == 61 for row in rows if row["metric_key"] == "cost_usd")


async def test_no_request_body_is_stored_anywhere(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Nothing from the export survives except derived numbers and the model.

    In particular `user.email` and `organization.id` — which every real export
    carries — must not be anywhere in the database.
    """
    _post(client, _wire_export())
    rows = await _rows(session_db)
    blob = json.dumps(rows)
    assert "dev@example.com" not in blob
    assert "7f3c0e5e" not in blob
    assert "iTerm.app" not in blob
    # The model is the one string kept, deliberately and length-capped.
    assert MODEL in blob


# ─── Signals this receiver refuses ───────────────────────────────────────────


async def test_logs_endpoint_refuses_without_reading_the_body(
    client: TestClient,
) -> None:
    """501, with the reason, and the prompt-bearing body never parsed."""
    resp = client.post(
        "/v1/logs",
        content=b'{"resourceLogs":[{"secret":"prompt text"}]}',
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 501
    assert "prompt" in resp.json()["message"]


async def test_traces_endpoint_refuses(client: TestClient) -> None:
    resp = client.post("/v1/traces", content=b"{}")
    assert resp.status_code == 501


# ─── The instrument inventory is data, not prose ─────────────────────────────


async def test_instrument_inventory_covers_every_emitted_counter() -> None:
    """The eight counters `claude 2.1.251` emits are each stored or dropped.

    Pinned so the module docstring's table cannot drift from the code: a
    counter that is neither in `STORED_INSTRUMENTS` nor in
    `DROPPED_INSTRUMENTS` would arrive as `unknown-instrument`, which is the
    right runtime behaviour and the wrong thing to discover at runtime.

    The other ten names in the ticket's list of eighteen are span names on the
    tracing signal and are deliberately absent here — a metrics receiver cannot
    be handed a span. `claude_code.hook` is the one that matters downstream;
    see the module docstring and #178.
    """
    emitted_counters = {
        "claude_code.session.count",
        "claude_code.lines_of_code.count",
        "claude_code.pull_request.count",
        "claude_code.commit.count",
        "claude_code.cost.usage",
        "claude_code.token.usage",
        "claude_code.code_edit_tool.decision",
        "claude_code.active_time.total",
    }
    assert svc.STORED_INSTRUMENTS | svc.DROPPED_INSTRUMENTS == emitted_counters
    assert not (svc.STORED_INSTRUMENTS & svc.DROPPED_INSTRUMENTS)
    assert svc.STORED_INSTRUMENTS == {
        "claude_code.cost.usage",
        "claude_code.token.usage",
    }
    # The span-shaped names must NOT be quietly in the stored set.
    assert "claude_code.hook" not in svc.STORED_INSTRUMENTS | svc.DROPPED_INSTRUMENTS


async def test_token_type_vocabulary_matches_the_cli() -> None:
    """The four `type` values the CLI's four `add()` call sites pass."""
    assert set(svc.TOKEN_TYPE_TO_METRIC_KEY) == {
        "input",
        "output",
        "cacheRead",
        "cacheCreation",
    }


# ─── Retention ───────────────────────────────────────────────────────────────


async def test_otlp_retention_class_is_registered() -> None:
    """Lane B has a class in the one retention mechanism, on its own table."""
    by_key = {c.key: c for c in event_retention_service.RETENTION_CLASSES}
    assert "otlp" in by_key
    cls = by_key["otlp"]
    assert cls.table == "otlp_metric_series"
    assert cls.timestamp_column == "last_seen_at"
    assert cls.default_days == 90
    assert event_retention_service.default_retention_days()["otlp"] == 90


async def test_otlp_prune_deletes_only_stale_series(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """Aged on `last_seen_at`, so a long-running session's rows survive.

    A session exporting for eight hours has rows created hours ago and touched
    seconds ago. Pruning them on creation time would delete the money record of
    a session that is still spending.
    """
    _post(client, _wire_export(include_dropped=False))
    assert await _count(session_db, "otlp_metric_series") == 5

    old = (datetime.now(UTC).replace(tzinfo=None) - timedelta(days=200)).isoformat(
        timespec="seconds"
    )
    # One row looks long-dead; the rest were touched just now. Note `created_at`
    # is left old for ALL of them, which is what makes this a real test of the
    # column choice rather than of the cutoff.
    await session_db.execute("UPDATE otlp_metric_series SET created_at = ?", (old,))
    await session_db.execute(
        "UPDATE otlp_metric_series SET last_seen_at = ? WHERE metric_key = ?",
        (old, "tokens_cache_read"),
    )
    await session_db.commit()

    result = await event_retention_service.prune_agent_events(session_db)
    assert result["classes"]["otlp"]["rows_deleted"] == 1
    assert await _count(session_db, "otlp_metric_series") == 4


async def test_otlp_prune_never_deletes_sessions(
    client: TestClient, session_db: aiosqlite.Connection
) -> None:
    """The module's standing invariant holds for the new class too."""
    _post(client, _wire_export(include_dropped=False))
    old = (datetime.now(UTC).replace(tzinfo=None) - timedelta(days=200)).isoformat(
        timespec="seconds"
    )
    await session_db.execute("UPDATE otlp_metric_series SET last_seen_at = ?", (old,))
    await session_db.commit()

    await event_retention_service.prune_agent_events(session_db)
    assert await _count(session_db, "otlp_metric_series") == 0
    assert await _count(session_db, "agent_sessions") == 1


# ─── Migration 017 ───────────────────────────────────────────────────────────


async def test_migration_ships_the_table_empty(
    migrated_db: aiosqlite.Connection,
) -> None:
    """Clean-slate invariant: a freshly migrated DB has the table and no rows."""
    async with migrated_db.execute("PRAGMA table_info(otlp_metric_series)") as cur:
        columns = {row["name"] for row in await cur.fetchall()}
    assert {
        "id",
        "session_id",
        "metric_key",
        "series_key",
        "model",
        "temporality",
        "value",
        "points",
        "created_at",
        "last_seen_at",
    }.issubset(columns)
    assert await _count(migrated_db, "otlp_metric_series") == 0


async def test_series_identity_is_unique(
    migrated_db: aiosqlite.Connection,
) -> None:
    """The UNIQUE triple is what makes the upsert an upsert."""
    for _ in range(2):
        try:
            await migrated_db.execute(
                "INSERT INTO otlp_metric_series"
                " (session_id, metric_key, series_key, temporality, value)"
                " VALUES ('s', 'cost_usd', 'abc', 'cumulative', 1.0)"
            )
        except aiosqlite.IntegrityError:
            await migrated_db.rollback()
            return
    pytest.fail("duplicate (session_id, metric_key, series_key) was accepted")
