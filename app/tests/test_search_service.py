import pathlib
import pytest
import pytest_asyncio
import aiosqlite

from app.services import search_service


MIGRATIONS_DIR = pathlib.Path(__file__).parents[2] / "migrations"


async def _apply_migrations(db: aiosqlite.Connection) -> None:
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA foreign_keys=ON")
    for mig in sorted(MIGRATIONS_DIR.glob("*.sql")):
        text = mig.read_text()
        await db.executescript(text)


@pytest_asyncio.fixture
async def db(tmp_path):
    db_path = tmp_path / "test.db"
    conn = await aiosqlite.connect(str(db_path))
    conn.row_factory = aiosqlite.Row
    await _apply_migrations(conn)
    # Seed minimal required data: a project (required FK for tasks)
    await conn.execute(
        "INSERT INTO projects(name, description) VALUES (?, ?)",
        ("Test Project", "A project for tests"),
    )
    await conn.commit()
    yield conn
    await conn.close()


async def _project_id(db: aiosqlite.Connection) -> int:
    cur = await db.execute("SELECT id FROM projects WHERE name='Test Project'")
    row = await cur.fetchone()
    assert row is not None
    return row["id"]


@pytest.mark.asyncio
async def test_task_insert_then_found(db):
    pid = await _project_id(db)
    await db.execute(
        "INSERT INTO tasks(title, description, project_id) VALUES (?,?,?)",
        ("FTS5 search feature", "Implement full-text search", pid),
    )
    await db.commit()
    results = await search_service.search(db, q="FTS5", types=["task"], limit=10)
    assert any(r["type"] == "task" and "FTS5" in r["title"] for r in results)


@pytest.mark.asyncio
async def test_task_update_reflected(db):
    pid = await _project_id(db)
    cur = await db.execute(
        "INSERT INTO tasks(title, description, project_id) VALUES (?,?,?)",
        ("OldTitle task", "some description", pid),
    )
    task_id = cur.lastrowid
    await db.commit()
    await db.execute(
        "UPDATE tasks SET title=? WHERE id=?",
        ("NewTitle task", task_id),
    )
    await db.commit()
    old_results = await search_service.search(
        db, q="OldTitle", types=["task"], limit=10
    )
    new_results = await search_service.search(
        db, q="NewTitle", types=["task"], limit=10
    )
    assert not any(r["id"] == task_id for r in old_results)
    assert any(r["id"] == task_id for r in new_results)


@pytest.mark.asyncio
async def test_task_delete_removed(db):
    pid = await _project_id(db)
    cur = await db.execute(
        "INSERT INTO tasks(title, description, project_id) VALUES (?,?,?)",
        ("DeleteMe task", "will be deleted", pid),
    )
    task_id = cur.lastrowid
    await db.commit()
    await db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
    await db.commit()
    results = await search_service.search(db, q="DeleteMe", types=["task"], limit=10)
    assert not any(r["id"] == task_id for r in results)


@pytest.mark.asyncio
async def test_short_query_returns_empty(db):
    results = await search_service.search(
        db, q="a", types=["task", "project"], limit=10
    )
    assert results == []


@pytest.mark.asyncio
async def test_empty_query_returns_empty(db):
    results = await search_service.search(db, q="", types=["task"], limit=10)
    assert results == []


@pytest.mark.asyncio
async def test_special_chars_no_exception(db):
    results = await search_service.search(db, q='test"()', types=["task"], limit=10)
    assert isinstance(results, list)


@pytest.mark.asyncio
async def test_project_fts(db):
    results = await search_service.search(
        db, q="Test Project", types=["project"], limit=10
    )
    assert any(r["type"] == "project" for r in results)


@pytest.mark.asyncio
async def test_bm25_title_ranks_above_description(db):
    pid = await _project_id(db)
    await db.execute(
        "INSERT INTO tasks(title, description, project_id) VALUES (?,?,?)",
        ("uniqueterm in title", "other content here", pid),
    )
    await db.execute(
        "INSERT INTO tasks(title, description, project_id) VALUES (?,?,?)",
        ("another task", "uniqueterm appears only in description", pid),
    )
    await db.commit()
    results = await search_service.search(db, q="uniqueterm", types=["task"], limit=10)
    assert len(results) >= 2
    title_match_pos = next(i for i, r in enumerate(results) if "in title" in r["title"])
    desc_match_pos = next(
        i for i, r in enumerate(results) if "another task" in r["title"]
    )
    assert title_match_pos < desc_match_pos


@pytest.mark.asyncio
async def test_result_has_url(db):
    pid = await _project_id(db)
    await db.execute(
        "INSERT INTO tasks(title, description, project_id) VALUES (?,?,?)",
        ("url test task", "checking url field", pid),
    )
    await db.commit()
    results = await search_service.search(db, q="url test", types=["task"], limit=10)
    assert results
    assert results[0]["url"].startswith("/tasks/")
