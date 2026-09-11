"""Profiles service.

CRUD over the `profiles` table. A profile represents a named Claude
session context (work, personal, client-X, …) — it carries a color,
icon, optional cwd hint, an env-var blob for future terminal spawning,
and a `claude_config_dir` that `agent_service._derive_profile` uses to map a
`transcript_path` to a profile name — matched on a path boundary, so
`~/.claude` no longer claims the sessions of `~/.claude-work`.
"""

from __future__ import annotations

import aiosqlite
from fastapi import HTTPException
from pydantic import BaseModel, Field


class ProfileCreate(BaseModel):
    name: str = Field(..., min_length=1)
    color: str = "#6366f1"
    icon: str = "user"
    cwd_hint: str | None = None
    env_json: str = "{}"
    claude_config_dir: str | None = None
    default_model: str | None = None
    default_project_id: int | None = None
    provider_id: int | None = None


class ProfileUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    icon: str | None = None
    cwd_hint: str | None = None
    env_json: str | None = None
    claude_config_dir: str | None = None
    default_model: str | None = None
    default_project_id: int | None = None
    provider_id: int | None = None


def _row_to_dict(row: aiosqlite.Row) -> dict:
    keys = row.keys() if hasattr(row, "keys") else []
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "icon": row["icon"],
        "cwd_hint": row["cwd_hint"],
        "env_json": row["env_json"],
        "claude_config_dir": row["claude_config_dir"],
        "default_model": row["default_model"],
        "default_project_id": row["default_project_id"],
        "created_at": row["created_at"],
        "provider_id": row["provider_id"] if "provider_id" in keys else None,
    }


async def list_profiles(db: aiosqlite.Connection) -> list[dict]:
    rows = await db.execute(
        """SELECT p.*,
                  (SELECT COUNT(*) FROM projects pr
                   WHERE pr.profile_id = p.id AND pr.is_workspace = 0) AS project_count
             FROM profiles p
            ORDER BY p.created_at ASC, p.id ASC"""
    )
    result = []
    for r in await rows.fetchall():
        d = _row_to_dict(r)
        d["project_count"] = (
            int(r["project_count"]) if r["project_count"] is not None else 0
        )
        result.append(d)
    return result


async def get_profile(db: aiosqlite.Connection, profile_id: int) -> dict:
    row = await db.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,))
    r = await row.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail="profile not found")
    return _row_to_dict(r)


async def _name_exists(
    db: aiosqlite.Connection, name: str, exclude_id: int | None = None
) -> bool:
    if exclude_id is None:
        row = await db.execute("SELECT 1 FROM profiles WHERE name = ?", (name,))
    else:
        row = await db.execute(
            "SELECT 1 FROM profiles WHERE name = ? AND id != ?", (name, exclude_id)
        )
    return await row.fetchone() is not None


async def create_profile(db: aiosqlite.Connection, data: ProfileCreate) -> dict:
    if await _name_exists(db, data.name):
        raise HTTPException(
            status_code=409, detail=f"profile name '{data.name}' already exists"
        )
    cursor = await db.execute(
        """INSERT INTO profiles
           (name, color, icon, cwd_hint, env_json, claude_config_dir,
            default_model, default_project_id, provider_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            data.name,
            data.color,
            data.icon,
            data.cwd_hint,
            data.env_json,
            data.claude_config_dir,
            data.default_model,
            data.default_project_id,
            data.provider_id,
        ),
    )
    await db.commit()
    from . import agent_service

    agent_service.invalidate_profile_cache()
    new_id = cursor.lastrowid
    assert new_id is not None  # INSERT just succeeded — sqlite always returns the rowid
    return await get_profile(db, new_id)


async def update_profile(
    db: aiosqlite.Connection, profile_id: int, data: ProfileUpdate
) -> dict:
    existing = await get_profile(db, profile_id)
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        return existing
    if (
        "name" in fields
        and fields["name"] != existing["name"]
        and await _name_exists(db, fields["name"], exclude_id=profile_id)
    ):
        raise HTTPException(
            status_code=409,
            detail=f"profile name '{fields['name']}' already exists",
        )
    columns = ", ".join(f"{k} = ?" for k in fields)
    params = list(fields.values()) + [profile_id]
    await db.execute(f"UPDATE profiles SET {columns} WHERE id = ?", params)
    await db.commit()
    from . import agent_service

    agent_service.invalidate_profile_cache()
    return await get_profile(db, profile_id)


async def delete_profile(db: aiosqlite.Connection, profile_id: int) -> None:
    profile = await get_profile(db, profile_id)
    row = await db.execute(
        "SELECT COUNT(*) AS cnt FROM agent_sessions WHERE profile = ? AND status = 'active'",
        (profile["name"],),
    )
    r = await row.fetchone()
    if r and r["cnt"] > 0:
        raise HTTPException(
            status_code=409,
            detail="Profile has active sessions. End or reassign them first.",
        )
    await db.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))
    await db.commit()
    from . import agent_service

    agent_service.invalidate_profile_cache()
