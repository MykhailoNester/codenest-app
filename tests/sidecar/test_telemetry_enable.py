"""Tests for the guided telemetry enable (#179).

The second piece of code in the sidecar that rewrites a file the user did not
hand it, and it writes the same file as the first. So this suite is weighted
the way `test_hooks_install.py` is: most of it asserts that something was left
alone, that nothing was truncated, or that the operation refused.

Five properties carry the ticket.

1. **Merge, never clobber.** An `env` entry this app did not write survives an
   enable and a disable byte for byte — including the real one on the machine
   this was written on, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, and including
   one of *our own* keys whose value the user has since edited.
2. **Idempotence.** A second enable is a no-op: byte-identical file, no second
   backup, `status: unchanged`. Same for a second disable.
3. **Disable removes only what this app added**, and is honest about what it
   could not remove.
4. **The plan cannot write.** Its own route, its own service entry point, and
   the file is untouched after it.
5. **The values are the ones the receiver can actually read.** `http/json` is
   pinned because `otlp_receiver_service` parses JSON and refuses protobuf with
   a 415; the logs signal is never enabled because that is the signal carrying
   prompt and response text. Both are asserted as facts about the authored set
   rather than left to prose.
"""

from __future__ import annotations

import json
import pathlib
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import workspace as workspace_router
from app.services import hooks_service, otlp_receiver_service, project_scanner_service
from app.services import telemetry_enable_service as tes

_BASE = "http://localhost:8002"

# The env entry this machine really has in `~/.claude/settings.json`. Used as
# the foreign key throughout, because the thing that must survive is not a
# hypothetical.
_FOREIGN_KEY = "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"
_FOREIGN_VALUE = "1"


# ─── helpers ─────────────────────────────────────────────────────────────────


def _settings_file(
    tmp_path: pathlib.Path, body: object, name: str = "claude"
) -> tuple[str, pathlib.Path]:
    config_home = tmp_path / name
    config_home.mkdir(parents=True, exist_ok=True)
    target = config_home / "settings.json"
    target.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    return str(config_home), target


def _env(target: pathlib.Path) -> dict[str, Any]:
    body = json.loads(target.read_text(encoding="utf-8"))
    env = body.get("env")
    return env if isinstance(env, dict) else {}


def _key(result: dict, direction: str, key: str) -> dict:
    return next(e for e in result[direction] if e["key"] == key)


def _backups(target: pathlib.Path) -> list[pathlib.Path]:
    return sorted(target.parent.glob(f"{target.name}.codenest-backup-*"))


# ─── the authored set itself ─────────────────────────────────────────────────


def test_the_protocol_is_pinned_to_what_the_receiver_can_parse() -> None:
    """`http/json`, and not by accident.

    `otlp_receiver_service` takes zero new dependencies precisely because it
    parses JSON with the standard library. OTLP's own default is
    `http/protobuf`, which arrives at `/v1/metrics` as bytes the receiver
    refuses with a 415 — so an enable that left this unset would look complete
    and export nothing readable.
    """
    assert tes.desired_env(_BASE)[tes.ENV_PROTOCOL] == "http/json"


def test_the_logs_signal_is_never_enabled() -> None:
    """The logs signal is the one carrying prompt and response text.

    The receiver refuses it at the door — `/v1/logs` answers 501 without
    reading the body — so this app asking the CLI to send it would be one
    module requesting what the next is built to reject. Asserted on the
    authored set so the guarantee cannot be quietly widened.
    """
    assert tes.ENV_LOGS_EXPORTER not in tes.AUTHORED_KEYS
    assert not any(k.startswith("OTEL_LOGS") for k in tes.AUTHORED_KEYS)
    assert not any(k.startswith("OTEL_TRACES") for k in tes.AUTHORED_KEYS)


def test_the_endpoint_is_the_base_url_and_the_exporter_appends_the_path() -> None:
    """Two different strings, and the screen has to show both.

    The env var holds the base; an OTLP/HTTP exporter appends `v1/metrics`
    itself, which is why `app/routers/otlp.py` mounts that route outside
    `/api/v1`.
    """
    assert tes.desired_env(_BASE)[tes.ENV_ENDPOINT] == _BASE
    assert tes.metrics_endpoint_url(_BASE) == f"{_BASE}/v1/metrics"


def test_only_stored_instruments_are_promised() -> None:
    """The enable turns on metrics, and metrics is eight counters of which the
    receiver stores two. Nothing here may imply a span-borne instrument."""
    assert otlp_receiver_service.STORED_INSTRUMENTS == {
        "claude_code.cost.usage",
        "claude_code.token.usage",
    }


# ─── authorship ──────────────────────────────────────────────────────────────


def test_a_value_we_did_not_write_is_foreign() -> None:
    assert tes.env_authorship(tes.ENV_ENABLE, "true", _BASE) == tes.AUTHORSHIP_FOREIGN
    assert (
        tes.env_authorship(tes.ENV_ENDPOINT, "http://otel.example.com:4318", _BASE)
        == tes.AUTHORSHIP_FOREIGN
    )


def test_a_loopback_alias_of_our_own_endpoint_is_current_not_stale() -> None:
    """`127.0.0.1:8002` and `localhost:8002` are one endpoint.

    Calling the alias stale would make an install rewrite itself on every run
    and never reach a fixed point — the same trap `hooks_service.hook_authorship`
    documents for the hook commands.
    """
    for alias in hooks_service.loopback_equivalents(_BASE):
        assert tes.env_authorship(tes.ENV_ENDPOINT, alias, _BASE) == (
            tes.AUTHORSHIP_CURRENT
        )


def test_a_loopback_endpoint_on_another_port_is_foreign() -> None:
    """4318 is the standard OTLP/HTTP port and may be somebody's own collector.

    Silently re-pointing that at this app is the worst thing this module could
    do, so the rule is port-exact and the cost — an enable that does not take
    effect until the user intervenes — is paid rather than avoided.
    """
    assert (
        tes.env_authorship(tes.ENV_ENDPOINT, "http://127.0.0.1:4318", _BASE)
        == tes.AUTHORSHIP_FOREIGN
    )


def test_a_non_string_value_is_foreign() -> None:
    """This app only ever writes strings, so a JSON number or bool under one of
    our keys is a shape somebody built on purpose."""
    assert tes.env_authorship(tes.ENV_ENABLE, 1, _BASE) == tes.AUTHORSHIP_FOREIGN
    assert tes.env_authorship(tes.ENV_ENABLE, True, _BASE) == tes.AUTHORSHIP_FOREIGN


# ─── merge, never clobber ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_enable_leaves_a_foreign_env_key_byte_identical(
    tmp_path: pathlib.Path,
) -> None:
    """The property the whole ticket turns on.

    This machine's own `~/.claude/settings.json` carries
    `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` and the feature it gates is live. An
    enable that disturbed it would be a worse outcome than never enabling at
    all.
    """
    config_home, target = _settings_file(
        tmp_path,
        {
            "env": {_FOREIGN_KEY: _FOREIGN_VALUE, "ANTHROPIC_API_KEY": "sk-not-real"},
            "hooks": {"SessionStart": []},
            "model": "opus",
        },
    )

    report = await tes.enable_telemetry_files([config_home], _BASE)
    assert report["overall"] == "applied"

    body = json.loads(target.read_text(encoding="utf-8"))
    assert body["env"][_FOREIGN_KEY] == _FOREIGN_VALUE
    assert body["env"]["ANTHROPIC_API_KEY"] == "sk-not-real"
    assert body["hooks"] == {"SessionStart": []}
    assert body["model"] == "opus"
    # And our five arrived.
    assert {k: body["env"][k] for k in tes.AUTHORED_KEYS} == tes.desired_env(_BASE)

    result = report["results"][0]
    assert result["left_foreign"] == 2
    assert result["state"] == tes.STATE_OFF  # the state it was found in


@pytest.mark.asyncio
async def test_enable_never_overwrites_one_of_our_own_keys_the_user_edited(
    tmp_path: pathlib.Path,
) -> None:
    """A key in our set whose value is not one we emit is not ours any more.

    It is reported as a conflict, left exactly as it is, and the reason names
    the consequence — an enable that will not take effect — rather than being
    smoothed into "already configured".
    """
    config_home, target = _settings_file(
        tmp_path, {"env": {tes.ENV_ENDPOINT: "http://otel.example.com:4318"}}
    )

    report = await tes.enable_telemetry_files([config_home], _BASE)
    result = report["results"][0]

    entry = _key(result, "enable", tes.ENV_ENDPOINT)
    assert entry["action"] == tes.ACTION_CONFLICT
    assert entry["detail"] is not None
    assert "left exactly as it is" in entry["detail"]
    # Never prints the value it found — an env block is where an API key lives.
    assert "otel.example.com" not in json.dumps(report)

    assert _env(target)[tes.ENV_ENDPOINT] == "http://otel.example.com:4318"
    assert result["state"] == tes.STATE_PARTIAL


@pytest.mark.asyncio
async def test_a_value_from_an_older_generation_is_rewritten_in_place(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The `_LEGACY_VALUES` mechanism, exercised rather than promised.

    It is empty today because there has only ever been one generation of these
    values. The day one changes, an existing install has to stay both
    repairable and removable, and that is a property of code, not of a comment.
    """
    monkeypatch.setattr(tes, "_LEGACY_VALUES", {tes.ENV_INTERVAL: ("5000",)})
    config_home, target = _settings_file(
        tmp_path, {"env": {tes.ENV_INTERVAL: "5000", _FOREIGN_KEY: _FOREIGN_VALUE}}
    )

    report = await tes.enable_telemetry_files([config_home], _BASE)
    entry = _key(report["results"][0], "enable", tes.ENV_INTERVAL)
    assert entry["action"] == tes.ACTION_UPDATE
    assert _env(target)[tes.ENV_INTERVAL] == tes.VALUE_INTERVAL_MS

    # And it is removable: the disable direction claims it before the rewrite.
    assert _env(target)[_FOREIGN_KEY] == _FOREIGN_VALUE


# ─── idempotence ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_second_enable_writes_nothing_and_takes_no_second_backup(
    tmp_path: pathlib.Path,
) -> None:
    config_home, target = _settings_file(
        tmp_path, {"env": {_FOREIGN_KEY: _FOREIGN_VALUE}}
    )

    first = await tes.enable_telemetry_files([config_home], _BASE)
    assert first["overall"] == "applied"
    assert first["results"][0]["backup_path"] is not None
    after_first = target.read_bytes()
    assert len(_backups(target)) == 1

    second = await tes.enable_telemetry_files([config_home], _BASE)
    assert second["overall"] == "unchanged"
    assert second["results"][0]["backup_path"] is None
    assert second["results"][0]["state"] == tes.STATE_ON
    assert target.read_bytes() == after_first
    assert len(_backups(target)) == 1


@pytest.mark.asyncio
async def test_a_second_disable_writes_nothing(tmp_path: pathlib.Path) -> None:
    config_home, target = _settings_file(
        tmp_path, {"env": {_FOREIGN_KEY: _FOREIGN_VALUE}}
    )
    await tes.enable_telemetry_files([config_home], _BASE)

    first = await tes.disable_telemetry_files([config_home], _BASE)
    assert first["overall"] == "applied"
    after = target.read_bytes()

    second = await tes.disable_telemetry_files([config_home], _BASE)
    assert second["overall"] == "unchanged"
    assert target.read_bytes() == after


# ─── disable ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_disable_removes_only_our_keys(tmp_path: pathlib.Path) -> None:
    config_home, target = _settings_file(
        tmp_path,
        {
            "env": {
                _FOREIGN_KEY: _FOREIGN_VALUE,
                "OTEL_RESOURCE_ATTRIBUTES": "team=platform",
            },
            "model": "opus",
        },
    )
    await tes.enable_telemetry_files([config_home], _BASE)

    report = await tes.disable_telemetry_files([config_home], _BASE)
    assert report["overall"] == "applied"

    body = json.loads(target.read_text(encoding="utf-8"))
    assert body["env"] == {
        _FOREIGN_KEY: _FOREIGN_VALUE,
        "OTEL_RESOURCE_ATTRIBUTES": "team=platform",
    }
    assert body["model"] == "opus"
    assert report["results"][0]["backup_path"] is not None


@pytest.mark.asyncio
async def test_disable_leaves_a_key_of_ours_whose_value_the_user_changed(
    tmp_path: pathlib.Path,
) -> None:
    """And says out loud that telemetry is therefore still on.

    Removing a value the user typed would be this app destroying their work on
    the way out of a screen about consent. Leaving it silently would be worse:
    the button says "off" and the CLI is still exporting.
    """
    config_home, target = _settings_file(
        tmp_path,
        {
            "env": {
                tes.ENV_ENABLE: "true",  # theirs, not ours ("1" is ours)
                tes.ENV_ENDPOINT: _BASE,  # ours
            }
        },
    )

    report = await tes.disable_telemetry_files([config_home], _BASE)

    assert _env(target) == {tes.ENV_ENABLE: "true"}
    entry = _key(report["results"][0], "disable", tes.ENV_ENABLE)
    assert entry["action"] == tes.ACTION_ABSENT
    assert entry["detail"] is not None
    assert "not removed" in entry["detail"]
    assert "Telemetry stays on" in entry["detail"]


@pytest.mark.asyncio
async def test_disable_removes_an_env_block_its_own_removals_emptied(
    tmp_path: pathlib.Path,
) -> None:
    """An `"env": {}` left behind is litter, and deleting an empty object
    destroys nothing. A block that was already empty on arrival is the user's
    and stays — asserted by the second half."""
    config_home, target = _settings_file(tmp_path, {"model": "opus"})
    await tes.enable_telemetry_files([config_home], _BASE)
    assert "env" in json.loads(target.read_text(encoding="utf-8"))

    await tes.disable_telemetry_files([config_home], _BASE)
    body = json.loads(target.read_text(encoding="utf-8"))
    assert "env" not in body
    assert body["model"] == "opus"

    # An empty block nobody of ours emptied is left alone.
    other_home, other_target = _settings_file(tmp_path, {"env": {}}, name="claude-b")
    report = await tes.disable_telemetry_files([other_home], _BASE)
    assert report["overall"] == "unchanged"
    assert json.loads(other_target.read_text(encoding="utf-8")) == {"env": {}}


@pytest.mark.asyncio
async def test_disable_never_creates_a_settings_file(tmp_path: pathlib.Path) -> None:
    """There is nothing of ours in a file that does not exist."""
    config_home = tmp_path / "claude-missing"
    config_home.mkdir()

    report = await tes.disable_telemetry_files([str(config_home)], _BASE)

    assert report["overall"] == "unchanged"
    assert not (config_home / "settings.json").exists()


# ─── keys we do not set, that change what enabling means ─────────────────────


@pytest.mark.asyncio
async def test_a_signal_specific_metrics_endpoint_is_reported_as_blocking(
    tmp_path: pathlib.Path,
) -> None:
    """It overrides the generic endpoint and is used verbatim, so the enable
    would silently export somewhere else. Named, never re-pointed."""
    config_home, _ = _settings_file(
        tmp_path,
        {"env": {tes.ENV_METRICS_ENDPOINT: "http://collector.internal/v1/metrics"}},
    )

    report = await tes.plan_telemetry_files([config_home], _BASE)
    notes = report["results"][0]["notes"]

    assert [n["key"] for n in notes] == [tes.ENV_METRICS_ENDPOINT]
    assert notes[0]["severity"] == tes.SEVERITY_BLOCKING
    assert "collector.internal" not in json.dumps(report)


@pytest.mark.asyncio
async def test_an_existing_logs_exporter_is_named(tmp_path: pathlib.Path) -> None:
    config_home, _ = _settings_file(tmp_path, {"env": {tes.ENV_LOGS_EXPORTER: "otlp"}})

    report = await tes.plan_telemetry_files([config_home], _BASE)
    note = report["results"][0]["notes"][0]

    assert note["key"] == tes.ENV_LOGS_EXPORTER
    assert note["severity"] == tes.SEVERITY_WARN
    assert "prompt and response text" in note["detail"]
    assert "501" in note["detail"]


@pytest.mark.asyncio
async def test_logs_exporter_set_to_none_is_not_flagged(
    tmp_path: pathlib.Path,
) -> None:
    config_home, _ = _settings_file(tmp_path, {"env": {tes.ENV_LOGS_EXPORTER: "none"}})
    report = await tes.plan_telemetry_files([config_home], _BASE)
    assert report["results"][0]["notes"] == []


@pytest.mark.asyncio
async def test_session_id_switched_off_is_reported_as_blocking(
    tmp_path: pathlib.Path,
) -> None:
    """The receiver joins on `session.id` and refuses a point it cannot join,
    so every export would arrive and be rejected in full."""
    config_home, _ = _settings_file(
        tmp_path, {"env": {tes.ENV_INCLUDE_SESSION_ID: "false"}}
    )

    report = await tes.plan_telemetry_files([config_home], _BASE)
    note = report["results"][0]["notes"][0]

    assert note["key"] == tes.ENV_INCLUDE_SESSION_ID
    assert note["severity"] == tes.SEVERITY_BLOCKING


# ─── refusal ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_env_key_that_is_not_an_object_is_refused_whole(
    tmp_path: pathlib.Path,
) -> None:
    """Refuse rather than reshape. A non-object `env` is a structure somebody
    built on purpose or a file that is not a settings.json; replacing it would
    be a guess."""
    config_home, target = _settings_file(tmp_path, {"env": ["PATH=/usr/bin"]})
    before = target.read_bytes()

    report = await tes.enable_telemetry_files([config_home], _BASE)

    result = report["results"][0]
    assert result["status"] == "refused"
    assert (
        result["refusal"] is not None
        and '"env" key must be an object' in (result["refusal"])
    )
    assert target.read_bytes() == before


@pytest.mark.asyncio
async def test_unparseable_json_is_refused_and_not_rewritten(
    tmp_path: pathlib.Path,
) -> None:
    config_home = tmp_path / "claude-broken"
    config_home.mkdir()
    target = config_home / "settings.json"
    target.write_text("{oops", encoding="utf-8")

    report = await tes.enable_telemetry_files([str(config_home)], _BASE)

    assert report["results"][0]["status"] == "refused"
    assert target.read_text(encoding="utf-8") == "{oops"


@pytest.mark.asyncio
async def test_a_path_outside_the_allowed_roots_is_refused(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The containment policy is inherited, not re-implemented: this module
    calls `hooks_service.resolve_write_target`, which is the #170 check."""
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "settings.json").write_text('{"keep": true}', encoding="utf-8")
    monkeypatch.setattr(
        project_scanner_service, "_allowed_scan_roots", lambda: (allowed.resolve(),)
    )

    report = await tes.enable_telemetry_files([str(outside)], _BASE)

    assert report["results"][0]["status"] == "refused"
    assert (outside / "settings.json").read_text(encoding="utf-8") == '{"keep": true}'


# ─── the write itself ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_enable_creates_a_missing_settings_file_with_only_our_keys(
    tmp_path: pathlib.Path,
) -> None:
    config_home = tmp_path / "claude-fresh"
    config_home.mkdir()

    report = await tes.enable_telemetry_files([str(config_home)], _BASE)
    result = report["results"][0]

    assert result["status"] == "applied"
    assert result["created_file"] is True
    # No file existed, so there was nothing to copy.
    assert result["backup_path"] is None
    body = json.loads((config_home / "settings.json").read_text(encoding="utf-8"))
    assert body == {"env": tes.desired_env(_BASE)}


@pytest.mark.asyncio
async def test_the_backup_holds_the_previous_content_verbatim(
    tmp_path: pathlib.Path,
) -> None:
    config_home, target = _settings_file(
        tmp_path, {"env": {_FOREIGN_KEY: _FOREIGN_VALUE}}
    )
    before = target.read_bytes()

    report = await tes.enable_telemetry_files([config_home], _BASE)

    backup = pathlib.Path(report["results"][0]["backup_path"])
    assert backup.read_bytes() == before
    assert backup.parent == target.parent


# ─── routes ──────────────────────────────────────────────────────────────────


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(workspace_router.router)
    return TestClient(app)


def test_plan_route_cannot_write(client: TestClient, tmp_path: pathlib.Path) -> None:
    """The dry run is its own URL rather than a flag on the writer, so the call
    that cannot write is not one deserialisation bug away from the one that
    can. Proved against a file whose enable would otherwise change it."""
    config_home, target = _settings_file(
        tmp_path, {"env": {_FOREIGN_KEY: _FOREIGN_VALUE}}
    )
    before = target.read_bytes()

    resp = client.post(
        "/api/v1/workspace/telemetry/plan", json={"config_homes": [config_home]}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["dry_run"] is True
    assert body["mode"] == "plan"
    assert body["overall"] == "planned"
    assert target.read_bytes() == before
    assert _backups(target) == []


def test_plan_route_reports_both_directions(
    client: TestClient, tmp_path: pathlib.Path
) -> None:
    """One read, both answers. The screen renders "this is what turning it on
    writes" and "this is what turning it off removes" at the same moment."""
    config_home, _ = _settings_file(tmp_path, {"env": {tes.ENV_ENABLE: "1"}})

    result = client.post(
        "/api/v1/workspace/telemetry/plan", json={"config_homes": [config_home]}
    ).json()["results"][0]

    assert _key(result, "enable", tes.ENV_ENABLE)["action"] == tes.ACTION_OK
    assert _key(result, "enable", tes.ENV_ENDPOINT)["action"] == tes.ACTION_ADD
    assert _key(result, "disable", tes.ENV_ENABLE)["action"] == tes.ACTION_REMOVE
    assert _key(result, "disable", tes.ENV_ENDPOINT)["action"] == tes.ACTION_ABSENT
    assert result["state"] == tes.STATE_PARTIAL


def test_enable_then_disable_round_trips_to_the_original_bytes(
    client: TestClient, tmp_path: pathlib.Path
) -> None:
    """The strongest statement the disable path can make: a file that went
    through both ends up as the file it started as."""
    config_home, target = _settings_file(
        tmp_path,
        {"env": {_FOREIGN_KEY: _FOREIGN_VALUE}, "model": "opus"},
    )
    original = json.loads(target.read_text(encoding="utf-8"))

    client.post(
        "/api/v1/workspace/telemetry/enable", json={"config_homes": [config_home]}
    )
    client.post(
        "/api/v1/workspace/telemetry/disable", json={"config_homes": [config_home]}
    )

    assert json.loads(target.read_text(encoding="utf-8")) == original


def test_routes_answer_200_on_a_broken_settings_file(
    client: TestClient, tmp_path: pathlib.Path
) -> None:
    """A refusal is data, not an HTTP error — the contract every hook route
    keeps, so a 500 stays distinguishable from a user's bad file."""
    config_home = tmp_path / "claude-broken"
    config_home.mkdir()
    (config_home / "settings.json").write_text("{oops", encoding="utf-8")

    for route in ("plan", "enable", "disable"):
        resp = client.post(
            f"/api/v1/workspace/telemetry/{route}",
            json={"config_homes": [str(config_home)]},
        )
        assert resp.status_code == 200
        assert resp.json()["results"][0]["status"] == "refused"


def test_no_config_homes_is_a_no_op(client: TestClient) -> None:
    resp = client.post("/api/v1/workspace/telemetry/enable", json={"config_homes": []})
    assert resp.status_code == 200
    body = resp.json()
    assert body["overall"] == "unchanged"
    assert body["results"] == []
