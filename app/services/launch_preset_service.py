"""Launch preset service.

CRUD for the ``launch_presets`` table.  A launch preset is a saved
launch configuration that users can recall from the launch composer
(``components/launch/launch-composer.tsx``) to avoid re-typing the
same pane composition every session.
"""

from __future__ import annotations

import json
import math

import aiosqlite
from fastapi import HTTPException
from pydantic import TypeAdapter

from app.models.launch import (
    AgentPresetPane,
    LaunchCell,
    LaunchPreset,
    LaunchPresetCreate,
    PresetPane,
    PresetShape,
    PresetUnresolved,
    SplitMode,
)

# Maximum total panes per launch (design decision D9).
_GRID_MAX_PANES = 8

# Built once — validating a discriminated union through TypeAdapter on every
# call would re-build its core schema each time.
_PANE_LIST_ADAPTER: TypeAdapter[list[PresetPane]] = TypeAdapter(list[PresetPane])


def _deserialize_cells(cells_json: str | None) -> list[LaunchCell] | None:
    """Deserialize `cells_json` column value into a list of LaunchCell objects."""
    if cells_json is None:
        return None
    raw = json.loads(cells_json)
    return [LaunchCell(**item) for item in raw]


def _deserialize_panes(panes_json: str | None) -> list[PresetPane] | None:
    """Deserialize `panes_json` column value into a list of typed panes."""
    if panes_json is None:
        return None
    return _PANE_LIST_ADAPTER.validate_python(json.loads(panes_json))


def _legacy_grid(pane_count: int, split: SplitMode) -> tuple[int, int]:
    """Project a pane count onto the legacy `(rows, cols)` header columns (D2).

    `launch_presets.rows`/`cols` are `NOT NULL CHECK (... BETWEEN 1 AND 4)`
    and cannot be relaxed without rebuilding the table, so a pane preset
    still needs *some* value there. This projection is lossy above 4 panes
    (or above 16 for `split="grid"`) — `panes_json` is authoritative for
    launching and for the composer's own read path; the header columns exist
    only so the row satisfies its constraints and an old reader sees a
    plausible (if approximate) grid shape.
    """
    n = max(pane_count, 1)
    if split == "rows":
        return min(n, 4), 1
    if split == "cols":
        return 1, min(n, 4)
    cols = min(math.ceil(math.sqrt(n)), 4)
    rows = min(math.ceil(n / cols), 4)
    return rows, cols


def _split_from_grid(rows: int, cols: int) -> SplitMode:
    """Infer a `SplitMode` for a legacy grid-shaped row (D4)."""
    if rows == 1:
        return "cols"
    if cols == 1:
        return "rows"
    return "grid"


def _panes_from_grid(
    row: aiosqlite.Row, cells: list[LaunchCell] | None
) -> list[PresetPane]:
    """Derive a pane list from a legacy grid-shaped row (D4).

    Row-major over `range(rows) x range(cols)`, reproducing exactly what
    `LaunchModal.workspaceCells` builds (`launch-modal.tsx:294-301`): a cell
    matching `(r, c)` supplies its own `provider_id`, and every other
    position falls back to the header `provider_id`. Every derived pane is an
    `AgentPresetPane` with `model=None`, `permission_mode=""`,
    `send_prompt=True` — a legacy preset never recorded any of the three.

    This intentionally drops each cell's `extra_args`, `env_overlay` and
    `project_id`: none has a pane equivalent (see the plan's Follow-ups), so
    a workspace preset whose cells span several projects reads back as panes
    on the header project. This is no longer a lossy *read path among two* —
    the launch composer is the only surviving consumer of a saved preset
    (task #35), so this projection is the sole way a legacy grid-shaped row
    is ever read. `cells_json` on disk is never rewritten by this function.
    """
    by_coord = {(c.row, c.col): c for c in cells} if cells else {}
    panes: list[PresetPane] = []
    for r in range(row["rows"]):
        for c in range(row["cols"]):
            cell = by_coord.get((r, c))
            provider_id = cell.provider_id if cell is not None else row["provider_id"]
            panes.append(
                AgentPresetPane(
                    provider_id=provider_id,
                    model=None,
                    permission_mode="",
                    send_prompt=True,
                )
            )
    return panes


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
    cells = _deserialize_cells(row["cells_json"])
    stored_panes = _deserialize_panes(row["panes_json"])

    shape: PresetShape
    if stored_panes is not None:
        panes = stored_panes
        split: SplitMode = row["split"] or "cols"
        shape = "panes"
    else:
        panes = _panes_from_grid(row, cells)
        split = _split_from_grid(row["rows"], row["cols"])
        shape = "grid"

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
        cells=cells,
        panes=panes,
        split=split,
        shape=shape,
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
        When ``project_id`` or ``provider_id`` does not reference an
        existing row; when cells contain duplicate coordinates; when the
        total pane count exceeds the cap; when ``panes`` and ``cells`` are
        both present; when ``panes`` is empty or has no agent pane (D3).
    HTTPException(422)
        When a grid-shape body (no ``panes``) omits ``provider_id``, or
        omits ``rows``/``cols`` with no ``cells`` to derive them from. The
        model validator (`LaunchPresetCreate.require_grid_fields_when_no_panes`)
        already rejects this over HTTP; this is the same check repeated for
        a direct (non-HTTP) caller that bypassed model validation.
    """
    cells_json: str | None = None
    panes_json: str | None = None
    split_value: str | None = None

    if data.panes is not None:
        if data.cells:
            raise HTTPException(
                status_code=400,
                detail="panes and cells are mutually exclusive",
            )
        if len(data.panes) == 0:
            raise HTTPException(
                status_code=400,
                detail="a preset needs at least one pane",
            )
        if len(data.panes) > _GRID_MAX_PANES:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{len(data.panes)} panes exceeds the maximum of "
                    f"{_GRID_MAX_PANES} panes"
                ),
            )
        first_agent = next(
            (p for p in data.panes if isinstance(p, AgentPresetPane)), None
        )
        if first_agent is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "a saved preset needs at least one agent pane — "
                    "launch_presets.provider_id/rows/cols are NOT NULL, so "
                    "a shell-only preset needs a table rebuild (follow-up)"
                ),
            )

        cur = await db.execute(
            "SELECT 1 FROM projects WHERE id = ?", (data.project_id,)
        )
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

        split_mode: SplitMode = data.split or "cols"
        provider_id = first_agent.provider_id
        rows, cols = _legacy_grid(len(data.panes), split_mode)
        split_value = split_mode
        panes_json = json.dumps(
            [p.model_dump() for p in data.panes], separators=(",", ":")
        )
    else:
        # Grid shape. LaunchPresetCreate.require_grid_fields_when_no_panes
        # already rejects a body missing any of these over HTTP; re-check so
        # that a direct service caller gets a 422 instead of a TypeError
        # (int | None arithmetic below) or a NOT NULL IntegrityError, and so
        # mypy sees plain ints from here down.
        if data.provider_id is None or data.rows is None or data.cols is None:
            raise HTTPException(
                status_code=422,
                detail="a preset without `panes` requires provider_id, rows and cols",
            )
        provider_id, rows, cols = data.provider_id, data.rows, data.cols

        if data.cells:
            # rows/cols already derived by the Pydantic validator on LaunchPresetCreate.
            # Enforce total pane cap.
            if rows * cols > _GRID_MAX_PANES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"rows*cols ({rows}*{cols}={rows * cols}) "
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
                "SELECT 1 FROM providers WHERE id = ?", (provider_id,)
            )
            if await cur.fetchone() is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"provider_id {provider_id} does not exist",
                )

    try:
        cursor = await db.execute(
            """INSERT INTO launch_presets
               (name, project_id, provider_id, rows, cols, extra_args, target,
                profile_id, cells_json, panes_json, split)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                data.name,
                data.project_id,
                provider_id,
                rows,
                cols,
                data.extra_args,
                data.target,
                data.profile_id,
                cells_json,
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
