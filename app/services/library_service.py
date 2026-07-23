"""Knowledge Base / Context Library backend.

STABLE AGENT API — DO NOT CHANGE WITHOUT A MIGRATION PLAN
==========================================================
The following are part of the @library agent injection contract used by
Claude Code hooks and agent prompt pipelines. They MUST remain stable:

  * Reference syntax : @library:<slug>  (omni-bar and hook pre-processor)
  * Slug regex       : ^[a-z0-9][a-z0-9_-]{0,127}$  (enforced by _SAFE_SLUG)
  * Body cap         : 64 KB UTF-8 bytes             (enforced by MAX_BODY_BYTES)
  * Lookup endpoint  : GET /api/v1/library/by-slug/{slug}

Renaming the "Library" nav label to "Snippets" in the UI does NOT affect any
of the above. These values are part of the public API contract and change only
with a deliberate, versioned migration.
"""

from __future__ import annotations

import json
import re
from typing import Any

import aiosqlite
from fastapi import HTTPException

from ._sql import escape_like as _escape_like

_SAFE_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")

MAX_BODY_BYTES = 64 * 1024
_LIST_LIMIT = 200


_ALLOWED_PATCH_KEYS = frozenset({"title", "body", "tags", "source"})


def _parse_tags(raw: str) -> list[str]:
    try:
        parsed = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    if isinstance(parsed, list) and all(isinstance(t, str) for t in parsed):
        return parsed
    return []


def _validate_tags(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise HTTPException(status_code=400, detail="'tags' must be a list of strings")
    # Dedupe + sort to keep the on-disk JSON canonical.
    return sorted({t.strip() for t in value if t.strip()})


def _validate_slug(value: Any) -> str:
    if not isinstance(value, str) or not _SAFE_SLUG.match(value):
        raise HTTPException(
            status_code=400,
            detail="'slug' must match [a-z0-9][a-z0-9_-]*",
        )
    return value


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    d = dict(row)
    d["tags"] = _parse_tags(str(d.pop("tags_json", "[]")))
    return d


async def list_items(
    db: aiosqlite.Connection,
    q: str | None = None,
    tag: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    where: list[str] = []
    params: list[Any] = []
    if q:
        like = f"%{_escape_like(q.strip())}%"
        where.append(
            "(title LIKE ? ESCAPE '\\' COLLATE NOCASE "
            "OR body LIKE ? ESCAPE '\\' COLLATE NOCASE)"
        )
        params.extend([like, like])
    if tag:
        # Match the JSON-quoted form `"<tag>"` so a substring `foo` doesn't match `foobar`.
        where.append("tags_json LIKE ? ESCAPE '\\'")
        params.append(f'%"{_escape_like(tag)}"%')
    sql = "SELECT * FROM library_items"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC LIMIT ?"
    params.append(max(1, min(limit, _LIST_LIMIT)))
    cur = await db.execute(sql, tuple(params))
    return [_row_to_dict(r) for r in await cur.fetchall()]


async def get_by_id(db: aiosqlite.Connection, item_id: int) -> dict[str, Any]:
    async with db.execute(
        "SELECT * FROM library_items WHERE id = ?", (item_id,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"library item {item_id} not found")
    return _row_to_dict(row)


async def get_by_slug(db: aiosqlite.Connection, slug: str) -> dict[str, Any]:
    _validate_slug(slug)
    async with db.execute("SELECT * FROM library_items WHERE slug = ?", (slug,)) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"library item with slug {slug!r} not found"
        )
    return _row_to_dict(row)


async def create_item(
    db: aiosqlite.Connection,
    *,
    slug: str,
    title: str,
    body: str,
    tags: Any,
    source: str = "manual",
) -> dict[str, Any]:
    slug = _validate_slug(slug)
    if not isinstance(title, str) or not title.strip():
        raise HTTPException(status_code=400, detail="'title' is required")
    if not isinstance(body, str):
        raise HTTPException(status_code=400, detail="'body' must be a string")
    if len(body.encode("utf-8")) > MAX_BODY_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"body exceeds {MAX_BODY_BYTES} bytes",
        )
    tag_list = _validate_tags(tags)
    if not isinstance(source, str):
        raise HTTPException(status_code=400, detail="'source' must be a string")
    try:
        cur = await db.execute(
            """
            INSERT INTO library_items (slug, title, body, tags_json, source)
            VALUES (?, ?, ?, ?, ?)
            """,
            (slug, title.strip(), body, json.dumps(tag_list), source),
        )
    except aiosqlite.IntegrityError as exc:
        raise HTTPException(
            status_code=409, detail=f"slug {slug!r} already exists: {exc}"
        )
    await db.commit()
    new_id = cur.lastrowid
    if new_id is None:
        raise HTTPException(status_code=500, detail="failed to allocate id")
    return await get_by_id(db, new_id)


async def update_item(
    db: aiosqlite.Connection, item_id: int, patch: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(patch, dict):
        raise HTTPException(status_code=400, detail="patch must be an object")
    unknown = set(patch.keys()) - _ALLOWED_PATCH_KEYS
    if unknown:
        raise HTTPException(
            status_code=400, detail=f"unknown patch keys: {sorted(unknown)}"
        )
    current = await get_by_id(db, item_id)
    sets: list[str] = []
    params: list[Any] = []
    if "title" in patch:
        if not isinstance(patch["title"], str) or not patch["title"].strip():
            raise HTTPException(status_code=400, detail="'title' must be non-empty")
        sets.append("title = ?")
        params.append(patch["title"].strip())
    if "body" in patch:
        if not isinstance(patch["body"], str):
            raise HTTPException(status_code=400, detail="'body' must be a string")
        if len(patch["body"].encode("utf-8")) > MAX_BODY_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"body exceeds {MAX_BODY_BYTES} bytes",
            )
        sets.append("body = ?")
        params.append(patch["body"])
    if "tags" in patch:
        sets.append("tags_json = ?")
        params.append(json.dumps(_validate_tags(patch["tags"])))
    if "source" in patch:
        if not isinstance(patch["source"], str):
            raise HTTPException(status_code=400, detail="'source' must be a string")
        sets.append("source = ?")
        params.append(patch["source"])
    if not sets:
        return current
    sets.append("updated_at = CURRENT_TIMESTAMP")
    params.append(item_id)
    await db.execute(
        f"UPDATE library_items SET {', '.join(sets)} WHERE id = ?", tuple(params)
    )
    await db.commit()
    return await get_by_id(db, item_id)


async def delete_item(db: aiosqlite.Connection, item_id: int) -> dict[str, Any]:
    await get_by_id(db, item_id)
    await db.execute("DELETE FROM library_items WHERE id = ?", (item_id,))
    await db.commit()
    return {"id": item_id, "deleted": True}
