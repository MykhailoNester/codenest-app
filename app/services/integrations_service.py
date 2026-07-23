"""Cross-App Integrations Pack.

The catalog is now stored in the ``integration_catalog`` DB table (migration
049) rather than in a frozen Python tuple.  The public API surface is
unchanged so every existing caller continues to work.

``is_custom=0`` rows are seeded by the migration and correspond to the
original 10 entries.  ``is_custom=1`` rows are user-added custom integrations
(e.g. an ``acli`` Atlassian CLI wrapper).

Install / uninstall still go through ``mcp_servers_service`` — the catalog
table is purely declarative metadata.

Backward compat note: the module-level ``CATALOG`` tuple and ``_BY_SLUG``
dict are removed.  Any code that imported them (internal only) now calls
``get_catalog_entry_sync()`` or the async ``list_catalog_from_db()``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import aiosqlite
from fastapi import HTTPException

from . import mcp_servers_service

logger = logging.getLogger(__name__)

# ─── Row conversion ──────────────────────────────────────────────────────────


def _row_to_entry(row: aiosqlite.Row) -> dict[str, Any]:
    """Convert a ``integration_catalog`` DB row to the public dict shape."""
    try:
        args: list[Any] = json.loads(row["mcp_args"] or "[]")
    except (json.JSONDecodeError, TypeError):
        args = []
    try:
        env_keys: list[str] = json.loads(row["env_template"] or "[]")
    except (json.JSONDecodeError, TypeError):
        env_keys = []
    return {
        "slug": row["slug"],
        "name": row["name"],
        "description": row["description"],
        "icon": row["icon"],
        "pane_url": row["pane_url"],
        "is_custom": bool(row["is_custom"]),
        "mcp": {
            "command": row["mcp_command"],
            "args": args,
            "env_template": env_keys,
        },
    }


# ─── DB-backed catalog reads ─────────────────────────────────────────────────


async def list_catalog_from_db(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    """Return every entry in ``integration_catalog``, ordered by name."""
    async with db.execute("SELECT * FROM integration_catalog ORDER BY name ASC") as cur:
        rows = await cur.fetchall()
    return [_row_to_entry(r) for r in rows]


async def get_catalog_entry_from_db(
    db: aiosqlite.Connection, slug: str
) -> dict[str, Any]:
    """Return one catalog entry by slug, 404 if not found."""
    async with db.execute(
        "SELECT * FROM integration_catalog WHERE slug = ?", (slug,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, f"unknown integration {slug!r}")
    return _row_to_entry(row)


async def add_custom_entry(
    db: aiosqlite.Connection,
    *,
    slug: str,
    name: str,
    description: str = "",
    pane_url: str = "",
    mcp_command: str,
    mcp_args: list[str] | None = None,
    env_template: list[str] | None = None,
) -> dict[str, Any]:
    """Insert a user-authored catalog entry (``is_custom=1``).

    The ``slug`` must be unique.  Returns the created entry.
    """
    if not slug or not slug.isidentifier():
        raise HTTPException(400, "slug must be a valid identifier")
    if not name.strip():
        raise HTTPException(400, "name is required")
    if not mcp_command.strip():
        raise HTTPException(400, "mcp_command is required")
    args_json = json.dumps(mcp_args or [])
    env_json = json.dumps(env_template or [])
    try:
        await db.execute(
            """
            INSERT INTO integration_catalog
                (slug, name, description, pane_url, mcp_command, mcp_args,
                 env_template, is_custom)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
            """,
            (
                slug,
                name.strip(),
                description,
                pane_url,
                mcp_command.strip(),
                args_json,
                env_json,
            ),
        )
    except aiosqlite.IntegrityError as exc:
        raise HTTPException(409, f"integration slug {slug!r} already exists: {exc}")
    await db.commit()
    return await get_catalog_entry_from_db(db, slug)


async def delete_custom_entry(db: aiosqlite.Connection, slug: str) -> dict[str, Any]:
    """Delete a user-authored (``is_custom=1``) catalog entry."""
    async with db.execute(
        "SELECT is_custom FROM integration_catalog WHERE slug = ?", (slug,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(404, f"integration {slug!r} not found")
    if not bool(row["is_custom"]):
        raise HTTPException(400, "cannot delete a seeded integration entry")
    await db.execute("DELETE FROM integration_catalog WHERE slug = ?", (slug,))
    await db.commit()
    return {"slug": slug, "deleted": True}


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _source_marker(slug: str) -> str:
    return f"integration:{slug}"


# ─── Public install/uninstall API ─────────────────────────────────────────────


async def list_with_status(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    """Return every catalog entry annotated with its install status."""
    async with db.execute(
        "SELECT slug, source FROM mcp_servers WHERE source LIKE 'integration:%'"
    ) as cur:
        installed = {row["source"]: row["slug"] for row in await cur.fetchall()}
    out: list[dict[str, Any]] = []
    for entry in await list_catalog_from_db(db):
        marker = _source_marker(entry["slug"])
        d = dict(entry)
        d["installed"] = marker in installed
        d["mcp_server_slug"] = installed.get(marker)
        out.append(d)
    return out


def _validate_env_from_entry(entry: dict[str, Any], env: Any) -> dict[str, str]:
    """Materialise user-supplied env values using the entry's env_template keys.

    Keys outside ``env_template`` are dropped; missing keys persist as empty
    strings so the row is installable before secrets are set.
    """
    if env is None:
        env = {}
    if not isinstance(env, dict):
        raise HTTPException(400, "'env' must be an object")
    out: dict[str, str] = {}
    for key in entry["mcp"].get("env_template", []):
        raw = env.get(key, "")
        if raw is None:
            raw = ""
        if not isinstance(raw, str):
            raise HTTPException(400, f"env value for {key!r} must be a string")
        out[key] = raw
    return out


async def install(db: aiosqlite.Connection, slug: str, env: Any) -> dict[str, Any]:
    """One-click install of an integration as an mcp_servers row."""
    entry = await get_catalog_entry_from_db(db, slug)
    env_map = _validate_env_from_entry(entry, env)
    target_slug = f"integration-{entry['slug']}"
    mcp = entry["mcp"]
    server = await mcp_servers_service.create_server(
        db,
        slug=target_slug,
        name=entry["name"],
        command=mcp["command"],
        args=list(mcp.get("args", [])),
        env=env_map,
        enabled=True,
        source=_source_marker(entry["slug"]),
        notes=f"Installed from integrations catalog ({entry['slug']}).",
    )
    # Atlassian is high-blast-radius: default its scope to allowlist so it is
    # opt-in per-project rather than globally active.
    if entry["slug"] == "atlassian":
        try:
            await mcp_servers_service.set_scope(db, int(server["id"]), "allowlist", [])
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "could not set allowlist scope on atlassian server %s: %s",
                server["id"],
                exc,
            )
    return {"integration": entry, "mcp_server": server}


async def uninstall(db: aiosqlite.Connection, slug: str) -> dict[str, Any]:
    """Delete the mcp_servers row that backs this integration, if any."""
    await get_catalog_entry_from_db(db, slug)  # 404 if slug unknown
    marker = _source_marker(slug)
    async with db.execute(
        "SELECT id FROM mcp_servers WHERE source = ?", (marker,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        return {"slug": slug, "removed": False}
    await db.execute("DELETE FROM mcp_servers WHERE id = ?", (row["id"],))
    await db.commit()
    return {"slug": slug, "removed": True, "mcp_server_id": int(row["id"])}
