"""Tests for `migrations/010_project_roots.sql` and
`app/services/project_roots_service.py`.

Two harnesses, per the plan:
- fresh-DB tests take the shared `migrated_db` fixture (`conftest.py`);
- seeding-rule tests need `projects` rows that predate migration 010, so
  they build a database with every migration *before* 010 applied
  (`_pre_010_db`), insert fixture rows, then apply 010 by itself
  (`_apply_010`) — copied in shape from `test_migrations.py`'s
  `_pre_009_db` / `_apply_009` (lines ~817-841) and its stem-idempotency
  test (~line 940).
"""

from __future__ import annotations

import os
import pathlib

import aiosqlite
import pytest

from app.database import apply_migration_file
from app.services import project_roots_service

MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"
_M010 = "010_project_roots"


async def _pre_010_db(tmp_path: pathlib.Path, filename: str = "pre-010.db"):
    """A connection with every migration before 010 applied."""
    conn = await aiosqlite.connect(str(tmp_path / filename))
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON")
    for migration_file in sorted(
        f for f in MIGRATIONS_DIR.glob("*.sql") if f.stem < _M010
    ):
        await apply_migration_file(conn, migration_file)
    return conn


async def _apply_010(conn: aiosqlite.Connection) -> None:
    await apply_migration_file(conn, MIGRATIONS_DIR / f"{_M010}.sql")


async def _insert_project(
    conn: aiosqlite.Connection,
    name: str,
    *,
    path: str | None = None,
    root_path: str | None = None,
    is_workspace: bool = False,
) -> None:
    await conn.execute(
        "INSERT INTO projects (name, status, path, root_path, is_workspace) "
        "VALUES (?, 'active', ?, ?, ?)",
        (name, path, root_path, 1 if is_workspace else 0),
    )
    await conn.commit()


# ─── Migration shape ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_project_roots_table_shape(migrated_db) -> None:
    cur = await migrated_db.execute("PRAGMA table_info(project_roots)")
    rows = await cur.fetchall()
    by_name = {r["name"]: r for r in rows}
    assert set(by_name) == {"id", "path", "label", "source", "enabled", "created_at"}
    assert by_name["path"]["notnull"] == 1
    assert by_name["source"]["notnull"] == 1
    assert by_name["enabled"]["notnull"] == 1
    assert by_name["enabled"]["dflt_value"] == "1"
    assert by_name["label"]["notnull"] == 0


@pytest.mark.asyncio
async def test_project_roots_path_is_unique(migrated_db) -> None:
    await migrated_db.execute(
        "INSERT INTO project_roots (path, source) VALUES ('/x/Projects', 'manual')"
    )
    await migrated_db.commit()
    with pytest.raises(aiosqlite.IntegrityError):
        await migrated_db.execute(
            "INSERT INTO project_roots (path, source) VALUES ('/x/Projects', 'manual')"
        )


@pytest.mark.asyncio
async def test_fresh_install_seeds_no_roots(migrated_db) -> None:
    cur = await migrated_db.execute("SELECT COUNT(*) AS cnt FROM project_roots")
    row = await cur.fetchone()
    assert row is not None
    assert row["cnt"] == 0


@pytest.mark.asyncio
async def test_migration_010_stem_recorded_once_and_rerun_is_a_noop(
    tmp_path, monkeypatch
) -> None:
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
        row = await (
            await conn.execute(
                "SELECT COUNT(*) AS cnt FROM schema_migrations WHERE version = ?",
                (_M010,),
            )
        ).fetchone()
        assert row is not None
        assert row["cnt"] == 1

        cur = await conn.execute("PRAGMA table_info(project_roots)")
        assert {r["name"] for r in await cur.fetchall()}
    finally:
        if db_module._db is not None:
            await db_module._db.close()
        db_module._db = None


# ─── Seeding rule ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_seed_inserts_the_parent_of_two_projects(tmp_path) -> None:
    conn = await _pre_010_db(tmp_path)
    try:
        await _insert_project(conn, "a", root_path="/x/Projects/a")
        await _insert_project(conn, "b", root_path="/x/Projects/b")
        await _apply_010(conn)

        rows = await (await conn.execute("SELECT * FROM project_roots")).fetchall()
        assert len(rows) == 1
        assert rows[0]["path"] == "/x/Projects"
        assert rows[0]["source"] == "seeded"
        assert rows[0]["enabled"] == 1
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_seed_ignores_a_lone_project(tmp_path) -> None:
    conn = await _pre_010_db(tmp_path)
    try:
        await _insert_project(conn, "a", root_path="/x/Projects/a")
        await _apply_010(conn)

        cnt = (
            await (
                await conn.execute("SELECT COUNT(*) AS cnt FROM project_roots")
            ).fetchone()
        )["cnt"]
        assert cnt == 0
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_seed_excludes_the_workspace_project(tmp_path) -> None:
    conn = await _pre_010_db(tmp_path)
    try:
        await _insert_project(conn, "a", root_path="/x/Projects/a")
        await _insert_project(
            conn, "workspace", root_path="/x/Projects/workspace", is_workspace=True
        )
        await _apply_010(conn)

        cnt = (
            await (
                await conn.execute("SELECT COUNT(*) AS cnt FROM project_roots")
            ).fetchone()
        )["cnt"]
        assert cnt == 0
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_seed_falls_back_to_path_when_root_path_is_null(tmp_path) -> None:
    conn = await _pre_010_db(tmp_path)
    try:
        await _insert_project(conn, "a", path="/x/Projects/a")
        await _insert_project(conn, "b", path="/x/Projects/b")
        await _apply_010(conn)

        rows = await (await conn.execute("SELECT * FROM project_roots")).fetchall()
        assert len(rows) == 1
        assert rows[0]["path"] == "/x/Projects"
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_seed_normalises_a_stored_trailing_slash(tmp_path) -> None:
    conn = await _pre_010_db(tmp_path)
    try:
        await _insert_project(conn, "a", root_path="/x/P/a/")
        await _insert_project(conn, "b", root_path="/x/P/b")
        await _apply_010(conn)

        rows = await (await conn.execute("SELECT * FROM project_roots")).fetchall()
        assert len(rows) == 1
        assert rows[0]["path"] == "/x/P"
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_seed_counts_distinct_project_paths_not_rows(tmp_path) -> None:
    conn = await _pre_010_db(tmp_path)
    try:
        # `root_path` is UNIQUE (uq_projects_root_path), so the duplicate has
        # to be on `path` — the column the seed falls back to when
        # `root_path` is NULL, per test_seed_falls_back_to_path_when_root_path_is_null.
        await _insert_project(conn, "a", path="/x/P/a")
        await _insert_project(conn, "a-dup", path="/x/P/a")
        await _apply_010(conn)

        cnt = (
            await (
                await conn.execute("SELECT COUNT(*) AS cnt FROM project_roots")
            ).fetchone()
        )["cnt"]
        assert cnt == 0
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_seed_skips_top_level_and_non_absolute_paths(tmp_path) -> None:
    conn = await _pre_010_db(tmp_path)
    try:
        await _insert_project(conn, "alpha", root_path="/alpha")
        await _insert_project(conn, "beta", root_path="/beta")
        await _insert_project(conn, "rel-one", root_path="rel/one")
        await _insert_project(conn, "rel-two", root_path="rel/two")
        await _apply_010(conn)

        cnt = (
            await (
                await conn.execute("SELECT COUNT(*) AS cnt FROM project_roots")
            ).fetchone()
        )["cnt"]
        assert cnt == 0
    finally:
        await conn.close()


# ─── Service: add_root ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_add_root_rejects_a_relative_path(migrated_db) -> None:
    with pytest.raises(ValueError, match="absolute"):
        await project_roots_service.add_root(migrated_db, "relative/dir")
    assert await project_roots_service.list_roots(migrated_db) == []


@pytest.mark.asyncio
async def test_add_root_rejects_a_missing_directory(migrated_db, tmp_path) -> None:
    missing = tmp_path / "nope"
    with pytest.raises(ValueError, match="not an existing directory"):
        await project_roots_service.add_root(migrated_db, str(missing))


@pytest.mark.asyncio
async def test_add_root_rejects_a_file(migrated_db, tmp_path) -> None:
    file_path = tmp_path / "a-file"
    file_path.write_text("x")
    with pytest.raises(ValueError, match="not an existing directory"):
        await project_roots_service.add_root(migrated_db, str(file_path))


@pytest.mark.asyncio
async def test_add_root_rejects_a_duplicate(migrated_db, tmp_path) -> None:
    d = tmp_path / "dir"
    d.mkdir()
    await project_roots_service.add_root(migrated_db, str(d))
    with pytest.raises(ValueError, match="already exists"):
        await project_roots_service.add_root(migrated_db, str(d))
    roots = await project_roots_service.list_roots(migrated_db)
    assert len(roots) == 1


@pytest.mark.asyncio
async def test_add_root_strips_a_trailing_slash(migrated_db, tmp_path) -> None:
    d = tmp_path / "dir"
    d.mkdir()
    result = await project_roots_service.add_root(migrated_db, str(d) + "/")
    assert result["path"] == os.path.realpath(str(d))


@pytest.mark.asyncio
async def test_add_root_resolves_symlinks(migrated_db, tmp_path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)

    result = await project_roots_service.add_root(migrated_db, str(link))
    assert result["path"] == os.path.realpath(str(real))


@pytest.mark.asyncio
async def test_add_root_rejects_an_unknown_source(migrated_db, tmp_path) -> None:
    d = tmp_path / "dir"
    d.mkdir()
    with pytest.raises(ValueError, match="unknown root source"):
        await project_roots_service.add_root(migrated_db, str(d), source="bogus")
    assert await project_roots_service.list_roots(migrated_db) == []

    d2 = tmp_path / "dir2"
    d2.mkdir()
    discovered = await project_roots_service.add_root(
        migrated_db, str(d2), source="discovered"
    )
    assert discovered["source"] == "discovered"

    d3 = tmp_path / "dir3"
    d3.mkdir()
    seeded = await project_roots_service.add_root(migrated_db, str(d3), source="seeded")
    assert seeded["source"] == "seeded"


@pytest.mark.asyncio
async def test_add_root_stores_a_blank_label_as_null(migrated_db, tmp_path) -> None:
    d = tmp_path / "dir"
    d.mkdir()
    result = await project_roots_service.add_root(migrated_db, str(d), label="")
    assert result["label"] is None


# ─── Service: set_enabled / remove_root / list_roots ────────────────────────


@pytest.mark.asyncio
async def test_set_enabled_round_trip(migrated_db, tmp_path) -> None:
    d = tmp_path / "dir"
    d.mkdir()
    created = await project_roots_service.add_root(migrated_db, str(d))

    disabled = await project_roots_service.set_enabled(
        migrated_db, created["id"], False
    )
    assert disabled["enabled"] is False
    row = await (
        await migrated_db.execute(
            "SELECT enabled FROM project_roots WHERE id = ?", (created["id"],)
        )
    ).fetchone()
    assert row["enabled"] == 0

    enabled = await project_roots_service.set_enabled(migrated_db, created["id"], True)
    assert enabled["enabled"] is True
    row = await (
        await migrated_db.execute(
            "SELECT enabled FROM project_roots WHERE id = ?", (created["id"],)
        )
    ).fetchone()
    assert row["enabled"] == 1


@pytest.mark.asyncio
async def test_set_enabled_unknown_id_raises(migrated_db) -> None:
    with pytest.raises(ValueError, match="not found"):
        await project_roots_service.set_enabled(migrated_db, 999999, True)


@pytest.mark.asyncio
async def test_remove_root_deletes_and_is_idempotent(migrated_db, tmp_path) -> None:
    d = tmp_path / "dir"
    d.mkdir()
    created = await project_roots_service.add_root(migrated_db, str(d))

    assert await project_roots_service.remove_root(migrated_db, created["id"]) is True
    assert await project_roots_service.list_roots(migrated_db) == []
    assert await project_roots_service.remove_root(migrated_db, created["id"]) is False


@pytest.mark.asyncio
async def test_list_roots_is_ordered_by_path(migrated_db, tmp_path) -> None:
    dirs = [tmp_path / name for name in ("c-dir", "a-dir", "b-dir")]
    for d in dirs:
        d.mkdir()
    for d in dirs:
        await project_roots_service.add_root(migrated_db, str(d))

    roots = await project_roots_service.list_roots(migrated_db)
    paths = [r["path"] for r in roots]
    assert paths == sorted(paths)
    assert all(r["enabled"] is True for r in roots)
    assert all(r["source"] == "manual" for r in roots)
