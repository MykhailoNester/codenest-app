"""Tests for hook-setup guidance + inbound-ping verification (Command Center)."""

from __future__ import annotations

import json
import pathlib

import aiosqlite
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.database as db_module
from app.routers import workspace as workspace_router
from app.services import hooks_service


@pytest.fixture(autouse=True)
def _clear_self_test_tokens() -> None:
    """`hooks_service._self_tests` is a module-level OrderedDict shared across
    the whole test session — isolate each test's use of it so, e.g., the
    eviction test's 17 mints never bleed into an unrelated test."""
    hooks_service._self_tests.clear()


def test_build_hook_settings_covers_all_events() -> None:
    """The snippet offers every registered event, both tiers (#168).

    Exhaustive coverage of the 22 — and the `--max-time` / `|| true`
    discipline on each — lives in `test_hook_event_registry.py`; this keeps
    asserting the block's *shape* against one core event whose path predates
    the `/event/` namespace and must never move.
    """
    block = hooks_service.build_hook_settings("http://127.0.0.1:8002")
    hooks = block["hooks"]
    assert set(hooks) == {spec.event for spec in hooks_service.HOOK_EVENTS}
    assert {
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SessionEnd",
    } <= set(hooks)
    entry = hooks["PostToolUse"][0]
    # Each event has a wildcard matcher so every session is captured.
    assert entry["matcher"] == "*"
    hook = entry["hooks"][0]
    assert hook["type"] == "command"
    assert "http://127.0.0.1:8002/api/v1/hooks/post-tool" in hook["command"]
    assert hook["timeout"] == 6


def test_session_start_uses_command_type() -> None:
    block = hooks_service.build_hook_settings("http://127.0.0.1:8002")
    entry = block["hooks"]["SessionStart"][0]
    hook = entry["hooks"][0]
    assert hook["type"] == "command"
    cmd = hook["command"]
    assert "http://127.0.0.1:8002/api/v1/hooks/session-start" in cmd
    # `|| true` makes curl no-op when the app is offline (no ECONNREFUSED noise).
    assert cmd.strip().endswith("|| true")
    # curl must read the hook payload from stdin and time out under the hook budget.
    assert "--data-binary @-" in cmd
    assert "--max-time 5" in cmd
    assert hook["timeout"] == 6
    assert entry["matcher"] == "*"


def test_build_hook_settings_strips_trailing_slash() -> None:
    block = hooks_service.build_hook_settings("http://host:9000/")
    hook = block["hooks"]["Stop"][0]["hooks"][0]
    assert "http://host:9000/api/v1/hooks/stop" in hook["command"]
    assert "http://host:9000//api" not in hook["command"]


def test_settings_json_path() -> None:
    assert hooks_service.settings_json_path("~/.claude-alt").endswith(
        "/.claude-alt/settings.json"
    )
    # Default config home when none provided.
    assert hooks_service.settings_json_path(None).endswith("/.claude/settings.json")
    assert hooks_service.settings_json_path("   ").endswith("/.claude/settings.json")


def test_sidecar_base_url_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CODENEST_SIDECAR_URL", raising=False)
    assert hooks_service.sidecar_base_url() == "http://localhost:8002"
    monkeypatch.setenv("CODENEST_SIDECAR_URL", "http://127.0.0.1:9999/")
    assert hooks_service.sidecar_base_url() == "http://127.0.0.1:9999"


@pytest.mark.asyncio
async def test_hooks_status_empty_then_connected(
    migrated_db: aiosqlite.Connection,
) -> None:
    status = await hooks_service.hooks_status(migrated_db)
    assert status["connected"] is False and status["sessions"] == 0

    await migrated_db.execute(
        "INSERT INTO agent_sessions "
        "(session_id, profile, status, started_at, last_event_at) "
        "VALUES ('s1', 'unknown', 'active', datetime('now'), datetime('now'))"
    )
    await migrated_db.commit()

    status = await hooks_service.hooks_status(migrated_db)
    assert status["connected"] is True
    assert status["sessions"] == 1
    assert status["last_ping_at"] is not None


@pytest.mark.asyncio
async def test_hooks_status_since_requires_fresh_ping(
    migrated_db: aiosqlite.Connection,
) -> None:
    await migrated_db.execute(
        "INSERT INTO agent_sessions "
        "(session_id, profile, status, started_at, last_event_at) "
        "VALUES ('s1', 'unknown', 'active', datetime('now'), datetime('now'))"
    )
    await migrated_db.commit()
    # A future baseline: the historical session is older, so NOT connected.
    future = await hooks_service.hooks_status(migrated_db, since="2999-01-01 00:00:00")
    assert future["connected"] is False
    # A past baseline: a newer event exists, so connected.
    past = await hooks_service.hooks_status(migrated_db, since="2000-01-01 00:00:00")
    assert past["connected"] is True


def test_module_default_base_url_uses_localhost(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Default URL must use localhost (not 127.0.0.1) — matches real user
    # settings.json files and avoids IPv6 resolution surprises.
    monkeypatch.delenv("CODENEST_SIDECAR_URL", raising=False)
    assert "localhost" in hooks_service._DEFAULT_BASE_URL
    assert "8002" in hooks_service._DEFAULT_BASE_URL
    assert hooks_service.sidecar_base_url() == "http://localhost:8002"


# ─── classify_settings_hooks: pure diff logic ────────────────────────────────

_BASE = "http://localhost:8002"


def test_classify_settings_hooks_all_present() -> None:
    block = hooks_service.build_hook_settings(_BASE)
    file_status, events, detail = hooks_service.classify_settings_hooks(block, _BASE)
    assert file_status == "ok"
    assert detail is None
    assert [e["status"] for e in events] == ["ok"] * 6


def test_classify_settings_hooks_absent_when_no_hooks_key() -> None:
    file_status, events, detail = hooks_service.classify_settings_hooks(
        {"env": {"FOO": "bar"}}, _BASE
    )
    assert file_status == "absent"
    assert detail is not None and "hooks" in detail
    assert all(e["status"] == "missing" for e in events)


def test_classify_settings_hooks_absent_when_hooks_is_a_list() -> None:
    file_status, events, detail = hooks_service.classify_settings_hooks(
        {"hooks": []}, _BASE
    )
    assert file_status == "absent"
    assert detail is not None and "object" in detail
    assert all(e["status"] == "missing" for e in events)


def test_classify_settings_hooks_partial_when_one_event_missing() -> None:
    block = hooks_service.build_hook_settings(_BASE)
    del block["hooks"]["Stop"]
    file_status, events, _detail = hooks_service.classify_settings_hooks(block, _BASE)
    assert file_status == "partial"
    by_event = {e["event"]: e["status"] for e in events}
    assert by_event["Stop"] == "missing"
    assert all(status == "ok" for event, status in by_event.items() if event != "Stop")


def test_classify_settings_hooks_mismatch_on_wrong_port() -> None:
    stale_block = hooks_service.build_hook_settings("http://localhost:9999")
    _file_status, events, _detail = hooks_service.classify_settings_hooks(
        stale_block, _BASE
    )
    # A stale port is a mismatch (pasted, but stale) — never "missing" (not
    # pasted). The detail names the base URL that was actually found.
    assert all(e["status"] == "mismatch" for e in events)
    assert all(e["detail"] is not None and "9999" in e["detail"] for e in events)
    assert all(_BASE in (e["detail"] or "") for e in events)


def test_classify_settings_hooks_ok_for_equivalent_loopback_host() -> None:
    # Built with 127.0.0.1, verified against the sidecar's own "localhost" —
    # a working hand-wired paste must not be reported as stale.
    block = hooks_service.build_hook_settings("http://127.0.0.1:8002")
    file_status, events, _detail = hooks_service.classify_settings_hooks(block, _BASE)
    assert file_status == "ok"
    assert all(e["status"] == "ok" for e in events)


def test_classify_settings_hooks_mismatch_on_legacy_http_type() -> None:
    block = {
        "hooks": {
            "SessionStart": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "http",
                            "url": f"{_BASE}/api/v1/hooks/session-start",
                        }
                    ],
                }
            ]
        }
    }
    _file_status, events, _detail = hooks_service.classify_settings_hooks(block, _BASE)
    session_start = next(e for e in events if e["event"] == "SessionStart")
    assert session_start["status"] == "mismatch"
    assert session_start["detail"] is not None and "http" in session_start["detail"]


def test_classify_settings_hooks_mismatch_on_narrow_matcher() -> None:
    real_command = hooks_service.build_hook_settings(_BASE)["hooks"]["SessionStart"][0][
        "hooks"
    ][0]["command"]
    block = {
        "hooks": {
            "SessionStart": [
                {
                    "matcher": "Bash",
                    "hooks": [{"type": "command", "command": real_command}],
                }
            ]
        }
    }
    _file_status, events, _detail = hooks_service.classify_settings_hooks(block, _BASE)
    session_start = next(e for e in events if e["event"] == "SessionStart")
    assert session_start["status"] == "mismatch"
    assert session_start["detail"] is not None and "Bash" in session_start["detail"]


def test_classify_settings_hooks_malformed_when_entry_not_wrapped() -> None:
    real_command = hooks_service.build_hook_settings(_BASE)["hooks"]["Stop"][0][
        "hooks"
    ][0]["command"]
    # A flat hook dict directly in the event array — not wrapped in
    # {matcher, hooks[]}.
    block = {"hooks": {"Stop": [{"type": "command", "command": real_command}]}}
    _file_status, events, _detail = hooks_service.classify_settings_hooks(block, _BASE)
    stop = next(e for e in events if e["event"] == "Stop")
    assert stop["status"] == "malformed"
    assert stop["detail"] is not None and "wrapped" in stop["detail"]


def test_classify_settings_hooks_ok_with_unrelated_extra_hooks() -> None:
    block = hooks_service.build_hook_settings(_BASE)
    block["hooks"]["PreToolUse"].append(
        {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo hi"}]}
    )
    file_status, events, _detail = hooks_service.classify_settings_hooks(block, _BASE)
    assert file_status == "ok"
    assert all(e["status"] == "ok" for e in events)


def test_command_match_is_endpoint_boundary_aware() -> None:
    block = {
        "hooks": {
            "Stop": [
                {
                    "matcher": "*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f"curl ... {_BASE}/api/v1/hooks/stop-foo ...",
                        }
                    ],
                }
            ]
        }
    }
    _file_status, events, _detail = hooks_service.classify_settings_hooks(block, _BASE)
    stop = next(e for e in events if e["event"] == "Stop")
    # /api/v1/hooks/stop-foo must NOT satisfy the Stop event's /hooks/stop.
    assert stop["status"] == "missing"


# ─── verify_settings_files: filesystem layer ─────────────────────────────────


@pytest.mark.asyncio
async def test_verify_settings_files_missing_file(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    config_home = str(tmp_path / "claude-fresh")
    report = await hooks_service.verify_settings_files([config_home])
    assert report["overall"] == "absent"
    assert report["results"][0]["file_status"] == "missing_file"
    assert report["results"][0]["found_elsewhere"] == []


@pytest.mark.asyncio
async def test_verify_settings_files_invalid_json(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / "claude-bad-json"
    config_dir.mkdir()
    (config_dir / "settings.json").write_text("{not valid json", encoding="utf-8")

    report = await hooks_service.verify_settings_files([str(config_dir)])
    assert report["overall"] == "error"
    assert report["results"][0]["file_status"] == "invalid_json"


@pytest.mark.asyncio
async def test_verify_settings_files_unreadable_when_path_is_a_directory(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / "claude-settings-is-dir"
    config_dir.mkdir()
    (config_dir / "settings.json").mkdir()

    report = await hooks_service.verify_settings_files([str(config_dir)])
    assert report["overall"] == "error"
    assert report["results"][0]["file_status"] == "unreadable"


@pytest.mark.asyncio
async def test_verify_settings_files_reports_found_elsewhere(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / "claude-misplaced"
    config_dir.mkdir()
    block = hooks_service.build_hook_settings(_BASE)
    sibling = config_dir / "settings.local.json"
    sibling.write_text(json.dumps(block), encoding="utf-8")
    # The target settings.json itself does not exist.

    report = await hooks_service.verify_settings_files([str(config_dir)])
    result = report["results"][0]
    assert result["file_status"] == "missing_file"
    assert result["found_elsewhere"] == [str(sibling)]


@pytest.mark.asyncio
async def test_verify_settings_files_empty_config_homes() -> None:
    report = await hooks_service.verify_settings_files([])
    assert report["results"] == []
    assert report["overall"] == "absent"


@pytest.mark.asyncio
async def test_verify_settings_files_never_returns_file_contents(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / "claude-secret"
    config_dir.mkdir()
    payload: dict[str, object] = {"env": {"ANTHROPIC_API_KEY": "sk-ant-SECRET"}}
    payload.update(hooks_service.build_hook_settings(_BASE))
    (config_dir / "settings.json").write_text(json.dumps(payload), encoding="utf-8")

    report = await hooks_service.verify_settings_files([str(config_dir)])
    assert "sk-ant-SECRET" not in json.dumps(report)


@pytest.mark.asyncio
async def test_verify_settings_files_never_writes(
    tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    config_dir = tmp_path / "claude-untouched"
    config_dir.mkdir()
    settings_path = config_dir / "settings.json"
    settings_path.write_text('{"hooks": {}}', encoding="utf-8")
    before_bytes = settings_path.read_bytes()
    before_mtime = settings_path.stat().st_mtime_ns
    missing_dir = tmp_path / "claude-missing"

    await hooks_service.verify_settings_files([str(config_dir), str(missing_dir)])

    assert settings_path.read_bytes() == before_bytes
    assert settings_path.stat().st_mtime_ns == before_mtime
    assert not (missing_dir / "settings.json").exists()


# ─── self-test tokens ─────────────────────────────────────────────────────────


def test_self_test_token_roundtrip() -> None:
    mint = hooks_service.mint_self_test(_BASE)
    token = mint["token"]

    before = hooks_service.read_self_test(token)
    assert before == {"known": True, "received": False, "elapsed_ms": None}

    assert hooks_service.record_self_test(token) is True

    after = hooks_service.read_self_test(token)
    assert after["known"] is True
    assert after["received"] is True
    assert after["elapsed_ms"] is not None and after["elapsed_ms"] >= 0


def test_self_test_unknown_token() -> None:
    receipt = hooks_service.read_self_test("deadbeefdeadbeefdeadbeefdeadbeef")
    assert receipt == {"known": False, "received": False, "elapsed_ms": None}
    assert hooks_service.record_self_test("deadbeefdeadbeefdeadbeefdeadbeef") is False


def test_self_test_evicts_oldest_beyond_cap() -> None:
    tokens = [hooks_service.mint_self_test(_BASE)["token"] for _ in range(17)]
    assert hooks_service.read_self_test(tokens[0])["known"] is False
    for token in tokens[1:]:
        assert hooks_service.read_self_test(token)["known"] is True


def test_self_test_command_matches_hook_command_shape() -> None:
    mint = hooks_service.mint_self_test(_BASE)
    session_start_cmd = hooks_service.build_hook_settings(_BASE)["hooks"][
        "SessionStart"
    ][0]["hooks"][0]["command"]
    real_url = f"{_BASE}/api/v1/hooks/session-start"
    expected = session_start_cmd.replace(real_url, mint["url"])
    assert mint["command"] == expected


# ─── router: TestClient over the workspace router ────────────────────────────


@pytest.fixture
def hooks_client() -> TestClient:
    app = FastAPI()
    app.include_router(workspace_router.router)
    return TestClient(app)


def test_verify_endpoint_returns_report(hooks_client: TestClient) -> None:
    resp = hooks_client.post(
        "/api/v1/workspace/hooks/verify", json={"config_homes": []}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["overall"] == "absent"
    assert body["results"] == []
    assert set(body["expected_events"]) == {
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SessionEnd",
    }


def test_self_test_mint_then_ingest_then_receipt(hooks_client: TestClient) -> None:
    mint_resp = hooks_client.post("/api/v1/workspace/hooks/self-test")
    assert mint_resp.status_code == 200
    token = mint_resp.json()["token"]

    ingest_resp = hooks_client.post(f"/api/v1/workspace/hooks/self-test/{token}")
    assert ingest_resp.status_code == 200
    assert ingest_resp.json() == {"continue": True, "recorded": True}

    receipt_resp = hooks_client.get(f"/api/v1/workspace/hooks/self-test/{token}")
    assert receipt_resp.status_code == 200
    receipt = receipt_resp.json()
    assert receipt["known"] is True
    assert receipt["received"] is True


def test_self_test_receipt_is_200_for_unknown_token(hooks_client: TestClient) -> None:
    resp = hooks_client.get("/api/v1/workspace/hooks/self-test/deadbeef")
    assert resp.status_code == 200
    assert resp.json() == {"known": False, "received": False, "elapsed_ms": None}


@pytest.mark.asyncio
async def test_self_test_ingest_does_not_touch_the_database(
    hooks_client: TestClient, migrated_db: aiosqlite.Connection
) -> None:
    original_db = db_module._db
    db_module._db = migrated_db
    try:
        mint_resp = hooks_client.post("/api/v1/workspace/hooks/self-test")
        token = mint_resp.json()["token"]
        ingest_resp = hooks_client.post(f"/api/v1/workspace/hooks/self-test/{token}")
        assert ingest_resp.status_code == 200

        cur = await migrated_db.execute("SELECT COUNT(*) AS n FROM agent_sessions")
        row = await cur.fetchone()
        assert row is not None
        assert row["n"] == 0
    finally:
        db_module._db = original_db
