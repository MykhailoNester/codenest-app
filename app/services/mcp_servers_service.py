"""MCP server registry backend.

Trust model: the sidecar binds ``127.0.0.1`` and is consumed exclusively
by the locally-running Tauri shell, so the user authoring an MCP config
*is* the user who can execute it. ``test_server`` therefore runs the
stored ``command`` + ``args`` directly. Argv form (no shell), a hard
timeout, capped stderr, and a NUL/newline guard on patch are the
defence-in-depth measures; we do not attempt to sandbox the command.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import pathlib
import re
import tempfile
import time
from typing import Any

import aiosqlite
from fastapi import HTTPException

from . import marketplace_service

# ---------------------------------------------------------------------------
# Temp-file directory for materialized MCP configs
# ---------------------------------------------------------------------------

# Dashboard-owned temp directory for per-launch --mcp-config files.
# Files older than this are eligible for GC by cleanup_old_mcp_configs().
_MCP_TMP_DIR = pathlib.Path(tempfile.gettempdir()) / "codenest-mcp"
_MCP_CONFIG_TTL_SECONDS = 3600  # 1 hour

logger = logging.getLogger(__name__)

_SAFE_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]*$")

# Cap how long a test probe is allowed to run. MCP servers expecting stdio
# will block forever on an empty input stream; the timeout converts that
# into a clean "looks alive" signal rather than hanging the request.
_TEST_TIMEOUT_SECONDS = 4.0

# Capture only the last few KB of stderr so a chatty server doesn't bloat
# the response.
_STDERR_TAIL_BYTES = 4 * 1024


def _parse_json_field(raw: str, field: str, default: Any) -> Any:
    raw = raw or ""
    if not raw.strip():
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=500, detail=f"corrupt {field}_json in mcp_servers: {exc}"
        )


def _coerce_args(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise HTTPException(status_code=400, detail="'args' must be a list of strings")
    return value


def _coerce_env(value: Any) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in value.items()
    ):
        raise HTTPException(
            status_code=400, detail="'env' must be a map of string→string"
        )
    # NUL is fatal to execvpe; newlines and carriage returns survive the
    # child env but corrupt downstream logging/redaction. Reject all three
    # at the boundary so every caller (manual add + integrations install)
    # gets the same guarantee `_check_command` gives
    # for the command argv.
    for k, v in value.items():
        if "\x00" in k or "\x00" in v or "\n" in v or "\r" in v:
            raise HTTPException(
                status_code=400,
                detail=f"env value for {k!r} must not contain NUL or newlines",
            )
    return value


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    args = _parse_json_field(str(d.pop("args_json", "")), "args", [])
    env = _parse_json_field(str(d.pop("env_json", "")), "env", {})
    # Defensive — a hand-edited row could contain a JSON scalar like
    # `null`; coerce to the shape the rest of the service expects.
    d["args"] = args if isinstance(args, list) else []
    d["env"] = env if isinstance(env, dict) else {}
    d["enabled"] = bool(d.get("enabled"))
    return d


async def list_servers(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    cur = await db.execute(
        """
        SELECT id, slug, name, command, args_json, env_json, enabled, source,
               notes, created_at, updated_at, scope_mode
        FROM mcp_servers
        ORDER BY name ASC
        """
    )
    return [_row_to_dict(r) for r in await cur.fetchall()]


async def list_suggested(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    """Marketplace items of type=mcp that are not already in the registry."""
    catalog = marketplace_service.list_catalog()
    async with db.execute("SELECT slug FROM mcp_servers") as cur:
        installed = {str(r["slug"]) for r in await cur.fetchall()}
    return [
        item
        for item in catalog.get("items", [])
        if item.get("type") == "mcp" and item.get("slug") not in installed
    ]


async def get_server(db: aiosqlite.Connection, server_id: int) -> dict[str, Any]:
    async with db.execute(
        """
        SELECT id, slug, name, command, args_json, env_json, enabled, source,
               notes, created_at, updated_at, scope_mode
        FROM mcp_servers WHERE id = ?
        """,
        (server_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"mcp server {server_id} not found")
    return _row_to_dict(row)


async def create_server(
    db: aiosqlite.Connection,
    slug: str,
    name: str,
    command: str,
    args: Any,
    env: Any,
    enabled: bool = True,
    source: str = "manual",
    notes: str | None = None,
) -> dict[str, Any]:
    if not isinstance(slug, str) or not _SAFE_SLUG.match(slug):
        raise HTTPException(
            status_code=400,
            detail="'slug' must match [a-z0-9][a-z0-9_-]*",
        )
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="'name' is required")
    if not isinstance(command, str) or not command.strip():
        raise HTTPException(status_code=400, detail="'command' is required")
    command = _check_command(command.strip())
    args_list = _coerce_args(args)
    env_map = _coerce_env(env)
    try:
        cur = await db.execute(
            """
            INSERT INTO mcp_servers
                (slug, name, command, args_json, env_json, enabled, source, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                slug,
                name.strip(),
                command,
                json.dumps(args_list),
                json.dumps(env_map),
                1 if enabled else 0,
                source,
                notes,
            ),
        )
    except aiosqlite.IntegrityError as exc:
        raise HTTPException(
            status_code=409, detail=f"mcp server slug {slug!r} already exists: {exc}"
        )
    await db.commit()
    server_id = cur.lastrowid
    if server_id is None:
        raise HTTPException(status_code=500, detail="failed to allocate server id")
    return await get_server(db, server_id)


_ALLOWED_PATCH_KEYS = frozenset({"name", "command", "args", "env", "enabled", "notes"})


def _check_command(value: str) -> str:
    if "\x00" in value or "\n" in value or "\r" in value:
        raise HTTPException(
            status_code=400, detail="'command' must not contain NUL or newlines"
        )
    return value


async def update_server(
    db: aiosqlite.Connection,
    server_id: int,
    patch: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(patch, dict):
        raise HTTPException(status_code=400, detail="patch body must be an object")
    unknown = set(patch.keys()) - _ALLOWED_PATCH_KEYS
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"unknown patch keys: {sorted(unknown)}"
        )
    current = await get_server(db, server_id)
    sets: list[str] = []
    params: list[Any] = []
    if "name" in patch:
        if not isinstance(patch["name"], str) or not patch["name"].strip():
            raise HTTPException(
                status_code=400, detail="'name' must be a non-empty string"
            )
        sets.append("name = ?")
        params.append(patch["name"].strip())
    if "command" in patch:
        if not isinstance(patch["command"], str) or not patch["command"].strip():
            raise HTTPException(
                status_code=400, detail="'command' must be a non-empty string"
            )
        sets.append("command = ?")
        params.append(_check_command(patch["command"].strip()))
    if "args" in patch:
        sets.append("args_json = ?")
        params.append(json.dumps(_coerce_args(patch["args"])))
    if "env" in patch:
        sets.append("env_json = ?")
        params.append(json.dumps(_coerce_env(patch["env"])))
    if "enabled" in patch:
        if not isinstance(patch["enabled"], bool):
            raise HTTPException(status_code=400, detail="'enabled' must be a boolean")
        sets.append("enabled = ?")
        params.append(1 if patch["enabled"] else 0)
    if "notes" in patch:
        if patch["notes"] is not None and not isinstance(patch["notes"], str):
            raise HTTPException(
                status_code=400, detail="'notes' must be a string or null"
            )
        sets.append("notes = ?")
        params.append(patch["notes"])
    if not sets:
        return current
    sets.append("updated_at = CURRENT_TIMESTAMP")
    params.append(server_id)
    await db.execute(
        f"UPDATE mcp_servers SET {', '.join(sets)} WHERE id = ?",
        tuple(params),
    )
    await db.commit()
    return await get_server(db, server_id)


async def delete_server(db: aiosqlite.Connection, server_id: int) -> dict[str, Any]:
    await get_server(db, server_id)
    await db.execute("DELETE FROM mcp_servers WHERE id = ?", (server_id,))
    await db.commit()
    return {"id": server_id, "deleted": True}


async def test_server(db: aiosqlite.Connection, server_id: int) -> dict[str, Any]:
    """Spawn the server's command for up to ``_TEST_TIMEOUT_SECONDS`` and
    report what happened. A server that doesn't exit on its own is treated
    as a success: it printed nothing fatal and accepted being launched."""
    server = await get_server(db, server_id)
    cmd = str(server["command"])
    args = [str(a) for a in server["args"]]
    env_map = {str(k): str(v) for k, v in server["env"].items()}

    inherited = dict(os.environ)
    inherited.update(env_map)

    try:
        proc = await asyncio.create_subprocess_exec(
            cmd,
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=inherited,
        )
    except FileNotFoundError as exc:
        return {
            "ok": False,
            "rc": None,
            "timed_out": False,
            "stderr_tail": f"executable not found: {exc}",
            "detail": "command not on PATH",
        }
    except OSError as exc:
        return {
            "ok": False,
            "rc": None,
            "timed_out": False,
            "stderr_tail": str(exc),
            "detail": "spawn failed",
        }

    try:
        _stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=_TEST_TIMEOUT_SECONDS
        )
        timed_out = False
    except asyncio.TimeoutError:
        proc.kill()
        try:
            _stdout, stderr = await proc.communicate()
        except Exception:
            stderr = b""
        timed_out = True

    stderr_tail = stderr[-_STDERR_TAIL_BYTES:].decode("utf-8", errors="replace")
    rc = proc.returncode
    # Treat a clean timeout as "looks alive" — MCP servers stay running.
    ok = timed_out or rc == 0
    return {
        "ok": ok,
        "rc": rc,
        "timed_out": timed_out,
        "stderr_tail": stderr_tail,
        "detail": "looks alive (timed out)"
        if timed_out
        else ("exited cleanly" if rc == 0 else f"exited with rc={rc}"),
    }


# ---------------------------------------------------------------------------
# Project-scoped resolution
# ---------------------------------------------------------------------------

_VALID_SCOPE_MODES = frozenset({"all", "allowlist", "off"})


async def resolve_enabled_for_project(
    db: aiosqlite.Connection, project_id: int
) -> list[dict[str, Any]]:
    """Return the effective list of MCP servers for a given project.

    Applies ``scope_mode`` semantics:
      - ``'all'``:       the server is included when ``enabled=1``.
      - ``'allowlist'``: included when ``enabled=1`` AND a matching
                         ``mcp_server_project_scopes`` row exists.
      - ``'off'``:       never included, regardless of ``enabled``.
    """
    async with db.execute(
        """
        SELECT s.id, s.slug, s.name, s.command, s.args_json, s.env_json,
               s.enabled, s.source, s.notes, s.created_at, s.updated_at,
               s.scope_mode
        FROM mcp_servers s
        WHERE s.enabled = 1
          AND s.scope_mode != 'off'
        ORDER BY s.name ASC
        """
    ) as cur:
        rows = await cur.fetchall()

    if not rows:
        return []

    # For allowlist servers, fetch which project_ids are permitted.
    allowlist_ids = {int(r["id"]) for r in rows if r["scope_mode"] == "allowlist"}
    permitted: set[int] = set()
    if allowlist_ids:
        placeholders = ",".join("?" * len(allowlist_ids))
        async with db.execute(
            f"SELECT mcp_server_id FROM mcp_server_project_scopes "
            f"WHERE project_id = ? AND mcp_server_id IN ({placeholders})",
            (project_id, *allowlist_ids),
        ) as scur:
            permitted = {int(sr["mcp_server_id"]) for sr in await scur.fetchall()}

    result: list[dict[str, Any]] = []
    for row in rows:
        mode = str(row["scope_mode"])
        server_id = int(row["id"])
        if mode == "allowlist" and server_id not in permitted:
            continue
        d = _row_to_dict(row)
        d["scope_mode"] = mode
        result.append(d)
    return result


async def materialize_mcp_config(
    db: aiosqlite.Connection,
    project_id: int,
    exclude_slugs: list[str] | None = None,
) -> str:
    """Write a Claude Code ``--mcp-config`` JSON file for ``project_id``.

    Returns the absolute path to the written temp file.  The file follows
    the ``{"mcpServers": {slug: {command, args, env}}}`` shape that
    ``claude --mcp-config <path>`` expects.

    ``exclude_slugs`` is an optional list of server slugs to omit from the
    written config.  This is the authoritative per-launch exclusion mechanism:
    the written file is the ground truth of what the
    agent can reach, so exclusions must be applied here — not only on the
    client side — so the disclosure panel never lies.

    The temp directory is ``$TMPDIR/codenest-mcp/``.  The filename encodes
    the project_id and a timestamp so concurrent launches for different
    projects don't collide.  Callers should pass the path via the
    ``{mcp_config}`` placeholder in the provider command template and let
    ``cleanup_old_mcp_configs()`` GC the file after TTL expiry.
    """
    servers = await resolve_enabled_for_project(db, project_id)
    excluded: frozenset[str] = frozenset(exclude_slugs or [])

    mcp_servers_shape: dict[str, Any] = {}
    for srv in servers:
        if srv["slug"] in excluded:
            continue
        entry: dict[str, Any] = {"command": srv["command"]}
        if srv.get("args"):
            entry["args"] = srv["args"]
        env = srv.get("env") or {}
        if env:
            entry["env"] = env
        mcp_servers_shape[srv["slug"]] = entry

    payload = {"mcpServers": mcp_servers_shape}

    # Create the temp dir restricted to the owner (0o700) so secret-bearing
    # config files are never visible to other local users.
    _MCP_TMP_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Deterministic-ish name: project_id + ms timestamp + short hash of content.
    content_bytes = json.dumps(payload, sort_keys=True).encode()
    digest = hashlib.sha256(content_bytes).hexdigest()[:8]
    filename = f"project-{project_id}-{int(time.time() * 1000)}-{digest}.json"
    tmp_path = _MCP_TMP_DIR / filename
    # Write with 0600 (owner read/write only) so secrets are never
    # world-readable regardless of the process umask.
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, json.dumps(payload, indent=2).encode())
    finally:
        os.close(fd)
    logger.debug(
        "materialized mcp config for project %s → %s (%d servers)",
        project_id,
        tmp_path,
        len(mcp_servers_shape),
    )
    return str(tmp_path)


async def set_scope(
    db: aiosqlite.Connection,
    server_id: int,
    mode: str,
    project_ids: list[int],
) -> dict[str, Any]:
    """Set the scope_mode and project allowlist for a server.

    ``project_ids`` is only meaningful when ``mode='allowlist'``; it is
    ignored (and existing rows are cleared) for ``'all'`` and ``'off'``.
    """
    if mode not in _VALID_SCOPE_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"scope_mode must be one of {sorted(_VALID_SCOPE_MODES)}",
        )
    # Verify the server exists.
    await get_server(db, server_id)

    await db.execute(
        "UPDATE mcp_servers SET scope_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (mode, server_id),
    )
    # Always replace the allowlist rows, even when mode != 'allowlist', so
    # switching from allowlist → all doesn't leave stale scope rows.
    await db.execute(
        "DELETE FROM mcp_server_project_scopes WHERE mcp_server_id = ?",
        (server_id,),
    )
    if mode == "allowlist" and project_ids:
        for pid in project_ids:
            await db.execute(
                "INSERT OR IGNORE INTO mcp_server_project_scopes "
                "(mcp_server_id, project_id) VALUES (?, ?)",
                (server_id, pid),
            )
    await db.commit()
    server = await get_server(db, server_id)
    # Attach current project_ids from allowlist table.
    async with db.execute(
        "SELECT project_id FROM mcp_server_project_scopes WHERE mcp_server_id = ?",
        (server_id,),
    ) as cur:
        scope_project_ids = [int(r["project_id"]) for r in await cur.fetchall()]
    server["scope_mode"] = mode
    server["scope_project_ids"] = scope_project_ids
    return server


def cleanup_old_mcp_configs() -> int:
    """Delete materialized MCP config files older than ``_MCP_CONFIG_TTL_SECONDS``.

    Returns the number of files removed.  Called by the schedule tick loop
    so old temp files don't accumulate.  Errors on individual files are
    logged and skipped.
    """
    if not _MCP_TMP_DIR.exists():
        return 0
    cutoff = time.time() - _MCP_CONFIG_TTL_SECONDS
    removed = 0
    for p in _MCP_TMP_DIR.glob("*.json"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed += 1
        except OSError as exc:
            logger.warning("could not remove stale mcp config %s: %s", p, exc)
    return removed


async def register_marketplace_install(
    db: aiosqlite.Connection,
    *,
    slug: str,
    name: str,
    source: str,
    raw_content: str,
    installed_path: str,
) -> dict[str, Any] | None:
    """Best-effort upsert when a marketplace MCP item is installed.

    The bundled catalog stores its server config as JSON inside ``content``;
    parse it to extract command/args/env and create a row. If anything is
    malformed, log and skip — the install itself already succeeded and we
    don't want to fail the user's click.
    """
    try:
        payload = json.loads(raw_content)
    except json.JSONDecodeError as exc:
        logger.warning("mcp catalog content not valid JSON for %s: %s", slug, exc)
        return None
    if not isinstance(payload, dict):
        logger.warning("mcp catalog content for %s is not an object", slug)
        return None
    command = payload.get("command")
    if not isinstance(command, str) or not command:
        logger.warning("mcp catalog content for %s missing command", slug)
        return None
    args = payload.get("args") if isinstance(payload.get("args"), list) else []
    env = payload.get("env") if isinstance(payload.get("env"), dict) else {}

    async with db.execute(
        "SELECT id, notes FROM mcp_servers WHERE slug = ?", (slug,)
    ) as cur:
        row = await cur.fetchone()
    if row is not None:
        # Preserve user-authored notes on re-install.
        existing = str(row["notes"] or "")
        marker = f"re-installed from marketplace at {installed_path}"
        new_notes = f"{existing}\n{marker}" if existing else marker
        return await update_server(db, int(row["id"]), {"notes": new_notes})

    try:
        return await create_server(
            db,
            slug=slug,
            name=name,
            command=command,
            args=args,
            env=env,
            enabled=True,
            source=f"marketplace:{source}",
            notes=f"installed from marketplace at {installed_path}",
        )
    except HTTPException as exc:
        # Two concurrent installs of the same slug raced the UNIQUE
        # constraint; treat the second as a no-op so the user's click
        # doesn't surface a 409 from the registry side.
        if exc.status_code == 409:
            return None
        raise
