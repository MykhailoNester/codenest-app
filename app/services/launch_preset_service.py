"""Launch preset service.

CRUD for the ``launch_presets`` table.  A launch preset is a saved
launch configuration that users can recall from the Launch modal to
avoid re-typing the same form values every session.
"""

from __future__ import annotations

import json

import aiosqlite
from fastapi import HTTPException

from app.models.launch import LaunchCell, LaunchPreset, LaunchPresetCreate

# Maximum total panes per launch (design decision D6).
_GRID_MAX_PANES = 8


def _deserialize_cells(cells_json: str | None) -> list[LaunchCell] | None:
    """Deserialize `cells_json` column value into a list of LaunchCell objects."""
    if cells_json is None:
        return None
    raw = json.loads(cells_json)
    return [LaunchCell(**item) for item in raw]


def _row_to_preset(row: aiosqlite.Row) -> LaunchPreset:
    return LaunchPreset(
        id=row["id"],
        name=row["name"],
        project_id=row["project_id"],
        provider_id=row["provider_id"],
        rows=row["rows"],
        cols=row["cols"],
        extra_args=row["extra_args"],
        target=row["target"],
        profile_id=row["profile_id"],
        created_at=row["created_at"],
        cells=_deserialize_cells(row["cells_json"]),
    )


async def list_presets(db: aiosqlite.Connection) -> list[LaunchPreset]:
    """Return all launch presets ordered by creation time."""
    cur = await db.execute(
        "SELECT * FROM launch_presets ORDER BY created_at ASC, id ASC"
    )
    rows = await cur.fetchall()
    return [_row_to_preset(r) for r in rows]


async def get_preset(db: aiosqlite.Connection, preset_id: int) -> LaunchPreset:
    """Return a single preset by primary key.

    Raises ``HTTPException(404)`` if not found.
    """
    cur = await db.execute("SELECT * FROM launch_presets WHERE id = ?", (preset_id,))
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="launch preset not found")
    return _row_to_preset(row)


async def create_preset(
    db: aiosqlite.Connection, data: LaunchPresetCreate
) -> LaunchPreset:
    """Insert a new launch preset.

    Raises
    ------
    HTTPException(409)
        When a preset with the same ``name`` already exists.
    HTTPException(400)
        When ``project_id`` or ``provider_id`` does not reference an
        existing row, or cells contain duplicate coordinates, or the
        total pane count exceeds the cap.
    """
    cells_json: str | None = None

    if data.cells:
        # rows/cols already derived by the Pydantic validator on LaunchPresetCreate.
        # Enforce total pane cap.
        if data.rows * data.cols > _GRID_MAX_PANES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"rows*cols ({data.rows}*{data.cols}={data.rows * data.cols}) "
                    f"exceeds the maximum of {_GRID_MAX_PANES} panes"
                ),
            )

        # Validate every project_id in cells.
        for cell in data.cells:
            cur = await db.execute(
                "SELECT 1 FROM projects WHERE id = ?", (cell.project_id,)
            )
            if await cur.fetchone() is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"cell ({cell.row},{cell.col}): project_id {cell.project_id} does not exist",
                )

        # Validate every provider_id in cells.
        for cell in data.cells:
            cur = await db.execute(
                "SELECT 1 FROM providers WHERE id = ?", (cell.provider_id,)
            )
            if await cur.fetchone() is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"cell ({cell.row},{cell.col}): provider_id {cell.provider_id} does not exist",
                )

        cells_json = json.dumps(
            [c.model_dump() for c in data.cells], separators=(",", ":")
        )
    else:
        # Uniform mode — validate the top-level project/provider references.
        cur = await db.execute(
            "SELECT 1 FROM projects WHERE id = ?", (data.project_id,)
        )
        if await cur.fetchone() is None:
            raise HTTPException(
                status_code=400,
                detail=f"project_id {data.project_id} does not exist",
            )

        cur = await db.execute(
            "SELECT 1 FROM providers WHERE id = ?", (data.provider_id,)
        )
        if await cur.fetchone() is None:
            raise HTTPException(
                status_code=400,
                detail=f"provider_id {data.provider_id} does not exist",
            )

    try:
        cursor = await db.execute(
            """INSERT INTO launch_presets
               (name, project_id, provider_id, rows, cols, extra_args, target,
                profile_id, cells_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                data.name,
                data.project_id,
                data.provider_id,
                data.rows,
                data.cols,
                data.extra_args,
                data.target,
                data.profile_id,
                cells_json,
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
