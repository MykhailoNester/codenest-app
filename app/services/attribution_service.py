"""Per-project cost attribution for Command Center sessions.

A workspace-root session can touch many projects, so a session-level
``project_id`` is too coarse. This module resolves the project behind each
file-touching tool call and distributes a turn's cost across the projects
actually touched.

Flow:
  * ``record_post_tool`` calls :func:`extract_touched_path` +
    :func:`resolve_path_to_project` to tag each ``agent_events`` row.
  * ``record_stop`` calls :func:`attribute_turn_cost` with the turn's cost; it
    splits the cost across the distinct projects tagged on this turn's events
    (proportional to touch count), falling back to the session's bucket project
    and finally to the workspace project.
"""

from __future__ import annotations

import os
from typing import Any

import aiosqlite

# Tools whose input names a single file we can map to a project.
_FILE_TOOLS = {"read", "edit", "write", "notebookedit"}


def extract_touched_path(
    tool_name: str | None, tool_input: Any, cwd: str | None = None
) -> str | None:
    """Return the path a tool acted on, or ``None`` if not applicable.

    File tools (Read/Edit/Write/NotebookEdit) carry the path in
    ``tool_input.file_path``. Bash has no file path, so we fall back to the
    session ``cwd`` (a top-level hook-payload field, NOT inside ``tool_input``)
    so its work lands on the project the session is rooted in.
    """
    if not isinstance(tool_input, dict):
        return None
    name = (tool_name or "").lower()
    if name in _FILE_TOOLS:
        fp = tool_input.get("file_path")
        return fp if isinstance(fp, str) and fp.strip() else None
    if name == "bash":
        return cwd if isinstance(cwd, str) and cwd.strip() else None
    return None


async def resolve_path_to_project(
    db: aiosqlite.Connection, file_path: str | None
) -> int | None:
    """Map a filesystem path to an imported project's id, or ``None``.

    The path is resolved with ``os.path.realpath`` so a file edited through a
    workspace symlink resolves back to its real project root. Matching is by
    longest ``root_path`` prefix; the synthetic workspace project is excluded so
    workspace-root paths fall through to ``None`` (unmatched → workspace rollup
    happens in :func:`attribute_turn_cost`).
    """
    if not file_path:
        return None
    try:
        real = os.path.realpath(file_path)
    except OSError:
        real = file_path
    cur = await db.execute(
        "SELECT id, root_path FROM projects "
        "WHERE is_workspace = 0 AND root_path IS NOT NULL AND root_path != '' "
        "ORDER BY LENGTH(root_path) DESC"
    )
    for row in await cur.fetchall():
        root = str(row["root_path"]).rstrip("/")
        if root and (real == root or real.startswith(root + "/")):
            return int(row["id"])
    return None


async def _workspace_project_id(db: aiosqlite.Connection) -> int | None:
    cur = await db.execute("SELECT id FROM projects WHERE is_workspace = 1")
    row = await cur.fetchone()
    return int(row["id"]) if row else None


async def attribute_turn_cost(
    db: aiosqlite.Connection,
    session_id: str,
    cost_usd: float,
    tokens_in: int,
    tokens_out: int,
) -> None:
    """Distribute a turn's cost across the projects touched this turn.

    "This turn" = ``agent_events`` for the session created after the previous
    Stop event. Cost/tokens are split in proportion to per-project touch count.
    When no file-touch resolved to a project, the whole turn falls back to the
    session's bucket project, and finally to the workspace project. Caller must
    invoke this BEFORE appending the current turn's Stop event so the turn
    boundary is correct. Does not commit — the caller's transaction owns it.
    """
    if cost_usd <= 0 and tokens_in == 0 and tokens_out == 0:
        return

    cur = await db.execute(
        "SELECT COALESCE(MAX(id), 0) AS prev FROM agent_events "
        "WHERE session_id = ? AND event_type = 'Stop'",
        (session_id,),
    )
    prow = await cur.fetchone()
    prev_stop = prow["prev"] if prow else 0

    cur = await db.execute(
        "SELECT project_id, COUNT(*) AS touches FROM agent_events "
        "WHERE session_id = ? AND id > ? AND project_id IS NOT NULL "
        "GROUP BY project_id",
        (session_id, prev_stop),
    )
    touches = {int(r["project_id"]): int(r["touches"]) for r in await cur.fetchall()}

    if not touches:
        # No resolved file-touch this turn: fall back to the session's bucket
        # project, then to the workspace project (unmatched rollup).
        cur = await db.execute(
            "SELECT project_id FROM agent_sessions WHERE session_id = ?",
            (session_id,),
        )
        row = await cur.fetchone()
        bucket = row["project_id"] if row and row["project_id"] is not None else None
        if bucket is None:
            bucket = await _workspace_project_id(db)
        if bucket is None:
            return
        touches = {int(bucket): 1}

    # Per-project token sums are approximate (independent rounding per project
    # can drift by a few tokens on non-divisible splits); agent_sessions remains
    # the canonical session total. cost_usd is float and sums exactly.
    total = sum(touches.values())
    for project_id, count in touches.items():
        frac = count / total
        await db.execute(
            "INSERT INTO session_project_costs "
            "(session_id, project_id, tokens_in, tokens_out, cost_usd, updated_at) "
            "VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(session_id, project_id) DO UPDATE SET "
            "tokens_in = tokens_in + excluded.tokens_in, "
            "tokens_out = tokens_out + excluded.tokens_out, "
            "cost_usd = cost_usd + excluded.cost_usd, "
            "updated_at = excluded.updated_at",
            (
                session_id,
                project_id,
                int(round(tokens_in * frac)),
                int(round(tokens_out * frac)),
                cost_usd * frac,
            ),
        )
