"""The attention queue — the derived answer to "is anything waiting on me?"
(epic #153 / #162).

This module owns `attention_items` (migration 013) end to end: the producers
that compute what belongs on the queue, the upsert that keeps a recurring
condition to one row, the sweep that closes conditions which have gone away,
and the counts the Needs You page and the nav rail read.

Derived, not ingested
---------------------
Nothing writes an attention item from the outside in P1. Every row is computed
here by re-reading tables the rest of the app already maintains, which is what
makes the queue safe to rebuild from scratch at any moment and impossible to
get out of step with the data it describes. `refresh` is idempotent: running it
twice in a row changes nothing except `seen_count` and `last_seen_at`.

That also settles what happens when a condition stops being true. No producer
"closes" anything explicitly; instead each refresh compares the keys a producer
just emitted against the live rows of that producer's own kind, and resolves
the difference with `resolution='condition_cleared'`. A session that woke up, a
schedule whose next run succeeded, a task someone unblocked — all leave the
queue without anyone telling it to, and the page's "resolved today" count is
therefore a real measure of things that sorted themselves out.

The three severities
--------------------
`blocking` — something cannot continue until a human acts. **P1 has no
producer for it and the count is honestly 0.** Every blocking source in the
design (`PermissionRequest`, `Notification`, `Elicitation`) is a hook that P2
adds; the severity exists now so the page, the grouping and the rail count do
not change shape when P2 lands.

`stalled` — nobody is blocked, but nothing is moving, and it is recent enough
that someone would plausibly act on it now.

`queued` — real, wants attention eventually, does not want it this minute.

Two windows, and why a 13-day-old session is `queued` and not `stalled`
----------------------------------------------------------------------
`_IDLE_MINUTES` (30) is when a live session stops counting as "working" and
starts counting as "stopped moving" — the design states the threshold as
"no progress > 30m".

`_ABANDONED_HOURS` (24) is the second, less obvious one. On this machine every
live session is between six and thirteen days stale, because sessions are not
reliably ended: the hook that would close them does not fire when a terminal is
closed, so `agent_sessions` accumulates rows that are "live" in the schema and
abandoned in fact. Without a ceiling the very first thing the new landing page
would ever say is that eight things urgently need you, none of which do — the
page would be wrong on day one and trusted on no day after that. Past the
ceiling an item is still produced (the work really is unfinished and you may
well want to close it out) but at `queued`, which says "worth your time" rather
than "act now". `schedule_service._STALENESS_HOURS` draws the same 24-hour line
for the same reason: past a day late, a thing is not pending, it is history.

Enrichment is never a precondition
----------------------------------
The design describes the idle producer as "idle + unfinished todo", and the
mockup row reads "todo 1/4". There are **zero** `TodoWrite` rows in the events
table, so a producer that required a todo list could never fire on any database
that exists. The todo counts are therefore read opportunistically and appended
to `detail` when they happen to be there; the item is produced either way. The
same rule applies to project names and tool names: an item whose enrichment
lookup comes back empty is a plainer item, never a missing one.

Timestamps
----------
Two spellings are in the wild: `agent_service._now()` writes
`2026-09-11T08:30:00` (T-separated, naive UTC) while SQLite's
`CURRENT_TIMESTAMP` writes `2026-09-11 08:30:00`. A string comparison against
one is wrong for the other — `'T'` (0x54) sorts above every digit — so every
comparison here normalises with `replace(col, 'T', ' ')` against a
space-separated bound, the same way `event_retention_service` does.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import budget_service

# Vocabularies. Migration 013 deliberately carries no CHECK constraints (see
# its header), so these are the enforcement: a write outside them is a bug
# here, not a row in the table.
KINDS: frozenset[str] = frozenset(
    {
        "session_stalled",
        "schedule_failed",
        "budget_threshold",
        "task_blocked",
        "inbox_backlog",
    }
)
SEVERITIES: tuple[str, ...] = ("blocking", "stalled", "queued")
STATES: frozenset[str] = frozenset({"open", "resolved", "muted"})

# A live session that has not produced an event in this long has stopped
# moving. The design's "no progress > 30m".
_IDLE_MINUTES = 30

# ...and one that has not produced an event in this long is not stalled, it is
# abandoned. See the module header.
_ABANDONED_HOURS = 24

# Run outcomes that mean the schedule did not do its job. `cancelled` and
# `skipped` are excluded on purpose: both are outcomes someone or something
# chose, not failures anyone needs to be told about.
_FAILED_RUN_STATUSES: tuple[str, ...] = ("failed", "timed_out", "missed")

# Budget alerts below this share of the limit are informational — the 50%
# notification already exists and a queue entry for "half your budget is
# unspent" is noise.
_BUDGET_ALERT_FLOOR = 80

# Inbox statuses that mean "nobody has decided about this yet". `ready` is
# excluded: it has been triaged, and it is waiting on promotion rather than on
# a decision.
_INBOX_PENDING_STATUSES: tuple[str, ...] = ("inbox", "review")


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _sql_ts(moment: datetime) -> str:
    """SQLite's own `CURRENT_TIMESTAMP` spelling — space-separated, naive UTC.

    Every column this module writes and every bound it compares against uses
    this one spelling, so the table never acquires the two-spelling problem
    `agent_events` has.
    """
    return moment.isoformat(sep=" ", timespec="seconds")


def _minutes_since(stamp: str | None, moment: datetime) -> int | None:
    """Whole minutes between `stamp` and `moment`, or None if unparseable.

    Used only for display text. A timestamp we cannot parse costs the row its
    "18m" suffix and nothing else — it must never cost the row itself.
    """
    if not stamp:
        return None
    try:
        parsed = datetime.fromisoformat(stamp.replace(" ", "T"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(UTC).replace(tzinfo=None)
    return max(0, int((moment - parsed).total_seconds() // 60))


def _humanise_minutes(minutes: int | None) -> str:
    """`None` → "", 42 → "42m", 130 → "2h", 4000 → "2d"."""
    if minutes is None:
        return ""
    if minutes < 60:
        return f"{minutes}m"
    if minutes < 60 * 24:
        return f"{minutes // 60}h"
    return f"{minutes // (60 * 24)}d"


# ─── Producers ────────────────────────────────────────────────────────────────
#
# A producer answers one question — "what does this condition look like right
# now" — and returns candidate dicts. It never writes; `refresh` owns every
# write, so a producer cannot half-apply and the whole pass commits once.


async def _produce_session_stalled(
    db: aiosqlite.Connection, moment: datetime
) -> list[dict[str, Any]]:
    """Live sessions that went quiet in the middle of a turn.

    "Unfinished work" is `status = 'active'`, which is not a guess:
    `agent_service` sets `active` on every UserPromptSubmit and PreToolUse and
    only moves a session to `idle` when a `Stop` hook arrives (that same write
    clears `current_tool`). So `active` means the last thing we heard was work
    starting and we never heard it finish — a turn left open — while `idle`
    means the agent finished its turn and is waiting for a human, which is not
    a condition anyone needs to be told about. `stopped` and `ended` sessions
    are over and are excluded by the same predicate.

    The todo list is read as enrichment further down, never as a precondition:
    see the module header.
    """
    idle_cutoff = _sql_ts(moment - timedelta(minutes=_IDLE_MINUTES))
    abandoned_cutoff = _sql_ts(moment - timedelta(hours=_ABANDONED_HOURS))
    cur = await db.execute(
        """
        SELECT s.session_id,
               s.project_id,
               s.current_tool,
               s.last_event_at,
               s.cwd,
               p.name AS project_name,
               (SELECT COUNT(*) FROM agent_events e
                 WHERE e.session_id = s.session_id
                   AND e.tool_name = 'TodoWrite') AS todo_events
          FROM agent_sessions s
          LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.status = 'active'
           AND s.ended_at IS NULL
           AND replace(s.last_event_at, 'T', ' ') < ?
         ORDER BY s.last_event_at ASC
        """,
        (idle_cutoff,),
    )
    items: list[dict[str, Any]] = []
    for row in await cur.fetchall():
        quiet_for = _humanise_minutes(_minutes_since(row["last_event_at"], moment))
        abandoned = (row["last_event_at"] or "").replace("T", " ") < abandoned_cutoff
        where = row["project_name"] or row["cwd"] or "unknown project"
        bits = [where]
        if row["current_tool"]:
            bits.append(f"last tool {row['current_tool']}")
        if row["todo_events"]:
            # Enrichment only — see the module header. The count of TodoWrite
            # events is what we can state without parsing payload bodies,
            # which #159 stopped storing.
            bits.append(f"{row['todo_events']} todo update(s)")
        items.append(
            {
                "kind": "session_stalled",
                # Past the abandonment ceiling this is leftover work, not an
                # emergency. See the module header.
                "severity": "queued" if abandoned else "stalled",
                "dedup_key": f"session_stalled:{row['session_id']}",
                "title": (
                    f"Session idle {quiet_for} with unfinished work"
                    if quiet_for
                    else "Session idle with unfinished work"
                ),
                "detail": " · ".join(bits),
                "session_id": row["session_id"],
                "project_id": row["project_id"],
            }
        )
    return items


async def _produce_schedule_failed(
    db: aiosqlite.Connection, moment: datetime
) -> list[dict[str, Any]]:
    """Schedules whose most recent run did not succeed.

    Only the *latest* run per schedule, not every failed run ever. A schedule
    that failed nightly for a fortnight is one problem, and listing fourteen
    copies of it would bury everything else; it is also what makes the item
    self-resolving, since the next successful run stops the producer emitting
    the key and the sweep closes it.
    """
    del moment  # The condition is "latest run failed", which has no time bound.
    cur = await db.execute(
        f"""
        SELECT r.id       AS run_id,
               r.status,
               r.detail,
               r.fired_at,
               r.session_id,
               s.id       AS schedule_id,
               s.name     AS schedule_name,
               s.project_id
          FROM schedule_runs r
          JOIN schedules s ON s.id = r.schedule_id
         WHERE r.id = (SELECT r2.id
                         FROM schedule_runs r2
                        WHERE r2.schedule_id = r.schedule_id
                        ORDER BY r2.fired_at DESC, r2.id DESC
                        LIMIT 1)
           AND r.status IN ({",".join("?" for _ in _FAILED_RUN_STATUSES)})
         ORDER BY r.fired_at ASC
        """,
        # The only interpolation is the placeholder list, whose length comes
        # from a module constant; every value is still bound.
        _FAILED_RUN_STATUSES,
    )
    items: list[dict[str, Any]] = []
    for row in await cur.fetchall():
        detail = row["detail"] or f"run #{row['run_id']}"
        items.append(
            {
                "kind": "schedule_failed",
                "severity": "stalled",
                # Keyed on the schedule, not the run: the condition is "this
                # schedule is failing". A later run that also fails bumps
                # `seen_count` instead of minting a second row, which is the
                # difference between a queue and a log.
                "dedup_key": f"schedule_failed:{row['schedule_id']}",
                "title": f"Scheduled run {row['status']}: {row['schedule_name']}",
                "detail": detail,
                "session_id": row["session_id"],
                "project_id": row["project_id"],
                "schedule_id": row["schedule_id"],
                "payload_json": json.dumps({"run_id": row["run_id"]}),
            }
        )
    return items


async def _produce_budget_threshold(
    db: aiosqlite.Connection, moment: datetime
) -> list[dict[str, Any]]:
    """Budgets that have crossed 80% or 100% of the period they are in now.

    Scoped to the *current* period by asking `budget_service.period_bounds`
    for each budget's own period rather than trusting whatever `period_start`
    values the alert table happens to hold — last month's 100% alert is
    history, not attention. Only the highest threshold crossed in that period
    is emitted, so a budget that went through 80 and then 100 is one item
    saying 100 rather than two items disagreeing about how bad it is.
    """
    cur = await db.execute(
        "SELECT id, name, period, limit_usd, scope_type, scope_id "
        "FROM budgets WHERE enabled = 1"
    )
    items: list[dict[str, Any]] = []
    for budget in await cur.fetchall():
        start_iso, _end_iso = budget_service.period_bounds(budget["period"], moment)
        alert = await db.execute(
            "SELECT threshold, fired_at FROM budget_threshold_alerts "
            "WHERE budget_id = ? AND period_start = ? AND threshold >= ? "
            "ORDER BY threshold DESC LIMIT 1",
            (budget["id"], start_iso, _BUDGET_ALERT_FLOOR),
        )
        crossed = await alert.fetchone()
        if crossed is None:
            continue
        items.append(
            {
                "kind": "budget_threshold",
                "severity": "stalled",
                # The period is part of the key: next period's crossing of the
                # same threshold is a new condition, and the old row will have
                # been swept resolved by then.
                "dedup_key": (
                    f"budget_threshold:{budget['id']}:{start_iso}:"
                    f"{crossed['threshold']}"
                ),
                "title": (
                    f"Budget at {crossed['threshold']}% of limit: {budget['name']}"
                ),
                "detail": (
                    f"{budget['period']} budget · ${budget['limit_usd']:.2f} limit"
                ),
                "project_id": (
                    budget["scope_id"] if budget["scope_type"] == "project" else None
                ),
                "payload_json": json.dumps(
                    {"budget_id": budget["id"], "threshold": crossed["threshold"]}
                ),
            }
        )
    return items


async def _produce_task_blocked(
    db: aiosqlite.Connection, moment: datetime
) -> list[dict[str, Any]]:
    """One item per task sitting in `blocked`.

    Per task rather than aggregated, because a blocked task names the thing
    that has to happen and an aggregate ("4 tasks blocked") names nothing you
    can act on. `backlog` is excluded — deliberately, and it is the only task
    status anyone would be tempted to include here: an idea nobody has started
    is not waiting on you, and folding the backlog in would put the whole Work
    board on a page whose entire value is that everything on it is real.
    """
    del moment  # `blocked` is a state, not an age.
    cur = await db.execute(
        """
        SELECT t.id, t.title, t.project_id, t.updated_at,
               p.name AS project_name,
               (SELECT COUNT(*) FROM task_blockers b
                 WHERE b.blocked_task_id = t.id
                   AND COALESCE(b.resolved, 0) = 0) AS blocker_count
          FROM tasks t
          LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'blocked'
         ORDER BY t.updated_at ASC
        """
    )
    items: list[dict[str, Any]] = []
    for row in await cur.fetchall():
        bits = [row["project_name"] or "no project"]
        if row["blocker_count"]:
            bits.append(f"{row['blocker_count']} blocker(s)")
        items.append(
            {
                "kind": "task_blocked",
                "severity": "queued",
                "dedup_key": f"task_blocked:{row['id']}",
                "title": f"Task blocked: {row['title']}",
                "detail": " · ".join(bits),
                "project_id": row["project_id"],
                "task_id": row["id"],
            }
        )
    return items


async def _produce_inbox_backlog(
    db: aiosqlite.Connection, moment: datetime
) -> list[dict[str, Any]]:
    """One aggregate row for the untriaged inbox — never one row per item.

    This is the one producer that must aggregate. The inbox is a backlog by
    design and it is *supposed* to have things in it; twenty-two rows saying
    "an inbox item is waiting" would be twenty-two rows of the same sentence
    and would make every genuine item unfindable. One row, carrying the count
    and the age of the oldest item, is the whole of what a human can act on:
    go and triage.
    """
    cur = await db.execute(
        f"""
        SELECT COUNT(*) AS pending, MIN(created_at) AS oldest
          FROM workflow_items
         WHERE status IN ({",".join("?" for _ in _INBOX_PENDING_STATUSES)})
        """,
        # As above: placeholders are generated, values are bound.
        _INBOX_PENDING_STATUSES,
    )
    row = await cur.fetchone()
    pending = int(row["pending"]) if row else 0
    if pending == 0:
        return []
    waiting = _humanise_minutes(_minutes_since(row["oldest"] if row else None, moment))
    return [
        {
            "kind": "inbox_backlog",
            "severity": "queued",
            # A single constant key: there is only ever one of these.
            "dedup_key": "inbox_backlog",
            "title": f"{pending} inbox item(s) waiting on triage",
            "detail": f"oldest waiting {waiting}" if waiting else "awaiting triage",
        }
    ]


_PRODUCERS: tuple[
    Callable[[aiosqlite.Connection, datetime], Awaitable[list[dict[str, Any]]]], ...
] = (
    _produce_session_stalled,
    _produce_schedule_failed,
    _produce_budget_threshold,
    _produce_task_blocked,
    _produce_inbox_backlog,
)


# ─── Refresh ──────────────────────────────────────────────────────────────────


async def _unmute_expired(db: aiosqlite.Connection, moment: datetime) -> int:
    """Return muted items whose mute has run out to `open`.

    Without this, `muted_until` would be a column nothing ever reads and a mute
    would be permanent — which is not what any user who picked "4h" meant.
    """
    cur = await db.execute(
        "UPDATE attention_items SET state = 'open', muted_until = NULL "
        "WHERE state = 'muted' AND muted_until IS NOT NULL "
        "AND replace(muted_until, 'T', ' ') <= ?",
        (_sql_ts(moment),),
    )
    return cur.rowcount or 0


async def _upsert(
    db: aiosqlite.Connection, candidate: dict[str, Any], moment: datetime
) -> None:
    """Insert one candidate, or bump the live row it collides with.

    The `ON CONFLICT` target is the partial unique index from migration 013, so
    the "is this already here" question is answered by SQLite under the write
    lock rather than by a read followed by a write that another refresh could
    interleave with. Nothing but `seen_count` and `last_seen_at` is touched on
    conflict — in particular `first_seen_at` is not, because the age of the
    *condition* is the number the page sorts on and re-stamping it would make
    an hour-old stall look new on every pass.

    `severity`, `title` and `detail` are refreshed, because they legitimately
    move while the condition holds: a stalled session's idle time grows, and at
    the 24-hour ceiling its severity changes.
    """
    kind = candidate["kind"]
    severity = candidate["severity"]
    if kind not in KINDS:  # pragma: no cover — a bug here, not a data state
        raise ValueError(f"unknown attention kind {kind!r}")
    if severity not in SEVERITIES:  # pragma: no cover — ditto
        raise ValueError(f"unknown attention severity {severity!r}")
    stamp = _sql_ts(moment)
    await db.execute(
        """
        INSERT INTO attention_items
            (kind, severity, state, dedup_key, seen_count, title, detail,
             session_id, project_id, task_id, schedule_id, payload_json,
             first_seen_at, last_seen_at)
        VALUES (?, ?, 'open', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup_key) WHERE state <> 'resolved' DO UPDATE SET
            seen_count = seen_count + 1,
            last_seen_at = excluded.last_seen_at,
            severity = excluded.severity,
            title = excluded.title,
            detail = excluded.detail
        """,
        (
            kind,
            severity,
            candidate["dedup_key"],
            candidate["title"],
            candidate.get("detail"),
            candidate.get("session_id"),
            candidate.get("project_id"),
            candidate.get("task_id"),
            candidate.get("schedule_id"),
            candidate.get("payload_json"),
            stamp,
            stamp,
        ),
    )


async def _sweep_cleared(
    db: aiosqlite.Connection,
    kind: str,
    live_keys: set[str],
    moment: datetime,
) -> int:
    """Resolve this kind's live rows that the pass did not re-produce.

    Scoped per kind so a producer that raised nothing this pass (because its
    source table is empty) can only ever close its own items — a bug in one
    producer must not be able to silently empty the whole queue.
    """
    stamp = _sql_ts(moment)
    params: list[Any] = [stamp, kind]
    exclusion = ""
    if live_keys:
        exclusion = f" AND dedup_key NOT IN ({','.join('?' for _ in live_keys)})"
        params.extend(sorted(live_keys))
    cur = await db.execute(
        "UPDATE attention_items "
        "SET state = 'resolved', resolved_at = ?, resolution = 'condition_cleared' "
        "WHERE state <> 'resolved' AND kind = ?" + exclusion,
        params,
    )
    return cur.rowcount or 0


async def refresh(
    db: aiosqlite.Connection, *, now: datetime | None = None
) -> dict[str, Any]:
    """Recompute the whole queue and return the counts that result.

    Idempotent by construction — the producers read, the upsert dedups and the
    sweep closes. Called by the page's 30-second poll and by anything that has
    just changed one of the source tables.

    Returns the same shape as `counts`, plus `auto_resolved` (how many
    conditions went away on this pass), because the caller that just triggered
    a refresh is usually about to render exactly those numbers.
    """
    moment = now or _utcnow()
    await _unmute_expired(db, moment)

    produced: dict[str, set[str]] = {kind: set() for kind in KINDS}
    for producer in _PRODUCERS:
        for candidate in await producer(db, moment):
            await _upsert(db, candidate, moment)
            produced[candidate["kind"]].add(candidate["dedup_key"])

    auto_resolved = 0
    for kind, keys in produced.items():
        auto_resolved += await _sweep_cleared(db, kind, keys, moment)
    await db.commit()

    result = await counts(db, now=moment)
    result["auto_resolved"] = auto_resolved
    return result


# ─── Reads ────────────────────────────────────────────────────────────────────


async def counts(
    db: aiosqlite.Connection, *, now: datetime | None = None
) -> dict[str, Any]:
    """Per-severity open counts, plus the resolution stats the page's tiles show.

    `open` is the number the nav rail badge renders, so it is the sum of the
    three severities and nothing else: muted items are deliberately not in it
    (that is what muting is), and resolved items never were.
    """
    moment = now or _utcnow()
    cur = await db.execute(
        "SELECT severity, COUNT(*) AS n FROM attention_items "
        "WHERE state = 'open' GROUP BY severity"
    )
    by_severity = {row["severity"]: int(row["n"]) for row in await cur.fetchall()}
    out: dict[str, Any] = {sev: by_severity.get(sev, 0) for sev in SEVERITIES}
    out["open"] = sum(out[sev] for sev in SEVERITIES)

    cur = await db.execute(
        "SELECT COUNT(*) AS n FROM attention_items WHERE state = 'muted'"
    )
    muted_row = await cur.fetchone()
    out["muted"] = int(muted_row["n"]) if muted_row else 0

    # "Resolved today" is measured from UTC midnight, matching every other
    # day-boundary in the app (budget periods, the insights tick).
    midnight = _sql_ts(datetime.combine(moment.date(), datetime.min.time()))
    cur = await db.execute(
        "SELECT COUNT(*) AS n, "
        "AVG((julianday(replace(resolved_at, 'T', ' ')) "
        "     - julianday(replace(first_seen_at, 'T', ' '))) * 86400) AS mean_secs "
        "FROM attention_items WHERE state = 'resolved' AND resolved_at IS NOT NULL "
        "AND replace(resolved_at, 'T', ' ') >= ?",
        (midnight,),
    )
    resolved_row = await cur.fetchone()
    out["resolved_today"] = int(resolved_row["n"]) if resolved_row else 0
    # Mean rather than median: SQLite has no median aggregate, and computing a
    # true median would mean pulling every resolved row into Python on a query
    # the page polls every 30 seconds. The label on the page says "average" so
    # the number is not claiming to be something it is not.
    mean_secs = resolved_row["mean_secs"] if resolved_row else None
    out["resolved_today_avg_seconds"] = (
        int(mean_secs) if mean_secs is not None and out["resolved_today"] else None
    )
    return out


async def list_items(
    db: aiosqlite.Connection, *, state: str = "open", limit: int = 200
) -> list[dict[str, Any]]:
    """The queue itself: severity-grouped, oldest first within each group.

    Ordering is the design's, and it is not the same as "newest first": the
    thing that has been waiting longest is the thing most likely to have been
    missed, and a queue that sorts newest-first hides its own oldest failures
    at the bottom.

    `pane_id` is joined from `agent_sessions` rather than stored, because it is
    the one subject fact that legitimately changes while an item is open — a
    session can be re-attached to a different pane — and a stored copy would
    send "Jump to pane" somewhere that is no longer the session.
    """
    if state not in STATES:
        raise ValueError(f"unknown attention state {state!r}")
    severity_rank = " ".join(
        f"WHEN '{sev}' THEN {rank}" for rank, sev in enumerate(SEVERITIES)
    )
    cur = await db.execute(
        f"""
        SELECT a.id, a.kind, a.severity, a.state, a.dedup_key, a.seen_count,
               a.title, a.detail, a.session_id, a.project_id, a.task_id,
               a.schedule_id, a.payload_json, a.first_seen_at, a.last_seen_at,
               a.resolved_at, a.resolution, a.muted_until,
               s.pane_id AS pane_id,
               s.status  AS session_status,
               p.name    AS project_name
          FROM attention_items a
          LEFT JOIN agent_sessions s ON s.session_id = a.session_id
          LEFT JOIN projects p ON p.id = a.project_id
         WHERE a.state = ?
         ORDER BY CASE a.severity {severity_rank} ELSE {len(SEVERITIES)} END ASC,
                  a.first_seen_at ASC,
                  a.id ASC
         LIMIT ?
        """,
        # `severity_rank` is built from the SEVERITIES constant above, never
        # from input; `state` and `limit` are bound.
        (state, limit),
    )
    return [dict(row) for row in await cur.fetchall()]
