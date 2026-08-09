"""Snapshot tests for migration 017 → 024 — providers and launch_presets.

Asserts:
- Both tables exist with the documented columns (subset checks; later
  migrations may add columns, so we do not assert an exact match).
- The clean-slate schema ships with ZERO seeded provider rows (E0.1 decision).
- All FK / CHECK constraints are present in the schema text.
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
        "provider_id",
        "rows",
        "cols",
        "extra_args",
        "target",
        "profile_id",
        "created_at",
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
async def test_launch_presets_check_rows_cols(migrated_db) -> None:
    """rows/cols outside [1,4] must be rejected by the CHECK constraint."""
    import aiosqlite

    await migrated_db.execute(
        "INSERT INTO projects (name, description, tech_stack, status) VALUES (?, ?, ?, ?)",
        ("TestProject", None, None, "active"),
    )
    await migrated_db.commit()
    cur = await migrated_db.execute("SELECT id FROM projects WHERE name='TestProject'")
    proj = await cur.fetchone()
    assert proj is not None
    proj_id = proj["id"]

    prov_id = await _insert_provider(migrated_db, "check-rows-prov")

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            """INSERT INTO launch_presets
               (name, project_id, provider_id, rows, cols, target)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("bad-preset", proj_id, prov_id, 5, 1, "embedded"),
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

    prov_id = await _insert_provider(migrated_db, "target-check-prov")

    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            """INSERT INTO launch_presets
               (name, project_id, provider_id, rows, cols, target)
               VALUES (?, ?, ?, ?, ?, ?)""",
            ("bad-target", proj["id"], prov_id, 1, 1, "warp"),
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

    prov_id = await _insert_provider(migrated_db, "cascade-prov")

    await migrated_db.execute(
        """INSERT INTO launch_presets
           (name, project_id, provider_id, rows, cols, target)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("cascade-preset", proj_id, prov_id, 1, 1, "embedded"),
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
