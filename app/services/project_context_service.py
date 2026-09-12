"""One project, assembled from what touched it and what is configured for it (#181)."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import aiosqlite

from .otlp_receiver_service import METRIC_KEY_COST

logger = logging.getLogger(__name__)

SESSION_LIMIT = 200
_EVENT_LIMIT = 2000
_AGENT_TOOLS = ("Agent", "Task")
_SKILL_TOOL = "Skill"

# Lane A is the flat-rate hook estimate that `attribution_service` splits
# across projects. Lane B (vendor telemetry) has no project dimension at all,
# so nothing on this page may present a Lane B figure as per-project.
COST_LANE = "A"


async def _rows(
    db: aiosqlite.Connection, sql: str, params: tuple[Any, ...] = ()
) -> list[aiosqlite.Row]:
    try:
        async with db.execute(sql, params) as cur:
            return list(await cur.fetchall())
    except aiosqlite.Error:
        logger.warning("project context: query failed", exc_info=True)
        return []


def _parse(stamp: Any) -> datetime | None:
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(str(stamp).replace("T", " ").replace("Z", ""))
    except ValueError:
        return None


def _seconds(start: Any, end: Any) -> float | None:
    a, b = _parse(start), _parse(end)
    if a is None or b is None:
        return None
    return max(0.0, (b - a).total_seconds())


def _key(stamp: Any) -> str:
    # Ordering only. Normalising the separator makes the two stored spellings
    # of the same instant compare as the same instant.
    return str(stamp).replace("T", " ") if stamp else ""


def _in_windows(stamp: Any, windows: list[tuple[Any, Any]]) -> bool:
    at = _parse(stamp)
    if at is None:
        return False
    for start, end in windows:
        a, b = _parse(start), _parse(end)
        if a is None or at < a:
            continue
        if b is None or at <= b:
            return True
    return False


def _placeholders(n: int) -> str:
    return ", ".join("?" for _ in range(n))


async def _spans_by_session(
    db: aiosqlite.Connection, project_id: int
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in await _rows(
        db,
        "SELECT session_id, cwd, started_at, ended_at, last_seen_at "
        "FROM session_project_spans WHERE project_id = ?",
        (project_id,),
    ):
        entry = out.setdefault(
            row["session_id"],
            {
                "spans": 0,
                "seconds": 0.0,
                "open": False,
                "first_at": None,
                "last_at": None,
                "windows": [],
                "dirs": [],
            },
        )
        end = row["ended_at"] or row["last_seen_at"]
        entry["spans"] += 1
        entry["seconds"] += _seconds(row["started_at"], end) or 0.0
        entry["open"] = entry["open"] or row["ended_at"] is None
        entry["windows"].append((row["started_at"], end))
        if row["cwd"] and row["cwd"] not in entry["dirs"]:
            entry["dirs"].append(row["cwd"])
        if entry["first_at"] is None or _key(row["started_at"]) < _key(
            entry["first_at"]
        ):
            entry["first_at"] = row["started_at"]
        if entry["last_at"] is None or _key(end) > _key(entry["last_at"]):
            entry["last_at"] = end
    return out


async def _session_rows(
    db: aiosqlite.Connection, project_id: int, span_ids: list[str]
) -> dict[str, aiosqlite.Row]:
    rows: dict[str, aiosqlite.Row] = {}
    if span_ids:
        for row in await _rows(
            db,
            "SELECT s.*, p.name AS session_project_name FROM agent_sessions s "
            "LEFT JOIN projects p ON p.id = s.project_id "
            f"WHERE s.session_id IN ({_placeholders(len(span_ids))})",
            tuple(span_ids),
        ):
            rows[row["session_id"]] = row

    # A session that never changed directory has no spans at all, so the
    # session row is the only record that it happened here.
    for row in await _rows(
        db,
        "SELECT s.*, p.name AS session_project_name FROM agent_sessions s "
        "LEFT JOIN projects p ON p.id = s.project_id "
        "WHERE s.project_id = ? AND NOT EXISTS ("
        "  SELECT 1 FROM session_project_spans sp WHERE sp.session_id = s.session_id"
        ") ORDER BY s.started_at DESC LIMIT ?",
        (project_id, SESSION_LIMIT),
    ):
        rows.setdefault(row["session_id"], row)
    return rows


async def _lane_b_cost(
    db: aiosqlite.Connection, session_ids: list[str]
) -> dict[str, float]:
    if not session_ids:
        return {}
    return {
        row["session_id"]: float(row["cost"] or 0.0)
        for row in await _rows(
            db,
            "SELECT session_id, SUM(value) AS cost FROM otlp_metric_series "
            f"WHERE metric_key = ? AND session_id IN ({_placeholders(len(session_ids))}) "
            "GROUP BY session_id",
            (METRIC_KEY_COST, *session_ids),
        )
    }


async def _ran_here(
    db: aiosqlite.Connection, windows_by_session: dict[str, list[tuple[Any, Any]]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    ids = list(windows_by_session)
    if not ids:
        return [], []

    agents: dict[str, dict[str, Any]] = {}
    skills: dict[str, dict[str, Any]] = {}
    for row in await _rows(
        db,
        "SELECT session_id, tool_name, created_at,"
        " json_extract(payload_json, '$.tool_input.subagent_type') AS subagent,"
        " COALESCE(json_extract(payload_json, '$.tool_input.skill'),"
        "          json_extract(payload_json, '$.tool_input.command'),"
        "          json_extract(payload_json, '$.tool_input.name')) AS skill"
        "  FROM agent_events WHERE event_type = 'PreToolUse'"
        f"   AND tool_name IN ({_placeholders(len(_AGENT_TOOLS) + 1)})"
        f"   AND session_id IN ({_placeholders(len(ids))})"
        " ORDER BY id DESC LIMIT ?",
        (*_AGENT_TOOLS, _SKILL_TOOL, *ids, _EVENT_LIMIT),
    ):
        windows = windows_by_session.get(row["session_id"]) or []
        # No windows means the session never moved, so all of it was here.
        # With windows, only the stretches inside this repo count: a Task or
        # Skill event carries no directory of its own.
        if windows and not _in_windows(row["created_at"], windows):
            continue
        bucket = skills if row["tool_name"] == _SKILL_TOOL else agents
        name = row["skill"] if row["tool_name"] == _SKILL_TOOL else row["subagent"]
        if not name:
            continue
        entry = bucket.setdefault(
            str(name), {"name": str(name), "runs": 0, "last_run_at": None}
        )
        entry["runs"] += 1
        if entry["last_run_at"] is None or _key(row["created_at"]) > _key(
            entry["last_run_at"]
        ):
            entry["last_run_at"] = row["created_at"]

    def ordered(bucket: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        return sorted(bucket.values(), key=lambda e: (-e["runs"], e["name"]))

    return ordered(agents), ordered(skills)


async def _roots(
    db: aiosqlite.Connection, project: dict[str, Any]
) -> list[dict[str, Any]]:
    paths = [p for p in (project.get("root_path"), project.get("path")) if p]
    out = []
    for row in await _rows(
        db,
        "SELECT id, path, label, source, enabled FROM project_roots ORDER BY path ASC",
    ):
        root = str(row["path"]).rstrip("/")
        if not any(p == root or str(p).startswith(root + "/") for p in paths):
            continue
        out.append(
            {
                "id": row["id"],
                "path": row["path"],
                "label": row["label"],
                "source": row["source"],
                "enabled": bool(row["enabled"]),
            }
        )
    return out


async def _configured(
    db: aiosqlite.Connection, project_id: int
) -> dict[str, list[dict[str, Any]]]:
    async def linked(table: str) -> list[dict[str, Any]]:
        return [
            {
                "name": row["name"],
                "enabled": bool(row["enabled"]),
                "verify_status": row["verify_status"],
                "link_path": row["link_path"],
            }
            for row in await _rows(
                db,
                f"SELECT name, enabled, verify_status, link_path FROM {table} "
                "WHERE project_id = ? ORDER BY name ASC",
                (project_id,),
            )
        ]

    mcp = [
        {"name": row["name"], "slug": row["slug"], "enabled": bool(row["enabled"])}
        for row in await _rows(
            db,
            "SELECT m.name, m.slug, m.enabled FROM mcp_server_project_scopes s "
            "JOIN mcp_servers m ON m.id = s.mcp_server_id "
            "WHERE s.project_id = ? ORDER BY m.name ASC",
            (project_id,),
        )
    ]
    presets = [
        {"id": row["id"], "name": row["name"], "target": row["target"]}
        for row in await _rows(
            db,
            "SELECT id, name, target FROM launch_presets WHERE project_id = ? "
            "ORDER BY name ASC",
            (project_id,),
        )
    ]
    return {
        "agents": await linked("project_agents"),
        "skills": await linked("project_skills"),
        "commands": await linked("project_commands"),
        "mcp_servers": mcp,
        "launch_presets": presets,
    }


async def _attention(db: aiosqlite.Connection, project_id: int) -> list[dict[str, Any]]:
    return [
        {
            "id": row["id"],
            "kind": row["kind"],
            "severity": row["severity"],
            "state": row["state"],
            "title": row["title"],
            "detail": row["detail"],
            "session_id": row["session_id"],
            "first_seen_at": row["first_seen_at"],
            "last_seen_at": row["last_seen_at"],
            "resolution": row["resolution"],
        }
        for row in await _rows(
            db,
            "SELECT * FROM attention_items WHERE project_id = ? "
            "ORDER BY state = 'open' DESC, last_seen_at DESC LIMIT 50",
            (project_id,),
        )
    ]


async def assemble(db: aiosqlite.Connection, project_id: int) -> dict[str, Any] | None:
    project_rows = await _rows(
        db,
        "SELECT p.*, pr.name AS provider_name, pf.name AS profile_name "
        "  FROM projects p"
        "  LEFT JOIN providers pr ON pr.id = p.default_provider_id"
        "  LEFT JOIN profiles pf ON pf.id = p.profile_id"
        " WHERE p.id = ?",
        (project_id,),
    )
    if not project_rows:
        return None
    project = dict(project_rows[0])

    all_spans = await _spans_by_session(db, project_id)
    # Cap before the ids reach an `IN (...)`: SQLite's variable limit is low on
    # some builds, and a query that trips it would come back empty rather than
    # loud, which would read as "nothing ever worked here".
    recent = sorted(
        all_spans, key=lambda sid: _key(all_spans[sid]["last_at"]), reverse=True
    )
    spans = {sid: all_spans[sid] for sid in recent[:SESSION_LIMIT]}
    session_rows = await _session_rows(db, project_id, list(spans))

    estimates = {
        row["session_id"]: row
        for row in await _rows(
            db,
            "SELECT session_id, cost_usd, tokens_in, tokens_out "
            "FROM session_project_costs WHERE project_id = ?",
            (project_id,),
        )
    }
    lane_b = await _lane_b_cost(db, list(session_rows))

    sessions: list[dict[str, Any]] = []
    for session_id, row in session_rows.items():
        span = spans.get(session_id)
        estimate = estimates.get(session_id)
        sessions.append(
            {
                "session_id": session_id,
                "profile": row["profile"],
                "status": row["status"],
                "started_at": row["started_at"],
                "ended_at": row["ended_at"],
                "cwd": row["cwd"],
                "session_project_name": row["session_project_name"],
                "attributed_by": "span" if span else "session",
                "spans": span["spans"] if span else 0,
                "seconds_here": span["seconds"] if span else None,
                "open_span": bool(span["open"]) if span else False,
                "first_here_at": span["first_at"] if span else row["started_at"],
                "last_here_at": span["last_at"] if span else row["ended_at"],
                "directories": span["dirs"]
                if span
                else ([row["cwd"]] if row["cwd"] else []),
                "estimated_cost_usd": (
                    float(estimate["cost_usd"]) if estimate is not None else None
                ),
                "lane_b_session_cost_usd": lane_b.get(session_id),
            }
        )
    sessions.sort(key=lambda s: _key(s["started_at"]), reverse=True)
    truncated = len(all_spans) > len(spans) or len(sessions) > SESSION_LIMIT
    sessions = sessions[:SESSION_LIMIT]

    agents_ran, skills_ran = await _ran_here(
        db, {sid: (spans.get(sid) or {}).get("windows") or [] for sid in session_rows}
    )

    cost = {
        "lane": COST_LANE,
        "estimate_usd": sum(float(r["cost_usd"] or 0.0) for r in estimates.values()),
        "estimate_tokens_in": sum(int(r["tokens_in"] or 0) for r in estimates.values()),
        "estimate_tokens_out": sum(
            int(r["tokens_out"] or 0) for r in estimates.values()
        ),
        "estimated_sessions": len(estimates),
        "lane_b_sessions": len(lane_b),
        "lane_b_whole_session_usd": sum(lane_b.values()) if lane_b else None,
    }

    return {
        "project": project,
        "roots": await _roots(db, project),
        "sessions": sessions,
        "sessions_truncated": truncated,
        "cost": cost,
        "agents_ran": agents_ran,
        "skills_ran": skills_ran,
        "configured": await _configured(db, project_id),
        "attention": await _attention(db, project_id),
    }
