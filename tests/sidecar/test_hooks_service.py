"""Tests for hook-setup guidance + inbound-ping verification (Command Center)."""

from __future__ import annotations

import aiosqlite
import pytest

from app.services import hooks_service


def test_build_hook_settings_covers_all_events() -> None:
    block = hooks_service.build_hook_settings("http://127.0.0.1:8002")
    hooks = block["hooks"]
    assert set(hooks) == {
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SessionEnd",
    }
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
