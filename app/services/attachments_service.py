"""Multimodal attachment storage.

v1 keeps file bytes base64-encoded inside SQLite. Acceptable for the
push-to-talk + drag-drop happy path (small images, short PDFs, short
audio clips). Filed as a follow-up to move to content-addressed
filesystem storage when accumulation justifies the change.
"""

from __future__ import annotations

import base64
import binascii
import logging
import re
from typing import Any

import aiosqlite
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Cap a single attachment at 8 MB raw. The base64 encoding inflates this
# by ~33 %, so the stored TEXT is bounded at roughly 10.7 MB per row.
MAX_RAW_BYTES = 8 * 1024 * 1024

# Filenames are user-supplied; restrict to a safe charset so a malformed
# header doesn't poison the row.
_SAFE_FILENAME = re.compile(r"^[\w. \-+()@\[\]]+$")

# MIME types we attempt to text-extract inline. Everything else stores
# bytes verbatim with extracted_text=None.
_TEXT_MIME_PREFIXES: tuple[str, ...] = ("text/", "application/json", "application/xml")

_LIST_LIMIT = 200


def _row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
    return dict(row)


def _is_text_mime(mime: str) -> bool:
    return any(mime.startswith(p) for p in _TEXT_MIME_PREFIXES)


def _validate_filename(name: str) -> str:
    if not isinstance(name, str) or not name.strip():
        raise HTTPException(status_code=400, detail="'filename' is required")
    cleaned = name.strip()
    if not _SAFE_FILENAME.match(cleaned):
        raise HTTPException(
            status_code=400,
            detail="filename must match [A-Za-z0-9 ._\\-+()@\\[\\]]+",
        )
    # The field is text-only today, but reject `..` and path separators so a
    # future download/export route can't be coerced into traversal.
    if ".." in cleaned or "/" in cleaned or "\\" in cleaned:
        raise HTTPException(
            status_code=400, detail="filename must not contain '..', '/', or '\\\\'"
        )
    return cleaned


def _validate_mime(mime: str) -> str:
    if not isinstance(mime, str) or "/" not in mime or len(mime) > 200:
        raise HTTPException(status_code=400, detail="'mime_type' is malformed")
    return mime


def _decode_content(content_b64: str) -> bytes:
    if not isinstance(content_b64, str):
        raise HTTPException(status_code=400, detail="'content_b64' must be a string")
    try:
        raw = base64.b64decode(content_b64, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=400, detail=f"invalid base64: {exc}")
    if len(raw) > MAX_RAW_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"attachment exceeds {MAX_RAW_BYTES} bytes raw",
        )
    return raw


async def create_attachment(
    db: aiosqlite.Connection,
    *,
    filename: str,
    mime_type: str,
    content_b64: str,
    inbox_item_id: int | None = None,
) -> dict[str, Any]:
    fn = _validate_filename(filename)
    mt = _validate_mime(mime_type)
    raw = _decode_content(content_b64)

    extracted: str | None = None
    if _is_text_mime(mt):
        try:
            extracted = raw.decode("utf-8")
        except UnicodeDecodeError:
            # Mislabelled text — store the bytes but leave extraction NULL.
            logger.info(
                "attachment %r mime=%s not valid utf-8; skipping extract", fn, mt
            )
            extracted = None

    cur = await db.execute(
        """
        INSERT INTO attachments
            (filename, mime_type, size_bytes, content_b64, extracted_text, inbox_item_id)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (fn, mt, len(raw), content_b64, extracted, inbox_item_id),
    )
    await db.commit()
    new_id = cur.lastrowid
    if new_id is None:
        raise HTTPException(status_code=500, detail="failed to allocate attachment id")
    return await get_attachment(db, new_id, include_content=False)


async def get_attachment(
    db: aiosqlite.Connection,
    attachment_id: int,
    *,
    include_content: bool = False,
) -> dict[str, Any]:
    cols = (
        "id, filename, mime_type, size_bytes, extracted_text, inbox_item_id, created_at"
    )
    if include_content:
        cols += ", content_b64"
    async with db.execute(
        f"SELECT {cols} FROM attachments WHERE id = ?", (attachment_id,)
    ) as cur:
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(
            status_code=404, detail=f"attachment {attachment_id} not found"
        )
    return _row_to_dict(row)


async def list_attachments(
    db: aiosqlite.Connection, limit: int = 50
) -> list[dict[str, Any]]:
    # Deliberately omit `extracted_text` from the list payload — a future OCR
    # result on a 10 MB image would bloat the response. Single-row GET still
    # returns it.
    cur = await db.execute(
        """
        SELECT id, filename, mime_type, size_bytes,
               inbox_item_id, created_at
        FROM attachments
        ORDER BY id DESC
        LIMIT ?
        """,
        (max(1, min(limit, _LIST_LIMIT)),),
    )
    return [_row_to_dict(r) for r in await cur.fetchall()]
