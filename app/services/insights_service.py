"""Insights / Proactive Suggestions.

A small set of rules mines existing cost / session / budget data and
publishes actionable cards into the Inbox once per UTC day. Each card
is a regular ``workflow_items`` row with ``source='insight'`` so the
Inbox UI renders it through the normal pipeline (approve / promote /
reject buttons). The ``insight_runs`` ledger enforces "one card per
(rule, UTC day)" so a sidecar restart inside the same day cannot
re-publish.

Rule plugin shape: ``async def rule(db) -> InsightCandidate | None``.
Add a new rule by appending it to ``_RULES`` — no other wiring.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Awaitable, Callable

import aiosqlite

from . import inbox_service


log = logging.getLogger(__name__)


# ─── Thresholds (intentionally module constants, not config rows) ─────────────

# Rule 1: cost spike
SPIKE_RATIO = 2.0
SPIKE_MIN_USD = 1.0

# Rule 2: provider/model dominant share
DOMINANT_SHARE = 0.60
DOMINANT_MIN_USD = 5.0

# Rule 3: budget burn high
BURN_HIGH_PERCENT = 80.0
BURN_HIGH_PERIOD_REMAINING_FRAC = 0.30  # ≤30% of the period left


# ─── Result types ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class InsightCandidate:
    rule_key: str
    title: str
    body: str
    payload: dict[str, Any]


Rule = Callable[[aiosqlite.Connection], Awaitable[InsightCandidate | None]]


# ─── Rules ───────────────────────────────────────────────────────────────────


async def rule_cost_spike_week_over_week(
    db: aiosqlite.Connection,
) -> InsightCandidate | None:
    """Emit if last 7d total cost ≥ SPIKE_RATIO × prior 7d (and ≥ $1)."""
    last7 = await _sum_cost(db, since="-7 days", until=None)
    prev7 = await _sum_cost(db, since="-14 days", until="-7 days")
    if last7 < SPIKE_MIN_USD:
        return None
    if prev7 <= 0:
        # No baseline — don't fire so a fresh install doesn't shout on day 1.
        return None
    ratio = last7 / prev7
    if ratio < SPIKE_RATIO:
        return None
    return InsightCandidate(
        rule_key="cost_spike_week_over_week",
        title=f"Spend jumped {ratio:.1f}× week-over-week",
        body=(
            f"Last 7 days: ${last7:.2f}. Prior 7 days: ${prev7:.2f}. "
            f"Review which agent or project drove the increase."
        ),
        payload={
            "last7_usd": round(last7, 4),
            "prev7_usd": round(prev7, 4),
            "ratio": round(ratio, 3),
        },
    )


async def rule_provider_dominant_share(
    db: aiosqlite.Connection,
) -> InsightCandidate | None:
    """Emit if one provider/model > 60% of last-7d cost (and total ≥ $5)."""
    rows = await _sum_cost_by_model(db, "-7 days")
    total = sum(r["cost"] for r in rows)
    if total < DOMINANT_MIN_USD:
        return None
    top = max(rows, key=lambda r: r["cost"], default=None)
    if top is None or top["cost"] <= 0:
        return None
    share = top["cost"] / total
    if share < DOMINANT_SHARE:
        return None
    name = top["label"] or "Unknown model"
    return InsightCandidate(
        rule_key="provider_dominant_share",
        title=f"{name} is {share * 100:.0f}% of weekly spend",
        body=(
            f"${top['cost']:.2f} of ${total:.2f} this week ran on {name}. "
            f"Consider routing routine work to a cheaper model."
        ),
        payload={
            "model": name,
            "model_cost_usd": round(top["cost"], 4),
            "total_cost_usd": round(total, 4),
            "share": round(share, 3),
        },
    )


async def rule_budget_burn_high(
    db: aiosqlite.Connection,
) -> InsightCandidate | None:
    """Emit when any enabled budget is ≥80% burn with ≤30% of period remaining."""
    from . import budget_service

    try:
        summary = await budget_service.burn_summary(db)
    except Exception:
        # Tolerates older DB snapshots where the budgets table isn't migrated yet.
        return None
    now = datetime.now(UTC).replace(tzinfo=None)
    for b in summary:
        if b["percent"] < BURN_HIGH_PERCENT:
            continue
        period_start = _parse_db_ts(b["period_start"])
        period_end = _parse_db_ts(b["period_end"])
        if period_start is None or period_end is None:
            continue
        total = (period_end - period_start).total_seconds()
        elapsed = (now - period_start).total_seconds()
        if total <= 0:
            continue
        remaining_frac = max(0.0, 1.0 - elapsed / total)
        if remaining_frac > BURN_HIGH_PERIOD_REMAINING_FRAC:
            continue
        return InsightCandidate(
            rule_key="budget_burn_high",
            title=f"Budget '{b['name']}' at {b['percent']:.0f}%",
            body=(
                f"${b['spent_usd']:.2f} of ${b['limit_usd']:.2f} spent this "
                f"{b['period']} period with {remaining_frac * 100:.0f}% of "
                f"the period remaining."
            ),
            payload={
                "budget_id": b["id"],
                "percent": b["percent"],
                "remaining_frac": round(remaining_frac, 3),
            },
        )
    return None


_RULES: tuple[Rule, ...] = (
    rule_cost_spike_week_over_week,
    rule_provider_dominant_share,
    rule_budget_burn_high,
)


# ─── Aggregation helpers ──────────────────────────────────────────────────────


async def _sum_cost(
    db: aiosqlite.Connection, *, since: str, until: str | None
) -> float:
    """Sum agent_sessions.cost_usd between two SQLite ``datetime`` modifiers.

    ``since`` is a SQLite modifier (e.g. ``-7 days``). ``until=None`` means
    "up to now". When supplied, ``until`` is also a SQLite modifier.
    """
    params: list[object] = [since]
    sql = (
        "SELECT COALESCE(SUM(cost_usd), 0) AS total "
        "FROM agent_sessions "
        "WHERE started_at >= datetime('now', ?)"
    )
    if until is not None:
        sql += " AND started_at < datetime('now', ?)"
        params.append(until)
    async with db.execute(sql, params) as cur:
        row = await cur.fetchone()
    return float(row["total"] if row else 0.0)


async def _sum_cost_by_model(
    db: aiosqlite.Connection, since: str
) -> list[dict[str, Any]]:
    sql = (
        "SELECT COALESCE(model, 'unknown') AS label, "
        "       COALESCE(SUM(cost_usd), 0) AS cost "
        "FROM agent_sessions "
        "WHERE started_at >= datetime('now', ?) "
        "  AND started_at <  datetime('now') "
        "GROUP BY COALESCE(model, 'unknown')"
    )
    async with db.execute(sql, (since,)) as cur:
        rows = await cur.fetchall()
    return [{"label": r["label"], "cost": float(r["cost"])} for r in rows]


def _parse_db_ts(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None


# ─── Publish ──────────────────────────────────────────────────────────────────


def _utc_day_key() -> str:
    return datetime.now(UTC).date().isoformat()


async def generate_and_publish(
    db: aiosqlite.Connection,
) -> list[dict[str, Any]]:
    """Run every rule once; publish any new card; return what was published.

    Idempotent per (rule_key, UTC day) via the ``insight_runs`` PK.
    Individual rule failures are swallowed and logged so one bad rule
    can't block the others.

    Fast-skip: if every rule has a ledger row for today already, return
    early without re-running any aggregation SQL. Partial-fire days still
    re-evaluate the rules that haven't fired yet — same contract as the
    C1 review fix, with the steady-state polling cost dropped to a single
    indexed COUNT.
    """
    day_key = _utc_day_key()
    async with db.execute(
        "SELECT COUNT(*) AS n FROM insight_runs WHERE day_key = ?", (day_key,)
    ) as cur:
        row = await cur.fetchone()
    if row is not None and int(row["n"]) >= len(_RULES):
        return []
    published: list[dict[str, Any]] = []
    for rule in _RULES:
        try:
            candidate = await rule(db)
        except Exception:
            log.exception("insight rule %s failed; skipping", rule.__name__)
            continue
        if candidate is None:
            continue
        # PK-based dedup: try to claim the slot first; only publish if we won.
        cur = await db.execute(
            "INSERT OR IGNORE INTO insight_runs (rule_key, day_key, payload_json) "
            "VALUES (?, ?, ?)",
            (candidate.rule_key, day_key, json.dumps(candidate.payload)),
        )
        await db.commit()
        if cur.rowcount != 1:
            continue
        inbox_id = await inbox_service.create_item(
            db,
            {
                "title": candidate.title,
                "description": candidate.body,
                "source": "insight",
                "type": "idea",
                "priority": "medium",
                "status": "inbox",
            },
        )
        await db.execute(
            "UPDATE insight_runs SET inbox_id = ? WHERE rule_key = ? AND day_key = ?",
            (inbox_id, candidate.rule_key, day_key),
        )
        await db.commit()
        published.append(
            {
                "rule_key": candidate.rule_key,
                "inbox_id": inbox_id,
                "title": candidate.title,
            }
        )
    return published


async def list_runs(db: aiosqlite.Connection, limit: int = 50) -> list[dict[str, Any]]:
    """Return the most recent insight runs, newest first."""
    capped = max(1, min(int(limit), 500))
    async with db.execute(
        "SELECT * FROM insight_runs ORDER BY created_at DESC LIMIT ?", (capped,)
    ) as cur:
        rows = await cur.fetchall()
    return [dict(r) for r in rows]
