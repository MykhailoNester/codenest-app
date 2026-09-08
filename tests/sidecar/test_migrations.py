"""Snapshot tests for migration 017 → 024 — providers and launch_presets.

Asserts:
- Both tables exist with the documented columns (subset checks; later
  migrations may add columns, so we do not assert an exact match).
- The clean-slate schema ships with ZERO seeded provider rows (E0.1 decision).
- All FK / CHECK constraints are present in the schema text.
- Migration 008's table rebuild: the grid columns are gone and every row that
  was still grid-shaped came through it as the pane list the read path used to
  derive.
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_providers_table_schema(migrated_db) -> None:
    """providers table must have all originally documented columns (subset check)."""
    cur = await migrated_db.execute("PRAGMA table_info(providers)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    required = {
        "id",
        "name",
        "display_name",
        "command_template",
        "default_args",
        "is_enabled",
        "created_at",
    }
    assert required.issubset(col_names), (
        f"required columns missing from providers: {required - col_names}"
    )


@pytest.mark.asyncio
async def test_launch_presets_table_schema(migrated_db) -> None:
    """launch_presets table must have all documented columns (subset check)."""
    cur = await migrated_db.execute("PRAGMA table_info(launch_presets)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    required = {
        "id",
        "name",
        "project_id",
        "extra_args",
        "target",
        "profile_id",
        "created_at",
        "panes_json",
        "split",
    }
    assert required.issubset(col_names), (
        f"required columns missing from launch_presets: {required - col_names}"
    )


@pytest.mark.asyncio
async def test_clean_slate_zero_providers(migrated_db) -> None:
    """E0.1 decision: fresh DB must ship with zero seeded provider rows."""
    cur = await migrated_db.execute("SELECT COUNT(*) AS cnt FROM providers")
    row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0, (
        f"expected 0 seeded providers (E0.1), got {row['cnt']}; "
        "remove seed INSERTs from 001_initial_schema.sql"
    )


@pytest.mark.asyncio
async def test_providers_name_unique_constraint(migrated_db) -> None:
    """Inserting a duplicate provider name must fail."""
    import aiosqlite

    await migrated_db.execute(
        "INSERT INTO providers (name, display_name, command_template) VALUES (?, ?, ?)",
        ("test-provider", "Test Provider", "cmd"),
    )
    await migrated_db.commit()

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            "INSERT INTO providers (name, display_name, command_template) VALUES (?, ?, ?)",
            ("test-provider", "Duplicate", "cmd"),
        )


async def _insert_provider(db, name: str = "test-prov") -> int:
    """Insert a minimal provider row and return its id."""
    cur = await db.execute(
        "INSERT INTO providers (name, display_name, command_template, is_enabled) "
        "VALUES (?, ?, ?, 1)",
        (name, name.title(), f"{name} {{extra_args}}"),
    )
    await db.commit()
    assert cur.lastrowid is not None
    return cur.lastrowid


@pytest.mark.asyncio
async def test_launch_presets_has_no_grid_columns(migrated_db) -> None:
    """Migration 008 must leave no trace of the rows x cols x provider grid."""
    cur = await migrated_db.execute("PRAGMA table_info(launch_presets)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    gone = {"rows", "cols", "provider_id", "cells_json"}
    assert not (gone & col_names), (
        f"grid columns still on launch_presets: {gone & col_names}"
    )


@pytest.mark.asyncio
async def test_launch_presets_target_check(migrated_db) -> None:
    """target values other than 'embedded' or 'popout' must be rejected."""
    import aiosqlite

    await migrated_db.execute(
        "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
        ("ProjCheck", None, None, "active"),
    )
    await migrated_db.commit()
    cur = await migrated_db.execute("SELECT id FROM projects WHERE name='ProjCheck'")
    proj = await cur.fetchone()
    assert proj is not None

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            """INSERT INTO launch_presets
               (name, project_id, target, panes_json, split)
               VALUES (?, ?, ?, ?, ?)""",
            ("bad-target", proj["id"], "warp", "[]", "cols"),
        )


@pytest.mark.asyncio
async def test_launch_presets_project_fk_cascade(migrated_db) -> None:
    """Deleting a project must cascade-delete its launch presets."""
    await migrated_db.execute(
        "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
        ("CascadeProj", None, None, "active"),
    )
    await migrated_db.commit()
    cur = await migrated_db.execute("SELECT id FROM projects WHERE name='CascadeProj'")
    proj = await cur.fetchone()
    assert proj is not None
    proj_id = proj["id"]

    await migrated_db.execute(
        """INSERT INTO launch_presets
           (name, project_id, target, panes_json, split)
           VALUES (?, ?, ?, ?, ?)""",
        ("cascade-preset", proj_id, "embedded", "[]", "cols"),
    )
    await migrated_db.commit()

    await migrated_db.execute("DELETE FROM projects WHERE id = ?", (proj_id,))
    await migrated_db.commit()

    cur = await migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM launch_presets WHERE name='cascade-preset'"
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0, "preset should have been cascade-deleted"


@pytest.mark.asyncio
async def test_idx_launch_presets_project_exists(migrated_db) -> None:
    """The idx_launch_presets_project index must be present."""
    cur = await migrated_db.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_launch_presets_project'"
    )
    row = await cur.fetchone()
    assert row is not None, "index idx_launch_presets_project missing"


# ---------------------------------------------------------------------------
# Migration 024 — provider model columns + launch_source_overrides
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_providers_table_has_models_json_and_default_model(migrated_db) -> None:
    """Migration 024 must add models_json and default_model columns to providers."""
    cur = await migrated_db.execute("PRAGMA table_info(providers)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    assert "models_json" in col_names, "models_json column missing from providers"
    assert "default_model" in col_names, "default_model column missing from providers"


@pytest.mark.asyncio
async def test_launch_source_overrides_table_schema(migrated_db) -> None:
    """launch_source_overrides must have all documented columns."""
    cur = await migrated_db.execute("PRAGMA table_info(launch_source_overrides)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    expected = {
        "source_kind",
        "source_id",
        "project_id",
        "provider_id",
        "model",
        "rows",
        "cols",
        "target",
        "profile_id",
        "extra_args",
        "prompt_fanout",
        "prompt_override",
        "updated_at",
    }
    assert expected == col_names, f"column mismatch: got {col_names}"


@pytest.mark.asyncio
async def test_launch_source_overrides_composite_pk(migrated_db) -> None:
    """Composite PK (source_kind, source_id) must prevent duplicates."""
    import aiosqlite

    await migrated_db.execute(
        "INSERT INTO launch_source_overrides (source_kind, source_id) VALUES (?, ?)",
        ("task", 1),
    )
    await migrated_db.commit()

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            "INSERT INTO launch_source_overrides (source_kind, source_id) VALUES (?, ?)",
            ("task", 1),
        )


@pytest.mark.asyncio
async def test_launch_source_overrides_source_kind_check(migrated_db) -> None:
    """source_kind CHECK must reject values other than 'task' and 'inbox'."""
    import aiosqlite

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            "INSERT INTO launch_source_overrides (source_kind, source_id) VALUES (?, ?)",
            ("slack", 1),
        )


@pytest.mark.asyncio
async def test_launch_source_overrides_prompt_fanout_check(migrated_db) -> None:
    """prompt_fanout CHECK must reject values outside 'primary', 'every', 'none'."""
    import aiosqlite

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            "INSERT INTO launch_source_overrides (source_kind, source_id, prompt_fanout) VALUES (?, ?, ?)",
            ("task", 2, "shotgun"),
        )


# ---------------------------------------------------------------------------
# Migration 003 — agent_sessions.context_tokens
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_agent_sessions_has_context_tokens(migrated_db) -> None:
    """Migration 003 must add a context_tokens column to agent_sessions."""
    cur = await migrated_db.execute("PRAGMA table_info(agent_sessions)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    assert "context_tokens" in col_names, (
        "context_tokens column missing from agent_sessions"
    )


# ---------------------------------------------------------------------------
# Migration 004 — task labels
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_task_label_assignments_table_schema(migrated_db) -> None:
    """task_label_assignments must have exactly the documented columns."""
    cur = await migrated_db.execute("PRAGMA table_info(task_label_assignments)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    assert col_names == {"task_id", "label_id", "created_at"}


@pytest.mark.asyncio
async def test_task_label_assignments_composite_pk(migrated_db) -> None:
    """The composite PRIMARY KEY (task_id, label_id) must reject a duplicate."""
    import aiosqlite

    cur = await migrated_db.execute(
        "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
        ("LabelPkProj", None, None, "active"),
    )
    await migrated_db.commit()
    cur = await migrated_db.execute("SELECT id FROM projects WHERE name='LabelPkProj'")
    proj = await cur.fetchone()
    assert proj is not None

    cur = await migrated_db.execute(
        "INSERT INTO tasks (title, project_id) VALUES (?, ?)",
        ("Label PK task", proj["id"]),
    )
    await migrated_db.commit()
    task_id = cur.lastrowid
    assert task_id is not None

    label_cur = await migrated_db.execute(
        "SELECT id FROM taxonomies WHERE kind = 'task_label' LIMIT 1"
    )
    label = await label_cur.fetchone()
    assert label is not None
    label_id = label["id"]

    await migrated_db.execute(
        "INSERT INTO task_label_assignments (task_id, label_id) VALUES (?, ?)",
        (task_id, label_id),
    )
    await migrated_db.commit()

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            "INSERT INTO task_label_assignments (task_id, label_id) VALUES (?, ?)",
            (task_id, label_id),
        )


@pytest.mark.asyncio
async def test_idx_task_label_assignments_label_exists(migrated_db) -> None:
    """The idx_task_label_assignments_label index must be present."""
    cur = await migrated_db.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND name='idx_task_label_assignments_label'"
    )
    row = await cur.fetchone()
    assert row is not None, "index idx_task_label_assignments_label missing"


@pytest.mark.asyncio
async def test_task_label_seed_rows_present(migrated_db) -> None:
    """Migration 004 must seed exactly five task_label rows, all non-default."""
    cur = await migrated_db.execute(
        "SELECT slug, is_default FROM taxonomies WHERE kind = 'task_label'"
    )
    rows = await cur.fetchall()
    assert {r["slug"] for r in rows} == {"bug", "feature", "chore", "research", "docs"}
    assert all(r["is_default"] == 0 for r in rows)


@pytest.mark.asyncio
async def test_task_label_assignment_task_fk_cascade(migrated_db) -> None:
    """Deleting a task must cascade-delete its label assignments."""
    cur = await migrated_db.execute(
        "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
        ("LabelCascadeProj", None, None, "active"),
    )
    await migrated_db.commit()
    cur = await migrated_db.execute(
        "SELECT id FROM projects WHERE name='LabelCascadeProj'"
    )
    proj = await cur.fetchone()
    assert proj is not None

    cur = await migrated_db.execute(
        "INSERT INTO tasks (title, project_id) VALUES (?, ?)",
        ("Label cascade task", proj["id"]),
    )
    await migrated_db.commit()
    task_id = cur.lastrowid
    assert task_id is not None

    label_cur = await migrated_db.execute(
        "SELECT id FROM taxonomies WHERE kind = 'task_label' LIMIT 1"
    )
    label = await label_cur.fetchone()
    assert label is not None

    await migrated_db.execute(
        "INSERT INTO task_label_assignments (task_id, label_id) VALUES (?, ?)",
        (task_id, label["id"]),
    )
    await migrated_db.commit()

    await migrated_db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    await migrated_db.commit()

    cur = await migrated_db.execute(
        "SELECT COUNT(*) AS cnt FROM task_label_assignments WHERE task_id = ?",
        (task_id,),
    )
    row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0, "assignment should have been cascade-deleted"


# ---------------------------------------------------------------------------
# Migration 005 — launch_presets pane list
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_launch_presets_has_panes_and_split_columns(migrated_db) -> None:
    """Migration 005 must add panes_json and split columns to launch_presets."""
    cur = await migrated_db.execute("PRAGMA table_info(launch_presets)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    assert "panes_json" in col_names, "panes_json column missing from launch_presets"
    assert "split" in col_names, "split column missing from launch_presets"


@pytest.mark.asyncio
async def test_launch_presets_split_check(migrated_db) -> None:
    """split CHECK must accept the three known values and reject anything else."""
    import aiosqlite

    await migrated_db.execute(
        "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
        ("SplitCheckProj", None, None, "active"),
    )
    await migrated_db.commit()
    cur = await migrated_db.execute(
        "SELECT id FROM projects WHERE name='SplitCheckProj'"
    )
    proj = await cur.fetchone()
    assert proj is not None

    await migrated_db.execute(
        """INSERT INTO launch_presets
           (name, project_id, target, panes_json)
           VALUES (?, ?, ?, ?)""",
        ("split-check-preset", proj["id"], "embedded", "[]"),
    )
    await migrated_db.commit()

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            "UPDATE launch_presets SET split = 'diagonal' WHERE name = 'split-check-preset'"
        )

    await migrated_db.execute(
        "UPDATE launch_presets SET split = 'grid' WHERE name = 'split-check-preset'"
    )
    await migrated_db.commit()


@pytest.mark.asyncio
async def test_migration_005_applies_over_existing_grid_presets(tmp_path) -> None:
    """005 must apply cleanly to a DB that already holds a grid-shaped preset,
    leaving the row untouched and panes_json/split NULL. Pins acceptance
    criterion 4 (fresh-DB application is covered by every other test above,
    which all go through `migrated_db`)."""
    import pathlib

    import aiosqlite

    from app.database import apply_migration_file

    migrations_dir = pathlib.Path(__file__).parents[2] / "migrations"
    pre_005 = sorted(
        f for f in migrations_dir.glob("*.sql") if f.stem < "005_launch_preset_panes"
    )

    db_path = tmp_path / "pre-005.db"
    conn = await aiosqlite.connect(str(db_path))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    try:
        for migration_file in pre_005:
            await apply_migration_file(conn, migration_file)

        await conn.execute(
            "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
            ("Pre005Proj", None, None, "active"),
        )
        await conn.commit()
        proj = await (
            await conn.execute("SELECT id FROM projects WHERE name='Pre005Proj'")
        ).fetchone()
        assert proj is not None

        prov_id = await _insert_provider(conn, "pre-005-prov")

        await conn.execute(
            """INSERT INTO launch_presets
               (name, project_id, provider_id, rows, cols, target)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("Pre005Preset", proj["id"], prov_id, 2, 2, "embedded"),
        )
        await conn.commit()
        before = await (
            await conn.execute(
                "SELECT id, name, rows, cols FROM launch_presets WHERE name='Pre005Preset'"
            )
        ).fetchone()
        assert before is not None

        await apply_migration_file(conn, migrations_dir / "005_launch_preset_panes.sql")

        after = await (
            await conn.execute(
                "SELECT id, name, rows, cols, panes_json, split FROM launch_presets "
                "WHERE name='Pre005Preset'"
            )
        ).fetchone()
        assert after is not None
        assert after["id"] == before["id"]
        assert after["name"] == before["name"]
        assert after["rows"] == before["rows"]
        assert after["cols"] == before["cols"]
        assert after["panes_json"] is None
        assert after["split"] is None
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Migration 008 — launch_presets drops the legacy grid columns
# ---------------------------------------------------------------------------

_M008 = "008_launch_presets_drop_grid"


async def _pre_008_db(tmp_path, filename: str = "pre-008.db"):
    """A connection with every migration before 008 applied, plus one project
    and two providers. Returns `(conn, project_id, provider_a, provider_b)`."""
    import pathlib

    import aiosqlite

    from app.database import apply_migration_file

    migrations_dir = pathlib.Path(__file__).parents[2] / "migrations"
    conn = await aiosqlite.connect(str(tmp_path / filename))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    for migration_file in sorted(
        f for f in migrations_dir.glob("*.sql") if f.stem < _M008
    ):
        await apply_migration_file(conn, migration_file)

    await conn.execute(
        "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
        ("Pre008Proj", None, None, "active"),
    )
    await conn.commit()
    proj = await (
        await conn.execute("SELECT id FROM projects WHERE name='Pre008Proj'")
    ).fetchone()
    assert proj is not None
    prov_a = await _insert_provider(conn, "pre-008-prov-a")
    prov_b = await _insert_provider(conn, "pre-008-prov-b")
    return conn, proj["id"], prov_a, prov_b


async def _apply_008(conn) -> None:
    import pathlib

    from app.database import apply_migration_file

    await apply_migration_file(
        conn, pathlib.Path(__file__).parents[2] / "migrations" / f"{_M008}.sql"
    )


@pytest.mark.asyncio
async def test_migration_008_converts_a_grid_preset_to_agent_panes(tmp_path) -> None:
    """A grid-shaped row with no cells_json becomes rows*cols agent panes on the
    header provider, keeping its id and created_at. Pins the ticket's
    acceptance criterion 2 for the plain case."""
    from app.services import launch_preset_service

    conn, proj_id, prov_a, _ = await _pre_008_db(tmp_path)
    try:
        await conn.execute(
            """INSERT INTO launch_presets
               (name, project_id, provider_id, rows, cols, extra_args, target, profile_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            ("GridPreset", proj_id, prov_a, 2, 2, "--flag", "popout", None),
        )
        await conn.commit()
        before = await (
            await conn.execute(
                "SELECT id, created_at FROM launch_presets WHERE name='GridPreset'"
            )
        ).fetchone()
        assert before is not None

        await _apply_008(conn)

        preset = await launch_preset_service.get_preset(conn, before["id"])
        assert len(preset.panes) == 4
        assert all(
            p.kind == "agent"
            and p.provider_id == prov_a
            and p.model is None
            and p.permission_mode == ""
            and p.send_prompt is True
            for p in preset.panes
        )
        assert preset.split == "grid"
        assert preset.created_at == before["created_at"]
        assert preset.extra_args == "--flag"
        assert preset.target == "popout"
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_migration_008_converts_cells_row_major_with_per_cell_providers(
    tmp_path,
) -> None:
    """A sparse 2x2 cells_json becomes 4 panes in row-major order: each cell's
    own provider where it has one, the header provider where it does not.

    This is the exact projection the departing
    `launch_preset_service._panes_from_grid` performed at read time."""
    import json

    from app.services import launch_preset_service

    conn, proj_id, prov_a, prov_b = await _pre_008_db(tmp_path, "pre-008-cells.db")
    try:
        cells = [
            {
                "row": 0,
                "col": 0,
                "project_id": proj_id,
                "provider_id": prov_a,
                "extra_args": "--a",
                "profile_id": None,
                "env_overlay": {},
            },
            {
                "row": 0,
                "col": 1,
                "project_id": proj_id,
                "provider_id": prov_b,
                "extra_args": "",
                "profile_id": None,
                "env_overlay": {"K": "V"},
            },
            {
                "row": 1,
                "col": 0,
                "project_id": proj_id,
                "provider_id": prov_a,
                "extra_args": "",
                "profile_id": None,
                "env_overlay": {},
            },
            # (1,1) intentionally omitted — falls back to the header provider.
        ]
        await conn.execute(
            """INSERT INTO launch_presets
               (name, project_id, provider_id, rows, cols, target, cells_json)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                "CellsPreset",
                proj_id,
                prov_b,
                2,
                2,
                "embedded",
                json.dumps(cells, separators=(",", ":")),
            ),
        )
        await conn.commit()
        row = await (
            await conn.execute("SELECT id FROM launch_presets WHERE name='CellsPreset'")
        ).fetchone()
        assert row is not None

        await _apply_008(conn)

        preset = await launch_preset_service.get_preset(conn, row["id"])
        assert [p.provider_id for p in preset.panes] == [
            prov_a,
            prov_b,
            prov_a,
            prov_b,  # (1,1) had no cell — header provider
        ]
        assert all(p.kind == "agent" for p in preset.panes)
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_migration_008_leaves_a_pane_shaped_row_untouched(tmp_path) -> None:
    """A row written by 005's pane path keeps its panes_json and split verbatim,
    shell panes included."""
    conn, proj_id, prov_a, _ = await _pre_008_db(tmp_path, "pre-008-panes.db")
    try:
        panes_json = (
            '[{"kind":"shell","shell":"/bin/zsh","command":"pnpm dev"},'
            f'{{"kind":"agent","provider_id":{prov_a},"model":"opus",'
            '"permission_mode":"acceptEdits","send_prompt":false}]'
        )
        await conn.execute(
            """INSERT INTO launch_presets
               (name, project_id, provider_id, rows, cols, target, panes_json, split)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            ("PanePreset", proj_id, prov_a, 1, 2, "embedded", panes_json, "rows"),
        )
        await conn.commit()

        await _apply_008(conn)

        after = await (
            await conn.execute(
                "SELECT panes_json, split FROM launch_presets WHERE name='PanePreset'"
            )
        ).fetchone()
        assert after is not None
        assert after["panes_json"] == panes_json
        assert after["split"] == "rows"
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_migration_008_derives_split_from_the_grid_shape(tmp_path) -> None:
    """1xN -> 'cols', Nx1 -> 'rows', anything else -> 'grid' (and 1x1 -> 'cols',
    matching the old `_split_from_grid`, which tested rows first)."""
    conn, proj_id, prov_a, _ = await _pre_008_db(tmp_path, "pre-008-split.db")
    try:
        for name, n_rows, n_cols in (
            ("one-by-one", 1, 1),
            ("one-row", 1, 3),
            ("one-col", 4, 1),
            ("square", 2, 2),
        ):
            await conn.execute(
                """INSERT INTO launch_presets
                   (name, project_id, provider_id, rows, cols, target)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (name, proj_id, prov_a, n_rows, n_cols, "embedded"),
            )
        await conn.commit()

        await _apply_008(conn)

        got = {
            r["name"]: (r["split"], r["panes_json"])
            for r in await (
                await conn.execute("SELECT name, split, panes_json FROM launch_presets")
            ).fetchall()
        }
        assert got["one-by-one"][0] == "cols"
        assert got["one-row"][0] == "cols"
        assert got["one-col"][0] == "rows"
        assert got["square"][0] == "grid"
        # Pane counts follow rows*cols, not the 8-pane save cap: an existing
        # 4x4 preset must not lose panes to a limit it predates.
        import json as _json

        assert len(_json.loads(got["one-by-one"][1])) == 1
        assert len(_json.loads(got["one-row"][1])) == 3
        assert len(_json.loads(got["one-col"][1])) == 4
        assert len(_json.loads(got["square"][1])) == 4
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_migration_008_leaves_foreign_keys_on(tmp_path) -> None:
    """The rebuild toggles PRAGMA foreign_keys off; it must be back on when the
    migration returns — every later statement on the connection depends on it."""
    conn, proj_id, _, _ = await _pre_008_db(tmp_path, "pre-008-fk.db")
    try:
        await _apply_008(conn)
        cur = await conn.execute("PRAGMA foreign_keys")
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == 1, "migration 008 left foreign key enforcement off"

        # ... and the surviving project FK still cascades.
        await conn.execute(
            """INSERT INTO launch_presets
               (name, project_id, target, panes_json, split)
               VALUES (?, ?, ?, ?, ?)""",
            ("fk-preset", proj_id, "embedded", "[]", "cols"),
        )
        await conn.commit()
        await conn.execute("DELETE FROM projects WHERE id = ?", (proj_id,))
        await conn.commit()
        cnt = await (
            await conn.execute("SELECT COUNT(*) AS cnt FROM launch_presets")
        ).fetchone()
        assert cnt is not None
        assert cnt["cnt"] == 0
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Migration 009 — agent_sessions provenance columns
# ---------------------------------------------------------------------------

_M009 = "009_agent_sessions_provenance"

_PROVENANCE_COLUMNS = (
    "source_app",
    "source_detail",
    "git_branch",
    "cli_version",
    "permission_mode",
    "effort",
    "title",
    "title_source",
)


async def _pre_009_db(tmp_path, filename: str = "pre-009.db"):
    """A connection with every migration before 009 applied."""
    import pathlib

    import aiosqlite

    from app.database import apply_migration_file

    migrations_dir = pathlib.Path(__file__).parents[2] / "migrations"
    conn = await aiosqlite.connect(str(tmp_path / filename))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    for migration_file in sorted(
        f for f in migrations_dir.glob("*.sql") if f.stem < _M009
    ):
        await apply_migration_file(conn, migration_file)
    return conn


async def _apply_009(conn) -> None:
    import pathlib

    from app.database import apply_migration_file

    await apply_migration_file(
        conn, pathlib.Path(__file__).parents[2] / "migrations" / f"{_M009}.sql"
    )


@pytest.mark.asyncio
async def test_agent_sessions_has_provenance_columns(migrated_db) -> None:
    """Migration 009 must add all eight provenance columns to agent_sessions."""
    cur = await migrated_db.execute("PRAGMA table_info(agent_sessions)")
    rows = await cur.fetchall()
    col_names = {r["name"] for r in rows}
    missing = set(_PROVENANCE_COLUMNS) - col_names
    assert not missing, f"provenance columns missing from agent_sessions: {missing}"


@pytest.mark.asyncio
async def test_agent_sessions_provenance_columns_are_nullable_text(
    migrated_db,
) -> None:
    """Each provenance column must be TEXT, nullable, with no DEFAULT — the AC's
    'all nullable TEXT, default NULL', which stops a later drive-by
    `NOT NULL DEFAULT ''`."""
    cur = await migrated_db.execute("PRAGMA table_info(agent_sessions)")
    rows = await cur.fetchall()
    by_name = {r["name"]: r for r in rows}
    for name in _PROVENANCE_COLUMNS:
        col = by_name[name]
        assert col["type"] == "TEXT", f"{name} type is {col['type']!r}, want TEXT"
        assert col["notnull"] == 0, f"{name} is NOT NULL, want nullable"
        assert col["dflt_value"] is None, (
            f"{name} has a DEFAULT ({col['dflt_value']!r}), want none"
        )


@pytest.mark.asyncio
async def test_agent_sessions_provenance_has_no_check_constraint(
    migrated_db,
) -> None:
    """Behavioural pin of the ADR's rejection of a source_app CHECK/allowlist:
    an arbitrary, out-of-any-plausible-vocabulary value round-trips."""
    await migrated_db.execute(
        """INSERT INTO agent_sessions
               (session_id, source_app, permission_mode, title_source)
           VALUES (?, ?, ?, ?)""",
        (
            "prov-no-check",
            "not-a-real-client-xyz",
            "not-a-real-mode-xyz",
            "not-a-real-source-xyz",
        ),
    )
    await migrated_db.commit()
    row = await (
        await migrated_db.execute(
            "SELECT source_app, permission_mode, title_source FROM agent_sessions "
            "WHERE session_id = ?",
            ("prov-no-check",),
        )
    ).fetchone()
    assert row is not None
    assert row["source_app"] == "not-a-real-client-xyz"
    assert row["permission_mode"] == "not-a-real-mode-xyz"
    assert row["title_source"] == "not-a-real-source-xyz"


@pytest.mark.asyncio
async def test_migration_009_preserves_existing_agent_sessions_rows(
    tmp_path,
) -> None:
    """A row inserted before 009 keeps every prior value and reads NULL in all
    eight new slots."""
    conn = await _pre_009_db(tmp_path)
    try:
        await conn.execute(
            """INSERT INTO agent_sessions (session_id, profile, cwd, total_tool_calls)
               VALUES (?, ?, ?, ?)""",
            ("pre-009-session", "work", "/repo/pre-009", 7),
        )
        await conn.commit()

        await _apply_009(conn)

        row = await (
            await conn.execute(
                "SELECT * FROM agent_sessions WHERE session_id = ?",
                ("pre-009-session",),
            )
        ).fetchone()
        assert row is not None
        assert row["profile"] == "work"
        assert row["cwd"] == "/repo/pre-009"
        assert row["total_tool_calls"] == 7
        for name in _PROVENANCE_COLUMNS:
            assert row[name] is None, f"{name} expected NULL, got {row[name]!r}"
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_migration_009_stem_is_recorded_and_skipped_on_rerun(
    tmp_path, monkeypatch
) -> None:
    """init_db is idempotent: running it twice applies 009 once and records its
    stem once, even though the raw SQL would (correctly) raise
    'duplicate column name' on a second literal execution."""
    import app.database as db_module
    from app.config import settings
    from app.database import init_db

    monkeypatch.setattr(settings, "DATABASE_PATH", tmp_path / "idem.db")
    db_module._db = None
    try:
        await init_db()
        await init_db()

        conn = db_module._db
        assert conn is not None
        rows = await (
            await conn.execute(
                "SELECT COUNT(*) AS cnt FROM schema_migrations WHERE version = ?",
                (_M009,),
            )
        ).fetchone()
        assert rows is not None
        assert rows["cnt"] == 1

        cur = await conn.execute("PRAGMA table_info(agent_sessions)")
        col_names = {r["name"] for r in await cur.fetchall()}
        missing = set(_PROVENANCE_COLUMNS) - col_names
        assert not missing
    finally:
        if db_module._db is not None:
            await db_module._db.close()
        db_module._db = None
