"""Shared project-root resolution.

Services that need to write into a user's project tree (markdown editor,
marketplace installs, future plugin installs) all need the same path-safety
check: project row exists, ``path`` column is absolute, resolves to a real
directory on disk. Centralised here so every caller gets the same threat
model and error shape.
"""

from __future__ import annotations

from pathlib import Path

import aiosqlite
from fastapi import HTTPException


async def resolve_project_root(db: aiosqlite.Connection, project_id: int) -> Path:
    async with db.execute(
        "SELECT path FROM projects WHERE id = ?", (project_id,)
    ) as cur:
        row = await cur.fetchone()
    if row is None or not row["path"]:
        raise HTTPException(
            status_code=404,
            detail=f"project {project_id} not found or has no path",
        )
    raw_path = Path(str(row["path"]))
    if not raw_path.is_absolute():
        raise HTTPException(
            status_code=400,
            detail=f"project {project_id} path is not absolute: {raw_path}",
        )
    try:
        resolved = raw_path.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(
            status_code=500, detail=f"cannot resolve project path: {exc}"
        )
    if not resolved.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"project {project_id} root does not exist: {resolved}",
        )
    return resolved
