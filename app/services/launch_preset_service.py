"""Launch preset service.

CRUD for the ``launch_presets`` table.  A launch preset is a saved
launch configuration that users can recall from the launch composer
(``components/launch/launch-composer.tsx``) to avoid re-typing the
same pane composition every session.

Since migration ``008_launch_presets_drop_grid`` a preset has exactly one
shape — an ordered typed pane list plus a split mode.  The legacy
``rows``/``cols``/``provider_id``/``cells_json`` header is gone from the table,
so there is no projection to write on the way in and no grid row to derive
panes from on the way out.  A shell-only composition is storable like any
other: nothing here needs a provider to exist.
"""

from __future__ import annotations

import json

import aiosqlite
from fastapi import HTTPException
from pydantic import TypeAdapter

from app.models.launch import (
    AgentPresetPane,
    LaunchPreset,
    LaunchPresetCreate,
    PresetPane,
    PresetUnresolved,
    SplitMode,
)

# Maximum total panes per launch (design decision D9).
_MAX_PANES = 8

# Built once — validating a discriminated union through TypeAdapter on every
# call would re-build its core schema each time.
_PANE_LIST_ADAPTER: TypeAdapter[list[PresetPane]] = TypeAdapter(list[PresetPane])


def _deserialize_panes(panes_json: str) -> list[PresetPane]:
    """Deserialize `panes_json` column value into a list of typed panes."""
    return _PANE_LIST_ADAPTER.validate_python(json.loads(panes_json))


async def _provider_state(db: aiosqlite.Connection) -> dict[int, bool]:
    """Return `{provider_id: is_enabled}` for every provider row."""
    cur = await db.execute("SELECT id, is_enabled FROM providers")
    rows = await cur.fetchall()
    return {r["id"]: bool(r["is_enabled"]) for r in rows}


def _unresolved(
    panes: list[PresetPane], state: dict[int, bool]
) -> list[PresetUnresolved]:
    """Flag every agent pane whose provider is missing or disabled (D6)."""
    unresolved: list[PresetUnresolved] = []
    for i, pane in enumerate(panes):
        if not isinstance(pane, AgentPresetPane):
            continue
        enabled = state.get(pane.provider_id)
        if enabled is None:
            unresolved.append(
                PresetUnresolved(
                    pane_index=i, provider_id=pane.provider_id, reason="missing"
                )
            )
        elif not enabled:
            unresolved.append(
                PresetUnresolved(
                    pane_index=i, provider_id=pane.provider_id, reason="disabled"
                )
            )
    return unresolved


def _row_to_preset(row: aiosqlite.Row, provider_state: dict[int, bool]) -> LaunchPreset:
    panes = _deserialize_panes(row["panes_json"])
    return LaunchPreset(
        id=row["id"],
        name=row["name"],
        project_id=row["project_id"],
        extra_args=row["extra_args"],
        target=row["target"],
        profile_id=row["profile_id"],
        created_at=row["created_at"],
        panes=panes,
        split=row["split"],
        unresolved=_unresolved(panes, provider_state),
    )


async def list_presets(db: aiosqlite.Connection) -> list[LaunchPreset]:
    """Return all launch presets ordered by creation time."""
    cur = await db.execute(
        "SELECT * FROM launch_presets ORDER BY created_at ASC, id ASC"
    )
    rows = await cur.fetchall()
    provider_state = await _provider_state(db)
    return [_row_to_preset(r, provider_state) for r in rows]


async def get_preset(db: aiosqlite.Connection, preset_id: int) -> LaunchPreset:
    """Return a single preset by primary key.

    Raises ``HTTPException(404)`` if not found.
    """
    cur = await db.execute("SELECT * FROM launch_presets WHERE id = ?", (preset_id,))
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="launch preset not found")
    provider_state = await _provider_state(db)
    return _row_to_preset(row, provider_state)


async def create_preset(
    db: aiosqlite.Connection, data: LaunchPresetCreate
) -> LaunchPreset:
    """Insert a new launch preset.

    Raises
    ------
    HTTPException(409)
        When a preset with the same ``name`` already exists.
    HTTPException(400)
        When ``panes`` is empty or exceeds the cap; when ``project_id`` or an
        agent pane's ``provider_id`` does not reference an existing row.

    ``panes`` is required by ``LaunchPresetCreate``, so an HTTP body without it
    is a 422 before reaching here; the empty check below also catches the
    ``None`` a direct caller could hand over via ``model_construct``.
    """
    if not data.panes:
        raise HTTPException(
            status_code=400,
            detail="a preset needs at least one pane",
        )
    if len(data.panes) > _MAX_PANES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{len(data.panes)} panes exceeds the maximum of {_MAX_PANES} panes"
            ),
        )

    cur = await db.execute("SELECT 1 FROM projects WHERE id = ?", (data.project_id,))
    if await cur.fetchone() is None:
        raise HTTPException(
            status_code=400,
            detail=f"project_id {data.project_id} does not exist",
        )

    for i, pane in enumerate(data.panes):
        if not isinstance(pane, AgentPresetPane):
            continue
        cur = await db.execute(
            "SELECT 1 FROM providers WHERE id = ?", (pane.provider_id,)
        )
        if await cur.fetchone() is None:
            raise HTTPException(
                status_code=400,
                detail=f"pane {i}: provider_id {pane.provider_id} does not exist",
            )

    split_value: SplitMode = data.split or "cols"
    panes_json = json.dumps([p.model_dump() for p in data.panes], separators=(",", ":"))

    try:
        cursor = await db.execute(
            """INSERT INTO launch_presets
               (name, project_id, extra_args, target, profile_id,
                panes_json, split)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                data.name,
                data.project_id,
                data.extra_args,
                data.target,
                data.profile_id,
                panes_json,
                split_value,
            ),
        )
        await db.commit()
    except Exception as exc:
        # SQLite UNIQUE constraint violation comes through as an IntegrityError
        # whose message contains "UNIQUE constraint failed".
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(
                status_code=409,
                detail=f"launch preset name '{data.name}' already exists",
            ) from exc
        raise

    new_id = cursor.lastrowid
    assert new_id is not None
    return await get_preset(db, new_id)


async def delete_preset(db: aiosqlite.Connection, preset_id: int) -> None:
    """Delete a launch preset.

    Raises ``HTTPException(404)`` if the preset does not exist.
    """
    await get_preset(db, preset_id)  # raises 404 if missing
    await db.execute("DELETE FROM launch_presets WHERE id = ?", (preset_id,))
    await db.commit()
