"""Tests for `app/services/task_cost_service.py` (#267).

The two attribution routes are tested separately and then together, because
the failure that matters is not a wrong sum — it is a session counted against
a task it never worked on. Every negative case here is a branch name that
looks like a task reference and is not one.
"""

from __future__ import annotations

import aiosqlite
import pytest
import pytest_asyncio
from fastapi import HTTPException

from app.services import task_cost_service


async def _project(db: aiosqlite.Connection, name: str, root: str) -> int:
    cur = await db.execute(
        "INSERT INTO projects (name, root_path) VALUES (?, ?)", (name, root)
    )
    return int(cur.lastrowid or 0)


async def _task(db: aiosqlite.Connection, title: str, project_id: int) -> int:
    """`tasks.project_id` is NOT NULL, so every task here is given one."""
    cur = await db.execute(
        "INSERT INTO tasks (title, project_id) VALUES (?, ?)", (title, project_id)
    )
    return int(cur.lastrowid or 0)


async def _session(
    db: aiosqlite.Connection,
    session_id: str,
    *,
    cost: float = 0.0,
    tokens_in: int = 0,
    tokens_out: int = 0,
    branch: str | None = None,
    project_id: int | None = None,
    started_at: str = "2026-10-01 10:00:00",
) -> None:
    await db.execute(
        "INSERT INTO agent_sessions "
        "(session_id, cost_usd, tokens_in, tokens_out, git_branch, project_id, "
        " started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (session_id, cost, tokens_in, tokens_out, branch, project_id, started_at),
    )


async def _run_from_task(
    db: aiosqlite.Connection, session_id: str, task_id: int
) -> None:
    await db.execute(
        "INSERT INTO agent_runs (session_id, source_kind, source_id) "
        "VALUES (?, 'task', ?)",
        (session_id, task_id),
    )


@pytest_asyncio.fixture
async def proj(migrated_db: aiosqlite.Connection) -> int:
    return await _project(migrated_db, "codenest-app", "/x/codenest-app")


@pytest.mark.asyncio
async def test_no_attributed_session_is_unmeasured_not_zero(
    migrated_db: aiosqlite.Connection, proj: int
) -> None:
    task_id = await _task(migrated_db, "untouched", proj)
    out = await task_cost_service.task_cost(migrated_db, task_id)
    assert out["cost_usd"] is None
    assert out["tokens_in"] is None
    assert out["session_count"] == 0
    assert out["reason"]


@pytest.mark.asyncio
async def test_launch_attribution_sums_the_sessions_started_from_the_task(
    migrated_db: aiosqlite.Connection, proj: int
) -> None:
    task_id = await _task(migrated_db, "wired up", proj)
    await _session(migrated_db, "s1", cost=1.25, tokens_in=100, tokens_out=20)
    await _session(migrated_db, "s2", cost=0.75, tokens_in=50, tokens_out=10)
    await _session(migrated_db, "s3", cost=9.99)  # another task's session
    await _run_from_task(migrated_db, "s1", task_id)
    await _run_from_task(migrated_db, "s2", task_id)

    out = await task_cost_service.task_cost(migrated_db, task_id)
    assert out["cost_usd"] == pytest.approx(2.00)
    assert out["tokens_in"] == 150
    assert out["tokens_out"] == 30
    assert out["session_count"] == 2
    assert out["by_launch"] == 2
    assert out["by_branch"] == 0


@pytest.mark.asyncio
async def test_branch_attribution_reads_the_id_out_of_the_branch_name(
    migrated_db: aiosqlite.Connection, proj: int
) -> None:
    task_id = await _task(migrated_db, "shipped by branch", proj)
    await _session(migrated_db, "s1", cost=3.0, branch=f"feature/{task_id}-a-slug")
    await _session(migrated_db, "s2", cost=1.0, branch=f"fix/{task_id}-other")

    out = await task_cost_service.task_cost(migrated_db, task_id)
    assert out["cost_usd"] == pytest.approx(4.0)
    assert out["by_branch"] == 2
    assert {s["attributed_by"] for s in out["sessions"]} == {"branch"}


@pytest.mark.asyncio
async def test_a_session_linked_both_ways_counts_once_as_launch(
    migrated_db: aiosqlite.Connection, proj: int
) -> None:
    task_id = await _task(migrated_db, "both routes", proj)
    await _session(migrated_db, "s1", cost=2.0, branch=f"feature/{task_id}-slug")
    await _run_from_task(migrated_db, "s1", task_id)

    out = await task_cost_service.task_cost(migrated_db, task_id)
    assert out["session_count"] == 1
    assert out["cost_usd"] == pytest.approx(2.0)
    assert out["by_launch"] == 1
    assert out["by_branch"] == 0


@pytest.mark.asyncio
async def test_duplicate_runs_for_one_session_do_not_double_count(
    migrated_db: aiosqlite.Connection, proj: int
) -> None:
    task_id = await _task(migrated_db, "relaunched", proj)
    await _session(migrated_db, "s1", cost=5.0)
    await _run_from_task(migrated_db, "s1", task_id)
    await _run_from_task(migrated_db, "s1", task_id)

    out = await task_cost_service.task_cost(migrated_db, task_id)
    assert out["session_count"] == 1
    assert out["cost_usd"] == pytest.approx(5.0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "template",
    [
        "main",
        "prep/release/0.2.0",
        "task/OW-{tid}-featured-message-sdk",  # a Jira key, not a board id
        "feature/1{tid}-longer-number",
        "feature/{tid}0-longer-number",
        "feature/{tid}",  # no slug: the convention always appends one
        "{tid}-no-prefix",
    ],
)
async def test_branches_that_must_not_attribute(
    migrated_db: aiosqlite.Connection, proj: int, template: str
) -> None:
    task_id = await _task(migrated_db, "scoped", proj)
    branch = template.format(tid=task_id)
    await _session(migrated_db, "s1", cost=4.0, branch=branch, project_id=proj)

    out = await task_cost_service.task_cost(migrated_db, task_id)
    assert out["session_count"] == 0, f"{branch!r} must not attribute"


@pytest.mark.asyncio
async def test_branch_attribution_requires_the_project_to_agree(
    migrated_db: aiosqlite.Connection, proj: int
) -> None:
    theirs = await _project(migrated_db, "theirs", "/x/theirs")
    task_id = await _task(migrated_db, "scoped", proj)
    await _session(
        migrated_db, "mine", cost=1.0, branch=f"feature/{task_id}-x", project_id=proj
    )
    await _session(
        migrated_db,
        "theirs",
        cost=8.0,
        branch=f"feature/{task_id}-x",
        project_id=theirs,
    )
    # project_id NULL — admitted: nothing about it contradicts the task.
    await _session(migrated_db, "unknown", cost=2.0, branch=f"feature/{task_id}-x")

    out = await task_cost_service.task_cost(migrated_db, task_id)
    assert {s["session_id"] for s in out["sessions"]} == {"mine", "unknown"}
    assert out["cost_usd"] == pytest.approx(3.0)


@pytest.mark.asyncio
async def test_launch_attribution_ignores_the_project_guard(
    migrated_db: aiosqlite.Connection, proj: int
) -> None:
    """A launch link is observation: it outranks a project disagreement."""
    theirs = await _project(migrated_db, "theirs", "/x/theirs")
    task_id = await _task(migrated_db, "cross-repo", proj)
    await _session(migrated_db, "s1", cost=7.0, project_id=theirs)
    await _run_from_task(migrated_db, "s1", task_id)

    out = await task_cost_service.task_cost(migrated_db, task_id)
    assert out["session_count"] == 1
    assert out["cost_usd"] == pytest.approx(7.0)


@pytest.mark.asyncio
async def test_a_truncated_session_list_still_carries_the_whole_total(
    migrated_db: aiosqlite.Connection, proj: int
) -> None:
    task_id = await _task(migrated_db, "busy", proj)
    for n in range(5):
        await _session(
            migrated_db,
            f"s{n}",
            cost=1.0,
            branch=f"feature/{task_id}-x",
            started_at=f"2026-10-01 10:0{n}:00",
        )

    out = await task_cost_service.task_cost(migrated_db, task_id, limit=2)
    assert len(out["sessions"]) == 2
    assert out["session_count"] == 5
    assert out["cost_usd"] == pytest.approx(5.0)
    assert [s["session_id"] for s in out["sessions"]] == ["s4", "s3"]


@pytest.mark.asyncio
async def test_unknown_task_404s(migrated_db: aiosqlite.Connection) -> None:
    with pytest.raises(HTTPException) as exc:
        await task_cost_service.task_cost(migrated_db, 999_999)
    assert exc.value.status_code == 404
