import os
from datetime import datetime

import aiosqlite

from ._sql import build_update
from .activity_service import log_activity


async def get_all_documents(
    db: aiosqlite.Connection, category_filter: str = ""
) -> list[dict]:
    if category_filter:
        cursor = await db.execute(
            "SELECT d.*, m.name as author_name FROM documents d LEFT JOIN members m ON d.author_id = m.id WHERE d.category = ? ORDER BY d.created_at DESC",
            (category_filter,),
        )
    else:
        cursor = await db.execute(
            "SELECT d.*, m.name as author_name FROM documents d LEFT JOIN members m ON d.author_id = m.id ORDER BY d.category, d.created_at DESC"
        )
    rows = await cursor.fetchall()
    result = []
    for row in rows:
        d = dict(row)
        d["exists"] = os.path.exists(d.get("file_path") or "")
        result.append(d)
    return result


async def validate_document(db: aiosqlite.Connection, doc_id: int) -> dict | None:
    cursor = await db.execute("SELECT * FROM documents WHERE id = ?", (doc_id,))
    row = await cursor.fetchone()
    if row is None:
        return None
    doc = dict(row)
    file_path = doc.get("file_path") or ""
    exists = os.path.exists(file_path)
    size_bytes = 0
    mtime = None
    if exists:
        stat = os.stat(file_path)
        size_bytes = stat.st_size
        mtime = datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")  # noqa: DTZ006
    return {
        "id": doc_id,
        "file_path": file_path,
        "exists": exists,
        "size_bytes": size_bytes,
        "mtime": mtime,
    }


async def create_document(db: aiosqlite.Connection, data: dict) -> int:
    cursor = await db.execute(
        "INSERT INTO documents (title, category, file_path, author_id, task_id, summary) VALUES (?, ?, ?, ?, ?, ?)",
        (
            data["title"],
            data["category"],
            data["file_path"],
            data.get("author_id"),
            data.get("task_id"),
            data.get("summary"),
        ),
    )
    await db.commit()
    doc_id = cursor.lastrowid
    assert doc_id is not None
    # documents have no project_id today, so the audit-feed row
    # keeps project_id NULL. Update here if a project column is added.
    await log_activity(db, "document", doc_id, "created", new_value=data["title"])
    return doc_id


async def update_document(db: aiosqlite.Connection, doc_id: int, data: dict):
    sql, params = build_update(
        "documents",
        data,
        {"title", "category", "file_path", "summary", "author_id", "task_id"},
    )
    if not sql:
        return
    params.append(doc_id)
    await db.execute(sql, params)
    await db.commit()
    await log_activity(
        db,
        "document",
        doc_id,
        "updated",
        new_value=data.get("file_path") or data.get("title"),
    )


async def delete_document(db: aiosqlite.Connection, doc_id: int):
    row = await db.execute("SELECT * FROM documents WHERE id = ?", (doc_id,))
    doc = await row.fetchone()
    if doc:
        await db.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        await db.commit()
        await log_activity(db, "document", doc_id, "deleted", old_value=doc["title"])
