"""Browser/preview pane backend."""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import urlsplit

import aiosqlite
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Loopback-only probe targets. A hardcoded allow-list so a misconfig
# can't scan the LAN — every port here is a well-known frontend dev
# server default.
_DEV_PORT_CANDIDATES: tuple[int, ...] = (1420, 3000, 4321, 5173, 8080)

# Bound a single dev-server probe; this is the *only* thing waiting on
# the user's local machine, so a slow port shouldn't gate the others.
_PROBE_TIMEOUT_SECONDS = 0.4

# Cap stored URLs to a reasonable line length; refuse anything obviously
# pathological without trying to parse-validate (the WebView itself will
# reject garbage at navigation time).
MAX_URL_BYTES = 8 * 1024


def _is_safe_url(url: str) -> bool:
    """Reject obviously malformed URLs at the API boundary."""
    if not isinstance(url, str) or not url.strip():
        return False
    if len(url.encode("utf-8")) > MAX_URL_BYTES:
        return False
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    # `file://` is intentionally rejected: a Tauri WebView document at a
    # file URL can fetch other local files without an SOP boundary, which
    # combined with a permissive sandbox would let a malicious preview
    # exfiltrate `~/.ssh/id_rsa` and similar. Re-enable behind explicit
    # user confirmation + project-root prefix in a follow-up IDEA.
    return parts.scheme in {"http", "https", "data"}


async def _probe_port(port: int) -> bool:
    """Return True if a TCP connect to 127.0.0.1:<port> succeeds within
    the probe timeout. We deliberately don't speak HTTP — a successful
    TCP handshake is enough to claim "something is listening here."
    """
    try:
        fut = asyncio.open_connection("127.0.0.1", port)
        reader, writer = await asyncio.wait_for(fut, timeout=_PROBE_TIMEOUT_SECONDS)
    except (OSError, asyncio.TimeoutError):
        return False
    writer.close()
    try:
        await writer.wait_closed()
    except Exception:
        pass
    return True


async def detect_dev_server() -> dict[str, Any]:
    """Return the first reachable dev port from the allow-list, or None.

    The probes run concurrently so the total latency is one timeout
    instead of N.
    """
    results = await asyncio.gather(*(_probe_port(p) for p in _DEV_PORT_CANDIDATES))
    for port, ok in zip(_DEV_PORT_CANDIDATES, results, strict=True):
        if ok:
            return {"port": port, "url": f"http://127.0.0.1:{port}"}
    return {"port": None, "url": None}


async def list_visits(
    db: aiosqlite.Connection, limit: int = 50
) -> list[dict[str, Any]]:
    cur = await db.execute(
        """
        SELECT id, url, title, visited_at
        FROM preview_visits
        ORDER BY visited_at DESC
        LIMIT ?
        """,
        (max(1, min(limit, 200)),),
    )
    return [dict(r) for r in await cur.fetchall()]


async def record_visit(
    db: aiosqlite.Connection, url: str, title: str | None
) -> dict[str, Any]:
    if not _is_safe_url(url):
        raise HTTPException(
            status_code=400,
            detail="url must be a non-empty http/https/file/data string ≤ 8 KB",
        )
    if title is not None and not isinstance(title, str):
        raise HTTPException(status_code=400, detail="'title' must be a string or null")
    cur = await db.execute(
        "INSERT INTO preview_visits (url, title) VALUES (?, ?)",
        (url.strip(), (title or "").strip() or None),
    )
    await db.commit()
    new_id = cur.lastrowid
    if new_id is None:
        raise HTTPException(status_code=500, detail="failed to allocate visit id")
    async with db.execute(
        "SELECT id, url, title, visited_at FROM preview_visits WHERE id = ?",
        (new_id,),
    ) as q:
        row = await q.fetchone()
    assert row is not None
    return dict(row)
