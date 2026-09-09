"""Project roots: directories under which each git repo is its own project.

A root is user-owned state (`enabled`, and later a `label`), not a value
derived from the current `projects` table — a derived view could not be
disabled, could not hold a `manual` root ahead of any project living under
it, and would silently change meaning every time a project is imported or
removed. `migrations/010_project_roots.sql` owns the one-time SQL seed from
directories that already parent two or more imported non-workspace
projects; this module owns everything after that: listing, adding,
enabling/disabling and removing a root.

Every stored path is `os.path.realpath`-resolved and has no trailing slash,
matching the discipline `attribution_service.resolve_path_to_project` already
applies to `projects.root_path` — a later prefix-match consumer can compare
two stored roots (or a root against a resolved cwd) with plain string
operations and get a total order, without re-resolving anything itself.

`source` has no `CHECK` on the table (see the migration's header comment),
so this module validates it against `_VALID_SOURCES` before it ever reaches
SQL.

The consumer of these rows is `cwd_resolver_service`: a session whose git
repo sits under an enabled root but matches no project gets a
`status='discovered'` project created for that repo.
`attribution_service.resolve_path_to_project` (per-event attribution) does
not read roots and is unaffected.
"""

from __future__ import annotations

import os
from typing import Any

import aiosqlite

_VALID_SOURCES: frozenset[str] = frozenset({"seeded", "manual", "discovered"})


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "path": row["path"],
        "label": row["label"],
        "source": row["source"],
        "enabled": bool(row["enabled"]),
        "created_at": row["created_at"],
    }


def _normalize_path(raw: str) -> str:
    """Validate and canonicalise a candidate root path.

    Raises `ValueError` for: an empty/blank path, a non-absolute path (no
    `expanduser` — `~/x` is rejected deliberately, the caller must resolve
    the user's home directory itself), a resolved path that is the
    filesystem root, or a resolved path that is not an existing directory.
    Returns the `realpath`-resolved, trailing-slash-free path to store.
    """
    candidate = (raw or "").strip()
    if not candidate:
        raise ValueError("root path is required")
    if not os.path.isabs(candidate):
        raise ValueError(f"root path must be absolute: {candidate!r}")
    resolved = os.path.realpath(candidate).rstrip("/")
    if not resolved:
        raise ValueError("filesystem root cannot be a project root")
    if not os.path.isdir(resolved):
        raise ValueError(f"root path is not an existing directory: {resolved}")
    return resolved


async def list_roots(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    """Return every root, ordered by path. `path` is UNIQUE, so this order
    is total and stable across calls. No filtering by `enabled` — callers
    decide what to do with a disabled root."""
    async with db.execute(
        "SELECT id, path, label, source, enabled, created_at "
        "FROM project_roots ORDER BY path ASC"
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_dict(row) for row in rows]


async def add_root(
    db: aiosqlite.Connection,
    path: str,
    *,
    label: str | None = None,
    source: str = "manual",
) -> dict[str, Any]:
    """Add a new root. Raises `ValueError` for an unknown `source`, an
    unusable `path` (see `_normalize_path`), or a path that is already a
    root — a duplicate is rejected loudly rather than silently ignored via
    `INSERT OR IGNORE`, so a caller can never mistake "already there" for
    "added"."""
    if source not in _VALID_SOURCES:
        raise ValueError(f"unknown root source: {source!r}")
    stored = _normalize_path(path)

    async with db.execute(
        "SELECT id FROM project_roots WHERE path = ?", (stored,)
    ) as cur:
        existing = await cur.fetchone()
    if existing is not None:
        raise ValueError(f"root already exists: {stored}")

    normalized_label = label.strip() or None if label is not None else None
    try:
        cur = await db.execute(
            "INSERT INTO project_roots (path, label, source, enabled) "
            "VALUES (?, ?, ?, 1)",
            (stored, normalized_label, source),
        )
    except aiosqlite.IntegrityError as exc:
        # Closes the await-gap race between the existence check above and
        # this insert on the single shared connection: two interleaved
        # `add_root` calls for the same path give one row and one clean
        # `ValueError`, never a raw IntegrityError traceback.
        raise ValueError(f"root already exists: {stored}") from exc
    await db.commit()

    async with db.execute(
        "SELECT id, path, label, source, enabled, created_at "
        "FROM project_roots WHERE id = ?",
        (cur.lastrowid,),
    ) as select_cur:
        row = await select_cur.fetchone()
    if row is None:
        raise RuntimeError(f"root {stored!r} vanished immediately after insert")
    return _row_to_dict(row)


async def set_enabled(
    db: aiosqlite.Connection, root_id: int, enabled: bool
) -> dict[str, Any]:
    """Flip a root's `enabled` flag. Raises `ValueError` for an unknown
    `root_id` — unlike `remove_root`, a toggle that silently no-ops on a
    missing id would be a UI lie."""
    async with db.execute(
        "SELECT id FROM project_roots WHERE id = ?", (root_id,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise ValueError(f"project root {root_id} not found")

    await db.execute(
        "UPDATE project_roots SET enabled = ? WHERE id = ?",
        (1 if enabled else 0, root_id),
    )
    await db.commit()

    async with db.execute(
        "SELECT id, path, label, source, enabled, created_at "
        "FROM project_roots WHERE id = ?",
        (root_id,),
    ) as select_cur:
        updated = await select_cur.fetchone()
    if updated is None:
        raise RuntimeError(f"project root {root_id} vanished immediately after update")
    return _row_to_dict(updated)


async def remove_root(db: aiosqlite.Connection, root_id: int) -> bool:
    """Delete a root. Idempotent: returns `False` for an unknown `root_id`
    instead of raising, since a delete that no-ops on a missing row is
    desirable (a double-click or a concurrent removal), unlike `set_enabled`
    above."""
    cur = await db.execute("DELETE FROM project_roots WHERE id = ?", (root_id,))
    await db.commit()
    return cur.rowcount > 0
