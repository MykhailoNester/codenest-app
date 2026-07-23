"""Agent Gallery / Local Marketplace backend.

Loads a bundled multi-source catalog of installable items and writes the
chosen item into a target project's ``.claude/`` tree, recording the
install in ``marketplace_installs``.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Literal, cast

import aiosqlite
from fastapi import HTTPException

from ._project_paths import resolve_project_root

logger = logging.getLogger(__name__)

ItemType = Literal["agent", "skill", "subagent", "hook", "mcp", "command"]

_TYPE_SUBDIR: dict[str, str] = {
    "agent": "agents",
    "skill": "skills",
    "subagent": "subagents",
    "hook": "hooks",
    "mcp": "mcp",
    "command": "commands",
}

# Cap a single install content blob at 1 MB so a malformed catalog entry
# can't OOM the sidecar at install time.
MAX_CONTENT_BYTES = 1024 * 1024

# Bound install-history responses so a runaway table cannot stall the UI.
_INSTALLS_LIST_LIMIT = 200

_CATALOG_PATH = (
    Path(__file__).resolve().parent.parent / "data" / "marketplace_catalog.json"
)

# Filenames are user-visible but written under our control; still reject
# anything that could escape the type subdir.
_SAFE_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _validate_type(t: str) -> ItemType:
    if t not in _TYPE_SUBDIR:
        raise HTTPException(
            status_code=400,
            detail=f"unknown item type {t!r}; expected one of {sorted(_TYPE_SUBDIR)}",
        )
    return cast(ItemType, t)


_CATALOG_ENTRIES: list[dict[str, Any]] | None = None
_CATALOG_BY_SLUG: dict[str, dict[str, Any]] = {}
_CATALOG_RESPONSE: dict[str, Any] | None = None


def _read_catalog_file() -> list[dict[str, Any]]:
    if not _CATALOG_PATH.is_file():
        raise HTTPException(
            status_code=500,
            detail=f"marketplace catalog missing at {_CATALOG_PATH}",
        )
    try:
        raw = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=500, detail=f"marketplace catalog unreadable: {exc}"
        )
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        raise HTTPException(
            status_code=500, detail="marketplace catalog missing 'items' array"
        )
    return items


def _validate_catalog_entry(entry: Any, slugs_seen: set[str]) -> dict[str, Any] | None:
    if not isinstance(entry, dict):
        return None
    slug = entry.get("slug")
    item_type = entry.get("type")
    filename = entry.get("filename")
    content = entry.get("content")
    if not isinstance(slug, str) or not slug or slug in slugs_seen:
        # Duplicate slugs would silently shadow each other in lookup.
        return None
    if not isinstance(item_type, str) or item_type not in _TYPE_SUBDIR:
        return None
    if not isinstance(filename, str) or not _SAFE_FILENAME.match(filename):
        return None
    if not isinstance(content, str):
        return None
    slugs_seen.add(slug)
    return entry


def _ensure_catalog_loaded() -> list[dict[str, Any]]:
    global _CATALOG_ENTRIES, _CATALOG_RESPONSE
    if _CATALOG_ENTRIES is not None:
        return _CATALOG_ENTRIES
    raw_entries = _read_catalog_file()
    slugs_seen: set[str] = set()
    validated: list[dict[str, Any]] = []
    for entry in raw_entries:
        good = _validate_catalog_entry(entry, slugs_seen)
        if good is not None:
            validated.append(good)
            _CATALOG_BY_SLUG[str(good["slug"])] = good

    metas = [{k: v for k, v in e.items() if k != "content"} for e in validated]
    sources = sorted({str(m.get("source", "")) for m in metas if m.get("source")})
    types = sorted({str(m.get("type", "")) for m in metas if m.get("type")})
    _CATALOG_RESPONSE = {"items": metas, "sources": sources, "types": types}
    _CATALOG_ENTRIES = validated
    return validated


def list_catalog() -> dict[str, Any]:
    _ensure_catalog_loaded()
    assert _CATALOG_RESPONSE is not None
    return _CATALOG_RESPONSE


def _find_item(slug: str) -> dict[str, Any]:
    _ensure_catalog_loaded()
    entry = _CATALOG_BY_SLUG.get(slug)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"catalog item {slug!r} not found")
    return entry


def _install_target(project_root: Path, item_type: ItemType, filename: str) -> Path:
    if not _SAFE_FILENAME.match(filename):
        raise HTTPException(
            status_code=400,
            detail=f"unsafe catalog filename {filename!r}",
        )
    target_dir = project_root / ".claude" / _TYPE_SUBDIR[item_type]
    candidate = target_dir / filename
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=f"path resolve failed: {exc}")
    try:
        resolved.relative_to(project_root)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="resolved install path escapes the project root",
        )
    if candidate.is_symlink():
        raise HTTPException(
            status_code=400, detail="install target is a symlink; refusing"
        )
    # Reject symlinked parents explicitly: the relative_to check above already
    # rejects out-of-tree resolves, but checking the parents survives a future
    # refactor that drops resolve() and keeps the threat model legible.
    for parent in (project_root / ".claude", target_dir):
        if parent.is_symlink():
            raise HTTPException(
                status_code=400,
                detail=f"refusing to install through symlinked directory {parent}",
            )
    return resolved


def _sha(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


async def install(
    db: aiosqlite.Connection, slug: str, project_id: int
) -> dict[str, Any]:
    entry = _find_item(slug)
    item_type = _validate_type(str(entry.get("type", "")))
    filename = str(entry.get("filename", ""))
    content = entry.get("content")
    source = str(entry.get("source", "unknown"))
    if not filename or not isinstance(content, str):
        raise HTTPException(
            status_code=500,
            detail=f"catalog entry {slug!r} is missing filename/content",
        )
    if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"catalog entry {slug!r} exceeds {MAX_CONTENT_BYTES} bytes",
        )

    project_root = await resolve_project_root(db, project_id)
    target = _install_target(project_root, item_type, filename)
    target.parent.mkdir(parents=True, exist_ok=True)
    content_sha = _sha(content)

    # Transactional install: write a unique temp file, INSERT the audit row,
    # rename into place, then commit. Any failure rolls the DB back and
    # removes the temp file so a row never references a missing file and a
    # file never lands without a row.
    tmp_path: Path | None = None
    inserted = False
    try:
        fd, tmp_name = tempfile.mkstemp(
            prefix=target.name + ".", suffix=".tmp", dir=str(target.parent)
        )
        tmp_path = Path(tmp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)

        cur = await db.execute(
            """
            INSERT INTO marketplace_installs
                (item_slug, item_type, source, project_id, installed_path, content_sha256)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (slug, item_type, source, project_id, str(target), content_sha),
        )
        inserted = True
        install_id = cur.lastrowid

        os.replace(tmp_path, target)
        tmp_path = None

        await db.commit()
    except Exception as exc:
        # Roll the DB back before touching the filesystem so a partial commit
        # cannot outlive the cleanup.
        if inserted:
            try:
                await db.rollback()
            except Exception:
                pass
        if tmp_path is not None and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=f"install failed: {exc}")

    # Best-effort: registry failure must not fail the user's click.
    if item_type == "mcp":
        from . import mcp_servers_service

        try:
            await mcp_servers_service.register_marketplace_install(
                db,
                slug=slug,
                name=str(entry.get("name", slug)),
                source=source,
                raw_content=content,
                installed_path=str(target),
            )
        except Exception as exc:
            logger.warning("mcp_servers registry update failed for %s: %s", slug, exc)

    return {
        "id": install_id,
        "item_slug": slug,
        "item_type": item_type,
        "source": source,
        "project_id": project_id,
        "installed_path": str(target),
        "content_sha256": content_sha,
    }


async def list_installs(
    db: aiosqlite.Connection, project_id: int | None = None
) -> list[dict[str, Any]]:
    cur = await db.execute(
        """
        SELECT mi.*, p.name AS project_name, p.path AS project_path
        FROM marketplace_installs mi
        JOIN projects p ON p.id = mi.project_id
        WHERE (? IS NULL OR mi.project_id = ?)
        ORDER BY mi.installed_at DESC
        LIMIT ?
        """,
        (project_id, project_id, _INSTALLS_LIST_LIMIT),
    )
    rows = await cur.fetchall()
    paths = [str(dict(r).get("installed_path") or "") for r in rows]
    # Stat each install path off the event loop so a slow disk doesn't stall
    # every other request the sidecar is handling.
    exists_flags = await asyncio.to_thread(lambda: [os.path.exists(p) for p in paths])
    out: list[dict[str, Any]] = []
    for row, exists in zip(rows, exists_flags, strict=True):
        d = dict(row)
        d["exists"] = exists
        out.append(d)
    return out
