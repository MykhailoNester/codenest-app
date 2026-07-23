import pathlib
import pytest
import pytest_asyncio
import aiosqlite

from app.services import agent_service


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
    # Seed minimal required data: a project
    await conn.execute(
        "INSERT INTO projects(name, description) VALUES (?, ?)",
        ("TestProject", "A project for stats tests"),
    )
    await conn.commit()
    yield conn
    await conn.close()


async def _project_id(db: aiosqlite.Connection) -> int:
    cur = await db.execute("SELECT id FROM projects WHERE name='TestProject'")
    row = await cur.fetchone()
    return row["id"]  # type: ignore[index]


async def _insert_session(
    db: aiosqlite.Connection,
    session_id: str,
    profile: str,
    status: str = "ended",
    cost: float = 1.0,
    project_id: int | None = None,
    started_at: str = "datetime('now', '-1 days')",
) -> None:
    # started_at is a SQLite expression so we build the INSERT with it interpolated
    await db.execute(
        f"""
        INSERT INTO agent_sessions
            (session_id, profile, status, cost_usd, project_id,
             started_at, last_event_at, tokens_in, tokens_out)
        VALUES (?, ?, ?, ?, ?, {started_at}, {started_at}, 0, 0)
        """,
        (session_id, profile, status, cost, project_id),
    )
    await db.commit()


# ─── Tests ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_with_stats(db):
    agent_service._stats_cache.clear()
    pid = await _project_id(db)
    await _insert_session(db, "s-work-1", "work", cost=2.0, project_id=pid)
    await _insert_session(db, "s-work-2", "work", cost=3.0)
    await _insert_session(db, "s-personal-1", "personal", cost=0.5)

    result = await agent_service.list_with_stats(db, "30d")

    assert len(result) == 2
    profiles = {r["profile"]: r for r in result}
    assert "work" in profiles
    assert "personal" in profiles
    assert profiles["work"]["run_count"] == 2
    # Cost should be sum of both work sessions
    assert abs(profiles["work"]["total_cost_usd"] - 5.0) < 0.001
    assert profiles["personal"]["run_count"] == 1


@pytest.mark.asyncio
async def test_get_stats_range(db):
    agent_service._stats_cache.clear()
    # Session 2 days ago — within 7d window
    await _insert_session(
        db, "s-range-1", "work", started_at="datetime('now', '-2 days')"
    )
    # Session 10 days ago — outside 7d but within 30d
    await _insert_session(
        db, "s-range-2", "work", started_at="datetime('now', '-10 days')"
    )

    stats_7d = await agent_service.get_stats(db, "work", "7d")
    stats_30d = await agent_service.get_stats(db, "work", "30d")

    assert stats_7d["counts"]["total"] == 1
    assert stats_30d["counts"]["total"] == 2


@pytest.mark.asyncio
async def test_get_stats_tool_histogram(db):
    agent_service._stats_cache.clear()
    await _insert_session(db, "s-tools-1", "work")

    # Insert tool events: Bash x3, Read x2, Write x1
    for tool, count in [("Bash", 3), ("Read", 2), ("Write", 1)]:
        for i in range(count):
            await db.execute(
                """
                INSERT INTO agent_events
                    (session_id, event_type, tool_name, summary, payload_json, created_at)
                VALUES (?, 'PreToolUse', ?, '', '{}', datetime('now'))
                """,
                ("s-tools-1", tool),
            )
    await db.commit()

    stats = await agent_service.get_stats(db, "work", "30d")
    tools = stats["tools"]

    # Should be sorted by count descending
    assert tools[0]["name"] == "Bash"
    assert tools[0]["count"] == 3
    assert tools[1]["name"] == "Read"
    assert tools[1]["count"] == 2
    assert tools[2]["name"] == "Write"
    assert tools[2]["count"] == 1


@pytest.mark.asyncio
async def test_list_sessions_for_agent(db):
    agent_service._stats_cache.clear()
    for i in range(3):
        await _insert_session(db, f"s-page-{i}", "work")

    total, page1 = await agent_service.list_sessions_for_agent(
        db, "work", limit=2, offset=0
    )
    assert total == 3
    assert len(page1) == 2

    total2, page2 = await agent_service.list_sessions_for_agent(
        db, "work", limit=2, offset=2
    )
    assert total2 == 3
    assert len(page2) == 1

    # Page 1 and page 2 IDs must be disjoint
    ids1 = {s["session_id"] for s in page1}
    ids2 = {s["session_id"] for s in page2}
    assert ids1.isdisjoint(ids2)


@pytest.mark.asyncio
async def test_get_stats_zero_sessions(db):
    agent_service._stats_cache.clear()
    # Profile "nonexistent" has no sessions at all
    stats = await agent_service.get_stats(db, "nonexistent", "30d")
    assert stats["counts"]["total"] == 0
    assert stats["counts"]["success"] == 0
    assert stats["counts"]["failed"] == 0
    assert stats["costs"]["cost_usd"] == 0.0
    assert stats["tools"] == []
    assert stats["daily"] == []


@pytest.mark.asyncio
async def test_cache_invalidation(db):
    agent_service._stats_cache.clear()
    await _insert_session(db, "s-cache-1", "work")

    # Populate cache
    stats_before = await agent_service.get_stats(db, "work", "30d")
    assert ("agent_stats", "work", "30d") in agent_service._stats_cache

    # record_stop should clear the cache
    payload = {"session_id": "s-cache-1", "usage": {}}
    await agent_service.record_stop(db, payload)

    assert ("agent_stats", "work", "30d") not in agent_service._stats_cache
    # Ensure the returned value was correct before clearing
    assert stats_before["counts"]["total"] == 1
