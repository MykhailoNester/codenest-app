"""Schema-driven taxonomies.

The ``taxonomies`` table maps ``(kind, slug)`` to a user-editable
``display_name`` + ``sort_order``. Slugs stay stable on disk so existing
queries, FKs, and blocker cascades keep working; only the display label
and ordering are user-editable. New slugs can be added at runtime (the
CHECK constraints on tasks/workflow_items.status/priority were dropped
in migration 027).

All callers pass the shared aiosqlite connection from ``get_db()``.
"""

from __future__ import annotations

import re
from typing import Any

import aiosqlite
from fastapi import HTTPException

VALID_KINDS: frozenset[str] = frozenset(
    {"task_status", "task_priority", "workflow_status", "workflow_priority"}
)

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def _validate_kind(kind: str) -> None:
    if kind not in VALID_KINDS:
        raise HTTPException(status_code=400, detail=f"unknown taxonomy kind: {kind!r}")


def _validate_slug(slug: str) -> None:
    if not _SLUG_RE.match(slug):
        raise HTTPException(
            status_code=400,
            detail="slug must match ^[a-z0-9][a-z0-9-]*$",
        )


async def list_all(db: aiosqlite.Connection) -> list[dict[str, Any]]:
    """Return every row grouped by kind for the Settings page."""
    async with db.execute(
        "SELECT id, kind, slug, display_name, sort_order, color, "
        "is_default, is_active FROM taxonomies ORDER BY kind, sort_order, id"
    ) as cur:
        rows = await cur.fetchall()
    return [_row_to_dict(r) for r in rows]


async def list_by_kind(
    db: aiosqlite.Connection, kind: str, include_inactive: bool = False
) -> list[dict[str, Any]]:
    _validate_kind(kind)
    sql = (
        "SELECT id, kind, slug, display_name, sort_order, color, "
        "is_default, is_active FROM taxonomies WHERE kind = ?"
    )
    params: list[Any] = [kind]
    if not include_inactive:
        sql += " AND is_active = 1"
    sql += " ORDER BY sort_order, id"
    async with db.execute(sql, params) as cur:
        rows = await cur.fetchall()
    return [_row_to_dict(r) for r in rows]


async def create(db: aiosqlite.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    kind = str(payload["kind"])
    slug = str(payload["slug"])
    _validate_kind(kind)
    _validate_slug(slug)
    display_name = str(payload.get("display_name") or slug).strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="display_name required")
    try:
        sort_order = int(payload.get("sort_order", 9999))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="sort_order must be an integer")
    color = payload.get("color")
    # If a soft-deleted row already owns this (kind, slug), reactivate it
    # instead of letting the UNIQUE constraint surface as a 500. This makes
    # "deactivate then re-add" reversible from the UI.
    async with db.execute(
        "SELECT id, is_active FROM taxonomies WHERE kind = ? AND slug = ?",
        (kind, slug),
    ) as cur:
        existing = await cur.fetchone()
    if existing is not None:
        if existing["is_active"]:
            raise HTTPException(
                status_code=409,
                detail=f"taxonomy entry already exists: {kind}/{slug}",
            )
        await db.execute(
            "UPDATE taxonomies SET display_name = ?, sort_order = ?, color = ?, "
            "is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (display_name, sort_order, color, existing["id"]),
        )
        await db.commit()
        return await _fetch(db, int(existing["id"]))
    cur = await db.execute(
        "INSERT INTO taxonomies (kind, slug, display_name, sort_order, color, is_default) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        (kind, slug, display_name, sort_order, color),
    )
    await db.commit()
    return await _fetch(db, int(cur.lastrowid or 0))


async def update(
    db: aiosqlite.Connection, taxonomy_id: int, patch: dict[str, Any]
) -> dict[str, Any]:
    """Update display_name, sort_order, color, is_active. Slug is immutable.

    Slug-immutable means renames are always cascade-safe: no task or
    workflow row references this row by slug except through its own
    ``status``/``priority`` text column, which stores the slug, not the
    display name.
    """
    existing = await _fetch(db, taxonomy_id)
    if any(immutable in patch for immutable in ("slug", "kind", "is_default")):
        raise HTTPException(
            status_code=400, detail="slug, kind, and is_default are immutable"
        )
    allowed = {"display_name", "sort_order", "color", "is_active"}
    unknown = set(patch.keys()) - allowed
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"unknown fields: {sorted(unknown)}"
        )
    updates: list[str] = []
    params: list[Any] = []
    for key in allowed:
        if key not in patch:
            continue
        value = patch[key]
        if key == "display_name":
            value = str(value).strip()
            if not value:
                raise HTTPException(status_code=400, detail="display_name required")
        if key == "is_active":
            value = 1 if value else 0
        if key == "sort_order":
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise HTTPException(
                    status_code=400, detail="sort_order must be an integer"
                )
        updates.append(f"{key} = ?")
        params.append(value)
    if not updates:
        return existing
    updates.append("updated_at = CURRENT_TIMESTAMP")
    params.append(taxonomy_id)
    await db.execute(
        f"UPDATE taxonomies SET {', '.join(updates)} WHERE id = ?",
        params,
    )
    await db.commit()
    return await _fetch(db, taxonomy_id)


async def reorder(
    db: aiosqlite.Connection, kind: str, ordered_ids: list[int]
) -> list[dict[str, Any]]:
    """Apply a new sort order across all entries of ``kind``.

    The supplied list defines the new order; each entry receives
    ``sort_order = index * 10`` so insertions later still fit cleanly.
    """
    _validate_kind(kind)
    # Validate every id belongs to ``kind`` before mutating anything so a
    # bad id can't leave the table in a partially-reordered state.
    if ordered_ids:
        placeholders = ",".join("?" for _ in ordered_ids)
        async with db.execute(
            f"SELECT id FROM taxonomies WHERE kind = ? AND id IN ({placeholders})",
            (kind, *ordered_ids),
        ) as cur:
            present = {row["id"] for row in await cur.fetchall()}
        missing = [tid for tid in ordered_ids if tid not in present]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"ids do not belong to {kind}: {missing}",
            )
    try:
        await db.execute("BEGIN")
        for idx, tid in enumerate(ordered_ids):
            await db.execute(
                "UPDATE taxonomies SET sort_order = ?, updated_at = CURRENT_TIMESTAMP "
                "WHERE id = ? AND kind = ?",
                (idx * 10, int(tid), kind),
            )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return await list_by_kind(db, kind, include_inactive=True)


async def delete(db: aiosqlite.Connection, taxonomy_id: int) -> None:
    """Soft-delete: flips is_active=0. Default rows cannot be deleted.

    A real DELETE could orphan rows that still carry the slug; flipping
    is_active preserves history and lets the UI grey out the value.
    """
    existing = await _fetch(db, taxonomy_id)
    if existing["is_default"]:
        raise HTTPException(
            status_code=400,
            detail="default taxonomy entries cannot be deleted; deactivate instead",
        )
    await db.execute(
        "UPDATE taxonomies SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        (taxonomy_id,),
    )
    await db.commit()


async def _fetch(db: aiosqlite.Connection, taxonomy_id: int) -> dict[str, Any]:
    async with db.execute(
        "SELECT id, kind, slug, display_name, sort_order, color, "
        "is_default, is_active FROM taxonomies WHERE id = ?",
        (taxonomy_id,),
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="taxonomy entry not found")
    return _row_to_dict(row)


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "slug": row["slug"],
        "display_name": row["display_name"],
        "sort_order": row["sort_order"],
        "color": row["color"],
        "is_default": bool(row["is_default"]),
        "is_active": bool(row["is_active"]),
    }
