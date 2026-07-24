"""Plugin SDK & Local Plugin System.

Discovers declarative plugins under the known plugins root, parses each
manifest, computes its canonical SHA-256, and records one ``plugins``
row per directory. The sidecar never executes plugin-supplied code —
``contributions`` are JSON-only and bind to renderers/registries that
already exist in the bundle.

The "signature" is the SHA-256 of the canonical (sorted-keys, UTF-8)
``manifest.json``. A plugin is **trusted** iff that hash is present in
``app_settings.plugin_trust_hashes``. ``app_settings.plugin_trust_mode``
controls what happens to untrusted plugins:

- ``permissive`` (default) — untrusted plugins load with a warning badge
- ``strict`` — untrusted plugins are recorded with ``load_status='skipped'``

A real cryptographic signature (Ed25519) can be layered on top of the
same trust list later without breaking the schema.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import aiosqlite
from fastapi import HTTPException

log = logging.getLogger(__name__)


# ─── Constants ───────────────────────────────────────────────────────────────


_SAFE_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")
_SAFE_VERSION = re.compile(r"^[0-9]+(\.[0-9]+){0,3}([-+][A-Za-z0-9.-]+)?$")

_VALID_CONTRIB_TYPES: frozenset[str] = frozenset(
    {"sidebar_item", "widget", "mcp_server"}
)

_REQUIRED_MANIFEST_KEYS: tuple[str, ...] = ("slug", "name", "version")

_TRUST_MODES: frozenset[str] = frozenset({"strict", "permissive"})

# Cap on manifest.json size. A real manifest is a few KB; the cap stops a
# malicious symlink from streaming arbitrary file contents (~/.ssh/*, /etc/*)
# into the DB via the load_error path.
_MAX_MANIFEST_BYTES = 64 * 1024


# ─── Plugin root resolution ──────────────────────────────────────────────────


def plugins_root() -> Path:
    """Resolve the known plugins root, honoring ``CODENEST_PLUGINS_DIR``.

    Defaults to ``~/.codenest/plugins/`` for parity with the marketplace's
    user-scoped install paths. The directory is created lazily on first
    scan so a fresh install with no plugins doesn't error.
    """
    raw = os.environ.get("CODENEST_PLUGINS_DIR")
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".codenest" / "plugins").resolve()


# ─── Manifest parsing & validation ───────────────────────────────────────────


class ManifestError(ValueError):
    """Raised when a manifest cannot be parsed or fails schema validation."""


def parse_manifest(raw: str | bytes) -> dict[str, Any]:
    """Parse + validate ``manifest.json`` contents. Raises ``ManifestError``."""
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        data = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestError(f"invalid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise ManifestError("manifest must be a JSON object")
    for key in _REQUIRED_MANIFEST_KEYS:
        if key not in data:
            raise ManifestError(f"missing required field {key!r}")
    if not isinstance(data["slug"], str) or not _SAFE_SLUG.match(data["slug"]):
        raise ManifestError("slug must match [a-z0-9][a-z0-9_-]*")
    if not isinstance(data["name"], str) or not data["name"].strip():
        raise ManifestError("name must be a non-empty string")
    if not isinstance(data["version"], str) or not _SAFE_VERSION.match(data["version"]):
        raise ManifestError("version must be semver-shaped (e.g. 1.2.3)")
    contribs = data.get("contributions", [])
    if not isinstance(contribs, list):
        raise ManifestError("contributions must be a list")
    for entry in contribs:
        if not isinstance(entry, dict):
            raise ManifestError("each contribution must be a JSON object")
        ctype = entry.get("type")
        if ctype not in _VALID_CONTRIB_TYPES:
            raise ManifestError(
                f"unknown contribution type {ctype!r}; expected one of "
                f"{sorted(_VALID_CONTRIB_TYPES)}"
            )
    return data


def canonical_sha256(manifest: dict[str, Any]) -> str:
    """SHA-256 of the canonical (sorted-keys, no-whitespace) manifest.

    Using the canonical form means two byte-different but
    semantically-equal manifest files share the same signature — the
    trust list is authored against meaning, not formatting.
    """
    payload = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return hashlib.sha256(payload).hexdigest()


# ─── Trust helpers ───────────────────────────────────────────────────────────


async def _get_setting(db: aiosqlite.Connection, key: str, default: Any) -> Any:
    async with db.execute(
        "SELECT value_json FROM app_settings WHERE key = ?", (key,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return default
    try:
        return json.loads(row["value_json"])
    except (TypeError, ValueError):
        return default


async def _set_setting(db: aiosqlite.Connection, key: str, value: Any) -> None:
    await db.execute(
        "INSERT INTO app_settings (key, value_json, updated_at) "
        "VALUES (?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(key) DO UPDATE SET "
        "  value_json = excluded.value_json, "
        "  updated_at = CURRENT_TIMESTAMP",
        (key, json.dumps(value)),
    )
    await db.commit()


async def get_trust_mode(db: aiosqlite.Connection) -> str:
    mode = await _get_setting(db, "plugin_trust_mode", "permissive")
    return mode if mode in _TRUST_MODES else "permissive"


async def get_trust_hashes(db: aiosqlite.Connection) -> set[str]:
    raw = await _get_setting(db, "plugin_trust_hashes", [])
    if not isinstance(raw, list):
        return set()
    return {h for h in raw if isinstance(h, str)}


async def trust_hash(db: aiosqlite.Connection, sha256: str) -> dict[str, Any]:
    """Append ``sha256`` to the trust list and re-evaluate any matching rows."""
    if not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise HTTPException(400, "sha256 must be a lowercase 64-char hex string")
    hashes = await get_trust_hashes(db)
    hashes.add(sha256)
    await _set_setting(db, "plugin_trust_hashes", sorted(hashes))
    await db.execute(
        "UPDATE plugins SET signature_status = 'trusted', "
        "  load_status = CASE "
        "    WHEN load_status = 'skipped' AND enabled = 1 THEN 'loaded' "
        "    ELSE load_status END, "
        "  load_error = CASE "
        "    WHEN load_status = 'skipped' AND enabled = 1 THEN NULL "
        "    ELSE load_error END, "
        "  updated_at = CURRENT_TIMESTAMP "
        "WHERE manifest_sha256 = ?",
        (sha256,),
    )
    await db.commit()
    return {"hash": sha256, "total_trusted": len(hashes)}


async def untrust_hash(db: aiosqlite.Connection, sha256: str) -> dict[str, Any]:
    hashes = await get_trust_hashes(db)
    if sha256 in hashes:
        hashes.discard(sha256)
        await _set_setting(db, "plugin_trust_hashes", sorted(hashes))
    return {"hash": sha256, "total_trusted": len(hashes)}


async def set_trust_mode(db: aiosqlite.Connection, mode: str) -> dict[str, Any]:
    if mode not in _TRUST_MODES:
        raise HTTPException(400, f"trust_mode must be one of {sorted(_TRUST_MODES)}")
    await _set_setting(db, "plugin_trust_mode", mode)
    return {"trust_mode": mode}


# ─── Scan / load ─────────────────────────────────────────────────────────────


async def list_plugins(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    async with db.execute("SELECT * FROM plugins ORDER BY slug ASC") as cur:
        rows = await cur.fetchall()
    return [_row_to_dict(r) for r in rows]


async def set_enabled(
    db: aiosqlite.Connection, plugin_id: int, enabled: bool
) -> dict[str, Any]:
    async with db.execute("SELECT id FROM plugins WHERE id = ?", (plugin_id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "plugin not found")
    # Flip the `enabled` flag only; let _reevaluate_one resolve load_status
    # from the (enabled, signature_status, trust_mode) tuple so a strict-mode
    # untrusted plugin never momentarily shows as `loaded` between two writes.
    await db.execute(
        "UPDATE plugins SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (1 if enabled else 0, plugin_id),
    )
    await db.commit()
    await _reevaluate_one(db, plugin_id)
    return await _get_plugin_dict(db, plugin_id)


async def scan_and_load(db: aiosqlite.Connection) -> dict[str, Any]:
    """Walk the plugins root once; upsert one row per discovered directory.

    Returns a summary ``{discovered, loaded, skipped, error}``. Idempotent:
    repeated calls on an unchanged directory don't change any row.
    """
    root = plugins_root()
    root.mkdir(parents=True, exist_ok=True)
    trust_mode = await get_trust_mode(db)
    trust_hashes = await get_trust_hashes(db)
    summary = {"discovered": 0, "loaded": 0, "skipped": 0, "error": 0}
    for dir_path in _iter_plugin_dirs(root):
        summary["discovered"] += 1
        try:
            slug, name, version, manifest, sha = _load_manifest_file(dir_path)
        except ManifestError as exc:
            await _upsert_error(db, dir_path, exc)
            summary["error"] += 1
            continue
        signature_status = "trusted" if sha in trust_hashes else "untrusted"
        load_status = _gate(signature_status, trust_mode, enabled=True)
        await _upsert_plugin(
            db,
            slug=slug,
            name=name,
            version=version,
            dir_path=str(dir_path),
            manifest=manifest,
            sha=sha,
            signature_status=signature_status,
            load_status=load_status,
        )
        summary[load_status] = summary.get(load_status, 0) + 1
    return summary


# ─── Internal helpers ────────────────────────────────────────────────────────


def _iter_plugin_dirs(root: Path) -> Iterable[Path]:
    """Yield top-level plugin directories under ``root``.

    Symlinks are skipped — both as plugin directories and as the
    ``manifest.json`` inside them — so a malicious symlink can't pull
    arbitrary user-readable files into the loader (and therefore into
    the SQL ``manifest_json`` / ``load_error`` columns).
    """
    if not root.is_dir():
        return ()
    out: list[Path] = []
    for entry in sorted(root.iterdir()):
        if entry.is_symlink() or not entry.is_dir():
            continue
        manifest = entry / "manifest.json"
        if manifest.is_symlink() or not manifest.is_file():
            continue
        out.append(entry)
    return out


def _load_manifest_file(
    dir_path: Path,
) -> tuple[str, str, str, dict[str, Any], str]:
    manifest_path = dir_path / "manifest.json"
    # Size-cap defends against a manifest.json that's been swapped for a
    # large file post-listing (TOCTOU) or a deliberately oversized
    # payload designed to balloon the DB row.
    try:
        size = manifest_path.stat().st_size
    except OSError as exc:
        raise ManifestError(f"cannot stat manifest.json: {exc}") from None
    if size > _MAX_MANIFEST_BYTES:
        raise ManifestError(
            f"manifest.json exceeds {_MAX_MANIFEST_BYTES} bytes (size={size})"
        )
    raw = manifest_path.read_bytes()
    manifest = parse_manifest(raw)
    sha = canonical_sha256(manifest)
    return manifest["slug"], manifest["name"], manifest["version"], manifest, sha


def _gate(signature_status: str, trust_mode: str, *, enabled: bool) -> str:
    if not enabled:
        return "skipped"
    if trust_mode == "strict" and signature_status != "trusted":
        return "skipped"
    return "loaded"


async def _upsert_plugin(
    db: aiosqlite.Connection,
    *,
    slug: str,
    name: str,
    version: str,
    dir_path: str,
    manifest: dict[str, Any],
    sha: str,
    signature_status: str,
    load_status: str,
) -> None:
    manifest_json = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    await db.execute(
        "INSERT INTO plugins "
        "  (slug, name, version, dir_path, manifest_json, manifest_sha256, "
        "   signature_status, load_status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(slug) DO UPDATE SET "
        "  name = excluded.name, "
        "  version = excluded.version, "
        "  dir_path = excluded.dir_path, "
        "  manifest_json = excluded.manifest_json, "
        "  manifest_sha256 = excluded.manifest_sha256, "
        "  signature_status = excluded.signature_status, "
        "  load_status = CASE WHEN plugins.enabled = 1 "
        "                THEN excluded.load_status ELSE 'skipped' END, "
        "  load_error = NULL, "
        "  updated_at = CURRENT_TIMESTAMP",
        (
            slug,
            name,
            version,
            dir_path,
            manifest_json,
            sha,
            signature_status,
            load_status,
        ),
    )
    await db.commit()


async def _upsert_error(
    db: aiosqlite.Connection, dir_path: Path, exc: ManifestError
) -> None:
    """Record a manifest-parse failure keyed by the directory name as slug.

    The slug is best-effort because a broken manifest may not have one;
    we fall back to the dir name (sanitized) so the row is still unique.
    """
    fallback_slug = re.sub(r"[^a-z0-9_-]+", "-", dir_path.name.lower()).strip("-")[:128]
    if not fallback_slug:
        fallback_slug = "unknown"
    await db.execute(
        "INSERT INTO plugins "
        "  (slug, name, version, dir_path, manifest_json, manifest_sha256, "
        "   signature_status, load_status, load_error) "
        "VALUES (?, ?, '0.0.0', ?, '{}', '', 'untrusted', 'error', ?) "
        "ON CONFLICT(slug) DO UPDATE SET "
        "  dir_path = excluded.dir_path, "
        "  load_status = 'error', "
        "  load_error = excluded.load_error, "
        "  updated_at = CURRENT_TIMESTAMP",
        (fallback_slug, fallback_slug, str(dir_path), str(exc)),
    )
    await db.commit()


async def _reevaluate_one(db: aiosqlite.Connection, plugin_id: int) -> None:
    async with db.execute(
        "SELECT signature_status, enabled, load_status FROM plugins WHERE id = ?",
        (plugin_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None or row["load_status"] == "error":
        return
    trust_mode = await get_trust_mode(db)
    new = _gate(row["signature_status"], trust_mode, enabled=bool(row["enabled"]))
    if new != row["load_status"]:
        await db.execute(
            "UPDATE plugins SET load_status = ?, updated_at = CURRENT_TIMESTAMP "
            "WHERE id = ?",
            (new, plugin_id),
        )
        await db.commit()


async def _get_plugin_dict(db: aiosqlite.Connection, plugin_id: int) -> dict[str, Any]:
    async with db.execute("SELECT * FROM plugins WHERE id = ?", (plugin_id,)) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, "plugin not found")
    return _row_to_dict(row)


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    d["enabled"] = bool(d.get("enabled", 0))
    try:
        d["manifest"] = json.loads(d.pop("manifest_json", "{}"))
    except (TypeError, ValueError):
        d["manifest"] = {}
    return d
