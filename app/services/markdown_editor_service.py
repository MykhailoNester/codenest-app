"""Visual CLAUDE.md / AGENTS.md editor backend.

Scoped tightly: only resolves to ``{project.path}/CLAUDE.md`` or
``{project.path}/AGENTS.md``. Path traversal, symlink escapes, and
arbitrary project paths are rejected. Writes carry an
``expected_sha`` for optimistic concurrency so two editors can't
silently clobber each other.
"""

from __future__ import annotations

import difflib
import hashlib
import os
from pathlib import Path
from typing import Any, Literal

import aiosqlite
from fastapi import HTTPException

from ._project_paths import resolve_project_root

EditorKind = Literal["claude", "agents"]
_FILENAMES: dict[str, str] = {"claude": "CLAUDE.md", "agents": "AGENTS.md"}

# Cap content at 1 MB so a runaway client can't OOM the sidecar.
MAX_CONTENT_BYTES = 1024 * 1024


def _validate_kind(kind: str) -> EditorKind:
    if kind not in _FILENAMES:
        raise HTTPException(
            status_code=400,
            detail=f"unknown kind {kind!r}; expected one of {sorted(_FILENAMES)}",
        )
    return kind  # type: ignore[return-value]


def _target_path(project_root: Path, kind: EditorKind) -> Path:
    """Resolve and validate the markdown file path under ``project_root``.

    Rejects symlinks (so a user can't point ``CLAUDE.md`` at ``/etc/shadow``)
    and any path that resolves outside ``project_root``.
    """
    candidate = project_root / _FILENAMES[kind]
    # Resolve the parent (which must exist for any meaningful edit) but
    # tolerate the file itself not existing yet for new docs.
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError) as exc:
        raise HTTPException(status_code=500, detail=f"path resolve failed: {exc}")
    # Ensure resolved is inside project_root.
    try:
        resolved.relative_to(project_root)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="resolved markdown file escapes the project root (symlink?)",
        )
    if candidate.is_symlink():
        raise HTTPException(status_code=400, detail="symlinked targets are not allowed")
    return resolved


def _sha(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


async def read(db: aiosqlite.Connection, project_id: int, kind: str) -> dict[str, Any]:
    resolved_kind = _validate_kind(kind)
    project_root = await resolve_project_root(db, project_id)
    target = _target_path(project_root, resolved_kind)
    if not target.exists():
        return {
            "project_id": project_id,
            "kind": resolved_kind,
            "path": str(target),
            "exists": False,
            "content": "",
            "sha": _sha(""),
        }
    if not target.is_file():
        raise HTTPException(
            status_code=400, detail=f"{target} exists but is not a file"
        )
    try:
        content = target.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"read failed: {exc}")
    return {
        "project_id": project_id,
        "kind": resolved_kind,
        "path": str(target),
        "exists": True,
        "content": content,
        "sha": _sha(content),
    }


async def diff(
    db: aiosqlite.Connection, project_id: int, kind: str, new_content: str
) -> dict[str, Any]:
    if len(new_content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"content exceeds {MAX_CONTENT_BYTES} bytes",
        )
    current = await read(db, project_id, kind)
    old_lines = current["content"].splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    fromfile = current["path"] + " (current)"
    tofile = current["path"] + " (proposed)"
    diff_lines = list(
        difflib.unified_diff(old_lines, new_lines, fromfile=fromfile, tofile=tofile)
    )
    return {
        "project_id": project_id,
        "kind": current["kind"],
        "path": current["path"],
        "unified_diff": "".join(diff_lines),
        "current_sha": current["sha"],
        "proposed_sha": _sha(new_content),
        "no_op": current["content"] == new_content,
    }


async def write(
    db: aiosqlite.Connection,
    project_id: int,
    kind: str,
    content: str,
    expected_sha: str | None,
) -> dict[str, Any]:
    """Persist ``content`` to disk after an optimistic-concurrency check.

    If ``expected_sha`` is provided and does not match the current
    on-disk sha, returns 409 so the client can re-fetch and merge.
    Passing ``None`` opts out of the check (e.g. creating a brand-new
    file where the client has not seen any prior content).
    """
    if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"content exceeds {MAX_CONTENT_BYTES} bytes",
        )
    current = await read(db, project_id, kind)
    if expected_sha is not None and expected_sha != current["sha"]:
        raise HTTPException(
            status_code=409,
            detail="on-disk content changed since you started editing; refresh and retry",
        )
    target = Path(current["path"])
    # Ensure parent dir exists; we never mkdir outside the project root because
    # _target_path already constrained the resolved location.
    target.parent.mkdir(parents=True, exist_ok=True)
    # Atomic-ish write: write to a sibling .tmp then rename so we never
    # leave a half-written file if the process dies mid-write.
    tmp = target.with_name(target.name + ".tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, target)
    except OSError as exc:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise HTTPException(status_code=500, detail=f"write failed: {exc}")
    return {
        "project_id": project_id,
        "kind": current["kind"],
        "path": str(target),
        "exists": True,
        "content": content,
        "sha": _sha(content),
    }
