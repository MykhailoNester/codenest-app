"""What one task cost, rolled up from the sessions that worked on it.

`session_project_costs` and `session_project_spans` both stop at the project.
This adds the task rollup with no new ingest path and no new column — both
links from a session back to a task already exist:

  * `launch` — `agent_runs.source_kind='task'` / `source_id`, stamped when a
    session is launched from a task. Observation.
  * `branch` — `git_branch` of the form `<prefix>/<id>-<slug>`, the convention
    `/ship` and `/commit-message` already key commits on. Inference, and the
    only link a session started outside the app can offer.

`launch` wins when both apply. A branch-attributed session must also agree
with the task's project (`tasks.project_id` is NOT NULL) unless the session
resolved to no project at all: the board is global, branch numbers are not,
and `feature/267-…` in another repo is another tracker's 267.

The grain is the whole session. The cwd stream tells `session_project_spans`
when a session moved between repos; nothing observable says when it moved
between tickets, so splitting here would be arithmetic over a guess.

The figure is `agent_sessions.cost_usd`, not `session_project_costs` — the
per-project rows are a proportional split with explicitly approximate token
sums, while the session row is the total `lane_reconciler_service` arbitrates.

A task with no attributed session returns `cost_usd=None` and a `reason`.
Zero would claim the work was free.
"""

from __future__ import annotations

from typing import Any

import aiosqlite
from fastapi import HTTPException

# Sessions contributing to one task's rollup, newest first. Enough to show the
# list on a detail page without an unbounded read of a long-lived task.
DEFAULT_SESSION_LIMIT = 50

# Every session linked to the task, by either route, with the route named.
#
# The branch arm is `'%/' || ? || '-%'`: one path segment, then the bare id,
# then the slug separator. It matches `feature/267-x` and `fix/267-y`, and
# does not match `feature/1267-x` (no `/267-` in it), `prep/release/0.2.0`, or
# the `task/ABC-1234-…` shape of a Jira-keyed branch. A LIKE `_` wildcard
# cannot be smuggled in — the parameter is the integer id rendered as text.
_SESSIONS_SQL = """
SELECT s.session_id,
       s.cost_usd,
       s.tokens_in,
       s.tokens_out,
       s.model,
       s.status,
       s.started_at,
       s.ended_at,
       s.git_branch,
       CASE WHEN r.session_id IS NOT NULL THEN 'launch' ELSE 'branch' END
         AS attributed_by
  FROM agent_sessions s
  LEFT JOIN (SELECT DISTINCT session_id
               FROM agent_runs
              WHERE source_kind = 'task' AND source_id = ?
                AND session_id IS NOT NULL) r
    ON r.session_id = s.session_id
 WHERE r.session_id IS NOT NULL
    OR (s.git_branch LIKE '%/' || ? || '-%'
        AND (s.project_id IS NULL OR s.project_id = ?))
 ORDER BY s.started_at DESC
"""


async def task_cost(
    db: aiosqlite.Connection,
    task_id: int,
    limit: int = DEFAULT_SESSION_LIMIT,
) -> dict[str, Any]:
    """Roll one task's attributed sessions up into a single figure.

    Totals cover every attributed session; `sessions` is capped at ``limit``,
    so a truncated list never means a truncated total. 404s on an unknown task.
    """
    cur = await db.execute("SELECT project_id FROM tasks WHERE id = ?", (task_id,))
    trow = await cur.fetchone()
    if trow is None:
        raise HTTPException(status_code=404, detail="task not found")
    project_id = trow["project_id"]

    cur = await db.execute(_SESSIONS_SQL, (task_id, str(task_id), project_id))
    rows = [dict(r) for r in await cur.fetchall()]

    if not rows:
        return {
            "task_id": task_id,
            "cost_usd": None,
            "tokens_in": None,
            "tokens_out": None,
            "session_count": 0,
            "by_launch": 0,
            "by_branch": 0,
            "reason": "no session has been attributed to this task",
            "sessions": [],
        }

    by_launch = sum(1 for r in rows if r["attributed_by"] == "launch")
    return {
        "task_id": task_id,
        "cost_usd": sum(float(r["cost_usd"] or 0) for r in rows),
        "tokens_in": sum(int(r["tokens_in"] or 0) for r in rows),
        "tokens_out": sum(int(r["tokens_out"] or 0) for r in rows),
        "session_count": len(rows),
        "by_launch": by_launch,
        "by_branch": len(rows) - by_launch,
        "reason": None,
        "sessions": rows[: max(0, limit)],
    }
