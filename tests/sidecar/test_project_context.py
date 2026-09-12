from __future__ import annotations

import json

import aiosqlite
import pytest

from app.services import project_context_service

pytestmark = pytest.mark.asyncio


async def _project(
    db: aiosqlite.Connection, name: str, root_path: str | None = None
) -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, path, root_path) VALUES (?, ?, ?)",
        (name, root_path, root_path),
    )
    await db.commit()
    return int(cur.lastrowid)


async def _session(db: aiosqlite.Connection, session_id: str, **cols) -> None:
    keys = ["session_id", *cols]
    await db.execute(
        f"INSERT INTO agent_sessions ({', '.join(keys)}) "
        f"VALUES ({', '.join('?' for _ in keys)})",
        (session_id, *cols.values()),
    )
    await db.commit()


async def _span(
    db: aiosqlite.Connection,
    session_id: str,
    seq: int,
    project_id: int | None,
    cwd: str,
    started_at: str,
    ended_at: str | None,
    last_seen_at: str,
) -> None:
    await db.execute(
        "INSERT INTO session_project_spans "
        "(session_id, seq, project_id, cwd, started_at, ended_at, last_seen_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (session_id, seq, project_id, cwd, started_at, ended_at, last_seen_at),
    )
    await db.commit()


async def test_missing_project_is_none(migrated_db: aiosqlite.Connection) -> None:
    assert await project_context_service.assemble(migrated_db, 9999) is None


async def test_a_span_attributes_a_session_whose_session_row_points_elsewhere(
    migrated_db: aiosqlite.Connection,
) -> None:
    home = await _project(migrated_db, "home", "/Users/test/home")
    visited = await _project(migrated_db, "visited", "/Users/test/visited")
    await _session(migrated_db, "s1", cwd="/Users/test/home", project_id=home)
    await _span(
        migrated_db,
        "s1",
        1,
        visited,
        "/Users/test/visited",
        "2026-09-12T10:05:00",
        "2026-09-12T10:20:00",
        "2026-09-12T10:19:00",
    )

    report = await project_context_service.assemble(migrated_db, visited)
    session = report["sessions"][0]

    assert session["session_id"] == "s1"
    assert session["attributed_by"] == "span"
    assert session["seconds_here"] == 900.0
    assert session["session_project_name"] == "home"


async def test_a_session_that_never_moved_is_listed_from_its_session_row(
    migrated_db: aiosqlite.Connection,
) -> None:
    pid = await _project(migrated_db, "solo", "/Users/test/solo")
    await _session(migrated_db, "s1", cwd="/Users/test/solo", project_id=pid)

    report = await project_context_service.assemble(migrated_db, pid)

    assert [s["attributed_by"] for s in report["sessions"]] == ["session"]
    assert report["sessions"][0]["spans"] == 0


async def test_per_project_cost_is_the_lane_a_estimate_and_lane_b_stays_whole_session(
    migrated_db: aiosqlite.Connection,
) -> None:
    pid = await _project(migrated_db, "p", "/Users/test/p")
    await _session(migrated_db, "s1", cwd="/Users/test/p", project_id=pid)
    await migrated_db.execute(
        "INSERT INTO session_project_costs (session_id, project_id, cost_usd) "
        "VALUES (?,?,?)",
        ("s1", pid, 0.75),
    )
    await migrated_db.execute(
        "INSERT INTO otlp_metric_series "
        "(session_id, metric_key, series_key, temporality, value) VALUES (?,?,?,?,?)",
        ("s1", "cost_usd", "k", "delta", 2.50),
    )
    await migrated_db.commit()

    cost = (await project_context_service.assemble(migrated_db, pid))["cost"]

    assert cost["lane"] == "A"
    assert cost["estimate_usd"] == 0.75
    assert cost["lane_b_sessions"] == 1
    assert cost["lane_b_whole_session_usd"] == 2.50


async def test_lane_b_absent_reads_as_unobserved_not_zero(
    migrated_db: aiosqlite.Connection,
) -> None:
    pid = await _project(migrated_db, "p", "/Users/test/p")
    await _session(migrated_db, "s1", cwd="/Users/test/p", project_id=pid)

    cost = (await project_context_service.assemble(migrated_db, pid))["cost"]

    assert cost["lane_b_sessions"] == 0
    assert cost["lane_b_whole_session_usd"] is None


async def test_an_agent_run_outside_the_project_span_is_not_counted_here(
    migrated_db: aiosqlite.Connection,
) -> None:
    a = await _project(migrated_db, "a", "/Users/test/a")
    b = await _project(migrated_db, "b", "/Users/test/b")
    await _session(migrated_db, "s1", cwd="/Users/test/a", project_id=a)
    await _span(
        migrated_db,
        "s1",
        0,
        a,
        "/Users/test/a",
        "2026-09-12T10:00:00",
        "2026-09-12T10:10:00",
        "2026-09-12T10:09:00",
    )
    await _span(
        migrated_db,
        "s1",
        1,
        b,
        "/Users/test/b",
        "2026-09-12T10:10:00",
        None,
        "2026-09-12T10:30:00",
    )
    await migrated_db.executemany(
        "INSERT INTO agent_events (session_id, event_type, tool_name, payload_json, created_at) "
        "VALUES (?,?,?,?,?)",
        [
            (
                "s1",
                "PreToolUse",
                "Task",
                json.dumps({"tool_input": {"subagent_type": "early-agent"}}),
                "2026-09-12T10:05:00",
            ),
            (
                "s1",
                "PreToolUse",
                "Task",
                json.dumps({"tool_input": {"subagent_type": "late-agent"}}),
                "2026-09-12T10:20:00",
            ),
            (
                "s1",
                "PreToolUse",
                "Skill",
                json.dumps({"tool_input": {"skill": "late-skill"}}),
                "2026-09-12T10:25:00",
            ),
        ],
    )
    await migrated_db.commit()

    first = await project_context_service.assemble(migrated_db, a)
    second = await project_context_service.assemble(migrated_db, b)

    assert [x["name"] for x in first["agents_ran"]] == ["early-agent"]
    assert first["skills_ran"] == []
    assert [x["name"] for x in second["agents_ran"]] == ["late-agent"]
    assert [x["name"] for x in second["skills_ran"]] == ["late-skill"]


async def test_only_the_roots_that_parent_this_project_are_listed(
    migrated_db: aiosqlite.Connection,
) -> None:
    pid = await _project(migrated_db, "p", "/Users/test/work/p")
    await migrated_db.executemany(
        "INSERT INTO project_roots (path, source, enabled) VALUES (?,?,?)",
        [("/Users/test/work", "manual", 1), ("/Users/test/other", "manual", 1)],
    )
    await migrated_db.commit()

    roots = (await project_context_service.assemble(migrated_db, pid))["roots"]

    assert [r["path"] for r in roots] == ["/Users/test/work"]


async def test_configured_links_and_attention_are_carried(
    migrated_db: aiosqlite.Connection,
) -> None:
    pid = await _project(migrated_db, "p", "/Users/test/p")
    await migrated_db.execute(
        "INSERT INTO project_skills (project_id, name, canonical_path, link_path) "
        "VALUES (?,?,?,?)",
        (pid, "dataviz", "/Users/test/skills/dataviz", "/Users/test/p/.claude/dataviz"),
    )
    await migrated_db.execute(
        "INSERT INTO attention_items (kind, severity, dedup_key, title, project_id) "
        "VALUES (?,?,?,?,?)",
        ("task_blocked", "blocking", "k1", "Task #4 is blocked", pid),
    )
    await migrated_db.commit()

    report = await project_context_service.assemble(migrated_db, pid)

    assert [s["name"] for s in report["configured"]["skills"]] == ["dataviz"]
    assert report["skills_ran"] == []
    assert [a["title"] for a in report["attention"]] == ["Task #4 is blocked"]
