"""Tests for MCP scoping and launch materialization.

Covers:
- resolve_enabled_for_project: all / allowlist / off scope modes
- materialize_mcp_config: file shape and content
- set_scope: mode transitions and allowlist upsert
- integration_catalog: DB seed (10 entries present), add_custom_entry,
  delete_custom_entry, and the Atlassian allowlist-scope-on-install path.
"""

from __future__ import annotations

import json
import pathlib

import pytest

from app.services import integrations_service, mcp_servers_service


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


async def _make_server(db, slug: str, enabled: bool = True) -> dict:
    return await mcp_servers_service.create_server(
        db,
        slug=slug,
        name=slug.capitalize(),
        command="npx",
        args=["-y", f"@mcp/server-{slug}"],
        env={},
        enabled=enabled,
        source="test",
    )


async def _make_project(db, name: str = "Test") -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, status) VALUES (?, 'active')", (name,)
    )
    await db.commit()
    return int(cur.lastrowid)


# ─────────────────────────────────────────────────────────────────────────────
# resolve_enabled_for_project
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_all_scope(migrated_db):
    """scope_mode='all' servers appear for every project."""
    db = migrated_db
    pid = await _make_project(db)
    srv = await _make_server(db, "tool-a")
    # Default scope_mode is 'all'; no scope rows needed.

    result = await mcp_servers_service.resolve_enabled_for_project(db, pid)
    slugs = [s["slug"] for s in result]
    assert srv["slug"] in slugs


@pytest.mark.asyncio
async def test_resolve_allowlist_included(migrated_db):
    """scope_mode='allowlist' server appears when project is in the allowlist."""
    db = migrated_db
    pid = await _make_project(db)
    srv = await _make_server(db, "tool-b")
    await mcp_servers_service.set_scope(db, srv["id"], "allowlist", [pid])

    result = await mcp_servers_service.resolve_enabled_for_project(db, pid)
    slugs = [s["slug"] for s in result]
    assert srv["slug"] in slugs


@pytest.mark.asyncio
async def test_resolve_allowlist_excluded(migrated_db):
    """scope_mode='allowlist' server is absent when project is NOT in allowlist."""
    db = migrated_db
    pid1 = await _make_project(db, "ProjectA")
    pid2 = await _make_project(db, "ProjectB")
    srv = await _make_server(db, "tool-c")
    await mcp_servers_service.set_scope(db, srv["id"], "allowlist", [pid1])

    result = await mcp_servers_service.resolve_enabled_for_project(db, pid2)
    slugs = [s["slug"] for s in result]
    assert srv["slug"] not in slugs


@pytest.mark.asyncio
async def test_resolve_off_scope(migrated_db):
    """scope_mode='off' server never appears."""
    db = migrated_db
    pid = await _make_project(db)
    srv = await _make_server(db, "tool-d")
    await mcp_servers_service.set_scope(db, srv["id"], "off", [])

    result = await mcp_servers_service.resolve_enabled_for_project(db, pid)
    slugs = [s["slug"] for s in result]
    assert srv["slug"] not in slugs


@pytest.mark.asyncio
async def test_resolve_disabled_server_excluded(migrated_db):
    """Disabled servers (enabled=0) are never included regardless of scope_mode."""
    db = migrated_db
    pid = await _make_project(db)
    srv = await _make_server(db, "tool-e", enabled=False)

    result = await mcp_servers_service.resolve_enabled_for_project(db, pid)
    slugs = [s["slug"] for s in result]
    assert srv["slug"] not in slugs


# ─────────────────────────────────────────────────────────────────────────────
# materialize_mcp_config
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_materialize_creates_file(migrated_db, tmp_path, monkeypatch):
    """materialize_mcp_config writes a valid JSON file to the tmp dir."""
    db = migrated_db
    pid = await _make_project(db)
    await _make_server(db, "tool-f")

    # Redirect the temp dir to tmp_path so we don't litter real /tmp.
    monkeypatch.setattr(
        mcp_servers_service,
        "_MCP_TMP_DIR",
        tmp_path / "codenest-mcp",
    )

    path = await mcp_servers_service.materialize_mcp_config(db, pid)
    config_file = pathlib.Path(path)
    assert config_file.exists()

    payload = json.loads(config_file.read_text())
    assert "mcpServers" in payload
    assert "tool-f" in payload["mcpServers"]
    entry = payload["mcpServers"]["tool-f"]
    assert entry["command"] == "npx"
    assert entry["args"] == ["-y", "@mcp/server-tool-f"]


@pytest.mark.asyncio
async def test_materialize_respects_scope(migrated_db, tmp_path, monkeypatch):
    """materialize_mcp_config omits servers that don't match the project scope."""
    db = migrated_db
    pid = await _make_project(db)
    srv_all = await _make_server(db, "tool-all")
    srv_off = await _make_server(db, "tool-off")
    await mcp_servers_service.set_scope(db, srv_off["id"], "off", [])

    monkeypatch.setattr(
        mcp_servers_service,
        "_MCP_TMP_DIR",
        tmp_path / "codenest-mcp",
    )

    path = await mcp_servers_service.materialize_mcp_config(db, pid)
    payload = json.loads(pathlib.Path(path).read_text())
    assert srv_all["slug"] in payload["mcpServers"]
    assert srv_off["slug"] not in payload["mcpServers"]


@pytest.mark.asyncio
async def test_materialize_respects_exclude_slugs(migrated_db, tmp_path, monkeypatch):
    """materialize_mcp_config omits slugs listed in exclude_slugs.

    This is the server-side enforcement of the per-launch capability
    disclosure panel: the written config must exactly match what the panel
    showed the user — excluded slugs must not appear in the file.
    """
    db = migrated_db
    pid = await _make_project(db)
    srv_keep = await _make_server(db, "keep-server")
    srv_drop = await _make_server(db, "drop-server")

    monkeypatch.setattr(
        mcp_servers_service,
        "_MCP_TMP_DIR",
        tmp_path / "codenest-mcp",
    )

    # Both servers are scope_mode='all' and enabled — the project-level scope
    # would normally include both.  exclude_slugs overrides at launch time.
    path = await mcp_servers_service.materialize_mcp_config(
        db, pid, exclude_slugs=["drop-server"]
    )
    payload = json.loads(pathlib.Path(path).read_text())
    assert srv_keep["slug"] in payload["mcpServers"], "kept server must be in config"
    assert srv_drop["slug"] not in payload["mcpServers"], (
        "excluded server must be absent"
    )


@pytest.mark.asyncio
async def test_materialize_exclude_slugs_empty_list(migrated_db, tmp_path, monkeypatch):
    """An empty exclude_slugs list excludes nothing — all scoped servers included."""
    db = migrated_db
    pid = await _make_project(db)
    srv = await _make_server(db, "always-present")

    monkeypatch.setattr(
        mcp_servers_service,
        "_MCP_TMP_DIR",
        tmp_path / "codenest-mcp",
    )

    path = await mcp_servers_service.materialize_mcp_config(db, pid, exclude_slugs=[])
    payload = json.loads(pathlib.Path(path).read_text())
    assert srv["slug"] in payload["mcpServers"]


# ─────────────────────────────────────────────────────────────────────────────
# set_scope
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_set_scope_invalid_mode(migrated_db):
    """set_scope rejects unknown scope_mode values."""
    from fastapi import HTTPException

    db = migrated_db
    srv = await _make_server(db, "tool-g")
    with pytest.raises(HTTPException) as exc_info:
        await mcp_servers_service.set_scope(db, srv["id"], "invalid", [])
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_set_scope_all_clears_allowlist(migrated_db):
    """Switching to 'all' from 'allowlist' removes stale scope rows."""
    db = migrated_db
    pid = await _make_project(db)
    srv = await _make_server(db, "tool-h")
    await mcp_servers_service.set_scope(db, srv["id"], "allowlist", [pid])

    # Now switch back to 'all'.
    updated = await mcp_servers_service.set_scope(db, srv["id"], "all", [])
    assert updated["scope_mode"] == "all"
    assert updated["scope_project_ids"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Integration catalog (A6)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_catalog_seed_has_ten_entries(migrated_db):
    """Migration 049 seeds exactly 10 integration catalog entries."""
    db = migrated_db
    entries = await integrations_service.list_catalog_from_db(db)
    assert len(entries) == 10


@pytest.mark.asyncio
async def test_catalog_seed_contains_atlassian(migrated_db):
    """Atlassian is in the seeded catalog."""
    db = migrated_db
    entry = await integrations_service.get_catalog_entry_from_db(db, "atlassian")
    assert entry["slug"] == "atlassian"
    assert "ATLASSIAN_EMAIL" in entry["mcp"]["env_template"]
    assert entry["is_custom"] is False


@pytest.mark.asyncio
async def test_add_custom_entry(migrated_db):
    """add_custom_entry inserts a user-authored entry with is_custom=True."""
    db = migrated_db
    entry = await integrations_service.add_custom_entry(
        db,
        slug="acli_wrapper",
        name="Atlassian CLI",
        description="Custom acli integration",
        mcp_command="acli",
        mcp_args=["mcp", "serve"],
        env_template=["ATLASSIAN_TOKEN"],
    )
    assert entry["slug"] == "acli_wrapper"
    assert entry["is_custom"] is True
    assert entry["mcp"]["command"] == "acli"


@pytest.mark.asyncio
async def test_delete_custom_entry(migrated_db):
    """delete_custom_entry removes a user-authored entry."""
    db = migrated_db
    await integrations_service.add_custom_entry(
        db, slug="temp_entry", name="Temp", mcp_command="echo"
    )
    result = await integrations_service.delete_custom_entry(db, "temp_entry")
    assert result["deleted"] is True


@pytest.mark.asyncio
async def test_delete_seeded_entry_rejected(migrated_db):
    """delete_custom_entry raises 400 for seeded (is_custom=0) entries."""
    from fastapi import HTTPException

    db = migrated_db
    with pytest.raises(HTTPException) as exc_info:
        await integrations_service.delete_custom_entry(db, "github")
    assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_install_atlassian_sets_allowlist_scope(
    migrated_db, tmp_path, monkeypatch
):
    """Installing Atlassian sets scope_mode='allowlist' on the created server."""
    db = migrated_db
    monkeypatch.setattr(
        mcp_servers_service,
        "_MCP_TMP_DIR",
        tmp_path / "codenest-mcp",
    )

    result = await integrations_service.install(db, "atlassian", {})
    server = result["mcp_server"]
    server_id = int(server["id"])

    # Verify scope_mode was set to allowlist.
    updated = await mcp_servers_service.get_server(db, server_id)
    assert updated["scope_mode"] == "allowlist"


@pytest.mark.asyncio
async def test_list_with_status_reflects_install(migrated_db):
    """list_with_status correctly marks an installed integration."""
    db = migrated_db
    await integrations_service.install(db, "linear", {})
    entries = await integrations_service.list_with_status(db)
    linear = next(e for e in entries if e["slug"] == "linear")
    assert linear["installed"] is True
    assert linear["mcp_server_slug"] == "integration-linear"
