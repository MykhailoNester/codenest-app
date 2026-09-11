"""Tests for the plan-usage reader and `GET /api/v1/agents/plan-usage` (#164).

The interesting assertions here are the honesty ones. `fh` and `sd` are
undocumented counters, so the tests pin what the reader is *not* allowed to say:
no unit, no limit, no percentage anywhere in the serialized payload, and observed
bounds computed from the file rather than copied out of a ticket. The rest covers
the degradation matrix — missing, unreadable, malformed, oversize, wrong version,
empty — each of which must come back as a well-formed 200 payload.
"""

from __future__ import annotations

import json
import pathlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import agents as agents_router
from app.services import plan_usage_service

# Every token that would assert a unit, a ceiling, or a proportion we cannot
# actually derive from the file. "window" is deliberately absent: the two labels
# are "rolling short window" / "rolling long window", which describes the shape
# of the measurement without claiming its size.
FORBIDDEN_TOKENS = (
    "hours",
    "days",
    "five_hour",
    "weekly",
    "pct",
    "remaining",
    "limit",
)

MINUTE_MS = 60 * 1000


@pytest.fixture
def history_file(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch):
    """Point the reader at a fixture file and hand back a writer for it.

    The file is *not* created here — several tests need the absent case, which is
    the whole point of `available: false`.
    """
    path = tmp_path / "plan-usage-history.json"
    monkeypatch.setenv(plan_usage_service.PATH_ENV_VAR, str(path))

    def write(content: object) -> pathlib.Path:
        path.write_text(
            content if isinstance(content, str) else json.dumps(content),
            encoding="utf-8",
        )
        return path

    return write


@pytest.fixture
def client() -> TestClient:
    """A FastAPI app carrying only the agents router.

    The plan-usage route touches no database, so nothing here needs `migrated_db`.
    """
    application = FastAPI()
    application.include_router(agents_router.router)
    return TestClient(application, raise_server_exceptions=True)


def _sample(stamp: int, fh: float, sd: float, org: str = "org-a") -> dict:
    return {"t": stamp, "org": org, "u": {"fh": fh, "sd": sd}}


def _history(samples: list[dict], version: int = 2) -> dict:
    return {"version": version, "samples": samples}


# ---------------------------------------------------------------------------
# The honesty constraints
# ---------------------------------------------------------------------------


def test_labels_are_the_two_agreed_strings_and_nothing_else(history_file) -> None:
    history_file(
        _history(
            [
                _sample(1_788_162_117_147, 5, 23),
                _sample(1_788_163_017_147, 6, 24),
            ]
        )
    )
    payload = plan_usage_service.read_plan_usage()

    assert [s["key"] for s in payload["series"]] == ["fh", "sd"]
    assert [s["label"] for s in payload["series"]] == [
        "rolling short window",
        "rolling long window",
    ]


@pytest.mark.parametrize(
    "content",
    [
        pytest.param(
            _history(
                [
                    _sample(1_788_162_117_147, 5, 23),
                    _sample(1_788_163_017_147, 43, 36),
                ]
            ),
            id="healthy",
        ),
        pytest.param(_history([], version=7), id="unsupported-version"),
        pytest.param(_history([]), id="empty-samples"),
        pytest.param("not json at all", id="unreadable"),
        pytest.param([1, 2, 3], id="not-an-object"),
    ],
)
def test_serialized_payload_carries_no_forbidden_token(history_file, content) -> None:
    """Grep the whole serialized payload — keys, labels, reasons and all.

    Run across the degraded states too, because a hastily worded `reason` is the
    likeliest place for a unit to sneak back in.
    """
    history_file(content)
    blob = json.dumps(plan_usage_service.read_plan_usage()).lower()

    for token in FORBIDDEN_TOKENS:
        assert token not in blob, f"payload leaked the token {token!r}"


def test_the_word_window_is_permitted(history_file) -> None:
    history_file(_history([_sample(1_788_162_117_147, 5, 23)]))
    blob = json.dumps(plan_usage_service.read_plan_usage())

    assert "window" in blob


def test_missing_payload_also_carries_no_forbidden_token(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        plan_usage_service.PATH_ENV_VAR, str(tmp_path / "nothing-here.json")
    )
    blob = json.dumps(plan_usage_service.read_plan_usage()).lower()

    for token in FORBIDDEN_TOKENS:
        assert token not in blob


# ---------------------------------------------------------------------------
# Observed ranges are computed, never hardcoded
# ---------------------------------------------------------------------------


def test_observed_bounds_come_from_the_file(history_file) -> None:
    """The ticket quoted 0–43 and 0–36; the real file had already moved to 0–64
    and 0–46 a day later. So the fixture uses values that match neither, and the
    reader must report exactly what it was given."""
    history_file(
        _history(
            [
                _sample(1_788_162_117_147, 7, 91),
                _sample(1_788_163_017_147, 12, 55),
                _sample(1_788_163_917_147, 3, 88),
            ]
        )
    )
    short, long = plan_usage_service.read_plan_usage()["series"]

    assert (short["observed_min"], short["observed_max"]) == (3, 12)
    assert (long["observed_min"], long["observed_max"]) == (55, 91)


def test_latest_is_the_newest_sample_after_sorting(history_file) -> None:
    """Samples arrive in append order, but the reader sorts before deciding what
    "latest" means — an out-of-order append must not rewrite the present."""
    history_file(
        _history(
            [
                _sample(1_788_163_917_147, 3, 88),
                _sample(1_788_162_117_147, 7, 91),
            ]
        )
    )
    payload = plan_usage_service.read_plan_usage()
    short, long = payload["series"]

    assert (short["latest"], long["latest"]) == (3, 88)
    assert payload["first_sample_at"] == 1_788_162_117_147
    assert payload["last_sample_at"] == 1_788_163_917_147


def test_a_series_the_file_never_recorded_is_null_not_zero(history_file) -> None:
    """Zero is a value these counters genuinely take, so "we have no reading" has
    to be distinguishable from "the reading is 0"."""
    history_file({"version": 2, "samples": [{"t": 1_788_162_117_147, "u": {"sd": 4}}]})
    short, long = plan_usage_service.read_plan_usage()["series"]

    assert (short["latest"], short["observed_min"], short["observed_max"]) == (
        None,
        None,
        None,
    )
    assert long["latest"] == 4


def test_booleans_are_not_read_as_numbers(history_file) -> None:
    history_file(
        {
            "version": 2,
            "samples": [
                {"t": 1_788_162_117_147, "u": {"fh": True, "sd": 0}},
                {"t": 1_788_163_017_147, "u": {"fh": 9, "sd": 0}},
            ],
        }
    )
    short, long = plan_usage_service.read_plan_usage()["series"]

    assert (short["observed_min"], short["observed_max"]) == (9, 9)
    assert (long["observed_min"], long["observed_max"]) == (0, 0)


# ---------------------------------------------------------------------------
# Cadence / staleness
# ---------------------------------------------------------------------------


def test_max_gap_seconds_reports_the_widest_hole(history_file) -> None:
    base = 1_788_162_117_147
    history_file(
        _history(
            [
                _sample(base, 1, 1),
                _sample(base + 15 * MINUTE_MS, 2, 2),
                _sample(base + 90 * MINUTE_MS, 3, 3),
                _sample(base + 105 * MINUTE_MS, 4, 4),
            ]
        )
    )
    payload = plan_usage_service.read_plan_usage()

    assert payload["max_gap_seconds"] == 75 * 60
    assert payload["sample_count"] == 4


def test_a_single_sample_reports_no_gap(history_file) -> None:
    """One sample implies no interval; 0 would read as a perfectly fresh file."""
    history_file(_history([_sample(1_788_162_117_147, 5, 23)]))

    assert plan_usage_service.read_plan_usage()["max_gap_seconds"] is None


def test_unparseable_samples_are_dropped(history_file) -> None:
    history_file(
        {
            "version": 2,
            "samples": [
                _sample(1_788_162_117_147, 5, 23),
                "not a sample",
                {"u": {"fh": 1, "sd": 2}},
                {"t": "not a stamp", "u": {"fh": 1, "sd": 2}},
                _sample(1_788_163_017_147, 6, 24),
            ],
        }
    )
    payload = plan_usage_service.read_plan_usage()

    assert payload["sample_count"] == 2
    assert payload["samples"] == [
        {"t": 1_788_162_117_147, "fh": 5, "sd": 23},
        {"t": 1_788_163_017_147, "fh": 6, "sd": 24},
    ]


def test_distinct_orgs_are_counted_not_exposed(history_file) -> None:
    history_file(
        _history(
            [
                _sample(1_788_162_117_147, 5, 23, org="org-a"),
                _sample(1_788_163_017_147, 6, 24, org="org-b"),
                _sample(1_788_163_917_147, 7, 25, org="org-a"),
            ]
        )
    )
    payload = plan_usage_service.read_plan_usage()

    assert payload["org_count"] == 2
    assert "org-a" not in json.dumps(payload)


def test_returned_samples_are_capped_to_the_recent_tail(
    history_file, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plan_usage_service, "MAX_RETURNED_SAMPLES", 3)
    base = 1_788_162_117_147
    history_file(
        _history([_sample(base + i * 15 * MINUTE_MS, i, i) for i in range(10)])
    )
    payload = plan_usage_service.read_plan_usage()

    # The tail bounds the response only — the counts and the observed bounds
    # still describe every sample in the file.
    assert len(payload["samples"]) == 3
    assert payload["sample_count"] == 10
    assert payload["series"][0]["observed_min"] == 0
    assert payload["samples"][-1]["t"] == base + 9 * 15 * MINUTE_MS


# ---------------------------------------------------------------------------
# Degradation matrix
# ---------------------------------------------------------------------------


def test_missing_file_is_unavailable_and_not_an_error(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        plan_usage_service.PATH_ENV_VAR, str(tmp_path / "never-installed.json")
    )
    payload = plan_usage_service.read_plan_usage()

    assert payload["available"] is False
    assert payload["reason"] == "missing"
    assert payload["series"] == []
    assert payload["samples"] == []


def test_unsupported_version_refuses_to_guess(history_file) -> None:
    history_file(_history([_sample(1_788_162_117_147, 5, 23)], version=3))
    payload = plan_usage_service.read_plan_usage()

    assert payload["available"] is True
    assert payload["supported"] is False
    assert payload["version"] == 3
    assert payload["reason"] == "unsupported_version"
    # Nothing is read out of a shape we have never verified.
    assert payload["series"] == []
    assert payload["samples"] == []


def test_absent_version_is_unsupported(history_file) -> None:
    history_file({"samples": [_sample(1_788_162_117_147, 5, 23)]})
    payload = plan_usage_service.read_plan_usage()

    assert payload["supported"] is False
    assert payload["version"] is None


def test_unreadable_file_degrades(history_file) -> None:
    history_file("{ this is not json")
    payload = plan_usage_service.read_plan_usage()

    assert payload["available"] is False
    assert payload["reason"] == "unreadable"


def test_non_object_root_is_malformed(history_file) -> None:
    history_file([{"t": 1}])
    payload = plan_usage_service.read_plan_usage()

    assert payload["available"] is False
    assert payload["reason"] == "malformed"


def test_oversize_file_is_refused_unread(
    history_file, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(plan_usage_service, "MAX_FILE_BYTES", 16)
    history_file(_history([_sample(1_788_162_117_147, 5, 23)]))
    payload = plan_usage_service.read_plan_usage()

    assert payload["available"] is False
    assert payload["reason"] == "oversize"


def test_supported_but_empty_file_is_available(history_file) -> None:
    history_file(_history([]))
    payload = plan_usage_service.read_plan_usage()

    assert payload["available"] is True
    assert payload["supported"] is True
    assert payload["reason"] == "no_samples"
    assert payload["sample_count"] == 0


def test_every_state_returns_the_same_key_set(history_file) -> None:
    """The frontend types are total; a degraded payload may not drop keys."""
    history_file(_history([_sample(1_788_162_117_147, 5, 23)]))
    healthy = set(plan_usage_service.read_plan_usage())

    for content in (_history([], version=9), _history([]), "nonsense", [1]):
        history_file(content)
        assert set(plan_usage_service.read_plan_usage()) == healthy


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


def test_route_returns_the_parsed_payload(client: TestClient, history_file) -> None:
    history_file(
        _history(
            [
                _sample(1_788_162_117_147, 5, 23),
                _sample(1_788_163_017_147, 6, 24),
            ]
        )
    )
    response = client.get("/api/v1/agents/plan-usage")

    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    assert body["supported"] is True
    assert body["sample_count"] == 2
    assert body["series"][0]["label"] == "rolling short window"


def test_route_is_200_when_the_file_is_missing(
    client: TestClient, tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(
        plan_usage_service.PATH_ENV_VAR, str(tmp_path / "never-installed.json")
    )
    response = client.get("/api/v1/agents/plan-usage")

    assert response.status_code == 200
    assert response.json()["available"] is False


def test_route_is_not_swallowed_by_the_agent_name_routes(
    client: TestClient, history_file
) -> None:
    """The literal segment stays reachable, and stays reachable for a reason.

    The original version of this test asserted only that the route answers 200,
    which it would have done with the route registered anywhere — `agents.py`
    has no single-segment `/api/v1/agents/{name}` route, so there is nothing for
    `plan-usage` to collide with and the test could not fail. That made it a
    duplicate of `test_route_returns_the_parsed_payload` wearing a guard's name.

    What actually needs pinning is the premise: if a bare `/{name}` route is
    ever added ahead of this one, the literal path starts resolving to it and
    this endpoint silently becomes unreachable. So assert the premise directly,
    against the live routing table, rather than asserting a 200 that proves
    nothing.
    """
    paths = [getattr(route, "path", "") for route in agents_router.router.routes]
    literal = "/api/v1/agents/plan-usage"
    assert literal in paths

    # No single-segment parameterised sibling exists at all...
    assert "/api/v1/agents/{name}" not in paths
    # ...and if one is ever added, it must not precede the literal path.
    single_segment_param = [
        p
        for p in paths
        if p.startswith("/api/v1/agents/{") and p.count("/") == literal.count("/")
    ]
    for p in single_segment_param:
        assert paths.index(literal) < paths.index(p), (
            f"{p} is registered before {literal} and would swallow it"
        )

    history_file(_history([_sample(1_788_162_117_147, 5, 23)]))
    response = client.get(literal)
    assert response.status_code == 200
    assert "series" in response.json()


def test_non_finite_counter_does_not_break_serialization(
    client: TestClient, history_file
) -> None:
    """A NaN in the file must degrade, not 500.

    `json.loads` accepts the bare `NaN` / `Infinity` literals, but Starlette
    renders with `json.dumps(allow_nan=False)` — so a non-finite value that got
    through would raise at serialization time, after the service had already
    returned, and the route would answer 500. That contradicts the module's
    whole contract: every malformed input degrades at HTTP 200.
    """
    history_file(
        '{"version": 2, "samples": [{"t": 1788162117147, "org": "o",'
        ' "u": {"fh": NaN, "sd": Infinity}}]}'
    )
    response = client.get("/api/v1/agents/plan-usage")

    assert response.status_code == 200
    body = response.json()
    # The sample parsed; the two unusable counters were dropped rather than
    # carried through to a serializer that cannot express them.
    for series in body["series"]:
        assert series["latest"] is None
        assert series["observed_min"] is None
        assert series["observed_max"] is None


def test_deeply_nested_json_reports_unreadable_rather_than_raising(
    client: TestClient, history_file
) -> None:
    """`json.loads` raises RecursionError — not ValueError — on deep nesting.

    It is a shape a corrupt file genuinely takes, and it is exactly what the
    module's "never raises" promise has to cover. Without RecursionError in the
    caught set the route 500s instead of reporting `unreadable`.
    """
    history_file("[" * 200_000)
    response = client.get("/api/v1/agents/plan-usage")

    assert response.status_code == 200
    body = response.json()
    assert body["available"] is False
    assert body["reason"] == "unreadable"
