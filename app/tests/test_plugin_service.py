"""Tests for plugin_service.

Covers manifest parsing, canonical SHA-256 stability, the trust list,
trust-mode gating, and enable/disable behaviour.
"""

from __future__ import annotations

import json
import pathlib

import aiosqlite
import pytest
import pytest_asyncio

from app.services import plugin_service


MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        await db.executescript(mig.read_text())


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    monkeypatch.setenv("CODENEST_PLUGINS_DIR", str(tmp_path / "plugins"))
    conn = await aiosqlite.connect(str(tmp_path / "test.db"))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    yield conn
    await conn.close()


def _write_plugin(root: pathlib.Path, slug: str, **overrides) -> dict:
    manifest = {
        "slug": slug,
        "name": f"Plugin {slug}",
        "version": "1.0.0",
        "contributions": [{"type": "sidebar_item", "label": slug, "path": f"/{slug}"}],
        **overrides,
    }
    plugin_dir = root / slug
    plugin_dir.mkdir(parents=True, exist_ok=True)
    (plugin_dir / "manifest.json").write_text(json.dumps(manifest))
    return manifest


# ─── Manifest parsing ────────────────────────────────────────────────────────


def test_parse_manifest_rejects_missing_required_fields():
    with pytest.raises(plugin_service.ManifestError):
        plugin_service.parse_manifest('{"name": "x", "version": "1.0.0"}')
    with pytest.raises(plugin_service.ManifestError):
        plugin_service.parse_manifest('{"slug": "x", "version": "1.0.0"}')
    with pytest.raises(plugin_service.ManifestError):
        plugin_service.parse_manifest('{"slug": "x", "name": "x"}')


def test_parse_manifest_rejects_invalid_slug():
    with pytest.raises(plugin_service.ManifestError):
        plugin_service.parse_manifest(
            '{"slug": "Bad Slug", "name": "x", "version": "1.0.0"}'
        )


def test_parse_manifest_rejects_unknown_contribution_type():
    raw = json.dumps(
        {
            "slug": "x",
            "name": "x",
            "version": "1.0.0",
            "contributions": [{"type": "page", "path": "/x"}],
        }
    )
    with pytest.raises(plugin_service.ManifestError):
        plugin_service.parse_manifest(raw)


def test_parse_manifest_accepts_minimal_valid_manifest():
    data = plugin_service.parse_manifest(
        '{"slug": "x", "name": "X", "version": "1.0.0"}'
    )
    assert data["slug"] == "x"


# ─── Canonical SHA-256 ───────────────────────────────────────────────────────


def test_canonical_sha256_is_stable_across_key_order_and_whitespace():
    a = plugin_service.canonical_sha256({"slug": "x", "name": "X", "version": "1.0.0"})
    b = plugin_service.canonical_sha256({"version": "1.0.0", "name": "X", "slug": "x"})
    assert a == b


# ─── Scan + gating ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_permissive_mode_loads_untrusted_plugin(db):
    _write_plugin(plugin_service.plugins_root(), "alpha")
    summary = await plugin_service.scan_and_load(db)
    assert summary == {"discovered": 1, "loaded": 1, "skipped": 0, "error": 0}
    plugins = await plugin_service.list_plugins(db)
    assert len(plugins) == 1
    assert plugins[0]["signature_status"] == "untrusted"
    assert plugins[0]["load_status"] == "loaded"


@pytest.mark.asyncio
async def test_strict_mode_skips_untrusted_plugin(db):
    _write_plugin(plugin_service.plugins_root(), "alpha")
    await plugin_service.set_trust_mode(db, "strict")
    summary = await plugin_service.scan_and_load(db)
    assert summary["loaded"] == 0
    assert summary["skipped"] == 1
    plugins = await plugin_service.list_plugins(db)
    assert plugins[0]["load_status"] == "skipped"
    assert plugins[0]["signature_status"] == "untrusted"


@pytest.mark.asyncio
async def test_trust_promotes_strict_skipped_to_loaded_without_rescan(db):
    manifest = _write_plugin(plugin_service.plugins_root(), "alpha")
    await plugin_service.set_trust_mode(db, "strict")
    await plugin_service.scan_and_load(db)
    sha = plugin_service.canonical_sha256(manifest)
    await plugin_service.trust_hash(db, sha)
    plugins = await plugin_service.list_plugins(db)
    assert plugins[0]["signature_status"] == "trusted"
    assert plugins[0]["load_status"] == "loaded"


@pytest.mark.asyncio
async def test_broken_manifest_records_error_row(db):
    root = plugin_service.plugins_root()
    bad = root / "bad"
    bad.mkdir(parents=True)
    (bad / "manifest.json").write_text("{not valid json")
    summary = await plugin_service.scan_and_load(db)
    assert summary == {"discovered": 1, "loaded": 0, "skipped": 0, "error": 1}
    plugins = await plugin_service.list_plugins(db)
    assert plugins[0]["load_status"] == "error"
    assert plugins[0]["load_error"] and "invalid JSON" in plugins[0]["load_error"]


@pytest.mark.asyncio
async def test_set_enabled_flips_load_status(db):
    _write_plugin(plugin_service.plugins_root(), "alpha")
    await plugin_service.scan_and_load(db)
    plugins = await plugin_service.list_plugins(db)
    pid = plugins[0]["id"]
    disabled = await plugin_service.set_enabled(db, pid, False)
    assert disabled["enabled"] is False
    assert disabled["load_status"] == "skipped"
    re_enabled = await plugin_service.set_enabled(db, pid, True)
    assert re_enabled["enabled"] is True
    # Re-enable under default permissive mode loads even though untrusted.
    assert re_enabled["load_status"] == "loaded"


@pytest.mark.asyncio
async def test_trust_mode_invalid_value_rejected(db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await plugin_service.set_trust_mode(db, "anything")


@pytest.mark.asyncio
async def test_trust_hash_validates_format(db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        await plugin_service.trust_hash(db, "not-a-real-hash")


# ─── Symlink hardening ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_symlinked_plugin_dir_is_skipped(db, tmp_path):
    # A symlink whose target is some unrelated directory must not be
    # walked, even if the target happens to contain a manifest.json.
    root = plugin_service.plugins_root()
    root.mkdir(parents=True, exist_ok=True)
    decoy = tmp_path / "decoy"
    decoy.mkdir()
    (decoy / "manifest.json").write_text(
        json.dumps({"slug": "decoy", "name": "decoy", "version": "1.0.0"})
    )
    (root / "evil").symlink_to(decoy)
    summary = await plugin_service.scan_and_load(db)
    assert summary == {"discovered": 0, "loaded": 0, "skipped": 0, "error": 0}


@pytest.mark.asyncio
async def test_oversized_manifest_records_error(db):
    root = plugin_service.plugins_root()
    big = root / "big"
    big.mkdir(parents=True)
    (big / "manifest.json").write_text("a" * (plugin_service._MAX_MANIFEST_BYTES + 1))
    summary = await plugin_service.scan_and_load(db)
    assert summary == {"discovered": 1, "loaded": 0, "skipped": 0, "error": 1}
    plugins = await plugin_service.list_plugins(db)
    assert plugins[0]["load_status"] == "error"
    assert "exceeds" in (plugins[0]["load_error"] or "")
