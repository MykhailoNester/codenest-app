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

Derived items, and the three ingested ones
-----------------------------------------
The paragraph above is true of the five P1 producers and it is no longer true
of the whole table. `PermissionRequest`, `Notification` and `Elicitation`
(#172) are written *inward*, from the hook handler, because there is nothing
to derive them from: the fact that a session is sitting on a permission prompt
exists only in the hook payload that announced it, and by the time anything
could re-derive it the prompt has been answered and is gone.

That splits the kinds in two, and the split is load-bearing in exactly one
place. `_sweep_cleared` resolves a producer's live rows that the pass did not
re-produce; run over an ingested kind — which has no producer and so emits no
keys — it would resolve every hook-sourced item on the first refresh after it
was written. `refresh` therefore sweeps `DERIVED_KINDS` only, and the ingested
kinds end instead by being answered (`respond`) or by expiring.

The three severities
--------------------
`blocking` — something cannot continue until a human acts. This is what the
three ingested kinds write, and until #172 the severity had no producer at all
and the count was honestly 0.

Being told about a blocking item is not the same as being able to clear it.
The only channel back into a running session is the `PreToolUse` hook's stdout
(`preauth_service`); a `PermissionRequest`, an `Elicitation` or a
`Notification` is answered by the human at that session's terminal, and
`respond` here records *what the answer was*, closing the row. It does not
deliver it.

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

import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import budget_service

logger = logging.getLogger(__name__)

# Vocabularies. Migration 013 deliberately carries no CHECK constraints (see
# its header), so these are the enforcement: a write outside them is a bug
# here, not a row in the table.

# The five P1 kinds, each computed by a producer below and closed by the sweep.
DERIVED_KINDS: frozenset[str] = frozenset(
    {
        "session_stalled",
        "schedule_failed",
        "budget_threshold",
        "task_blocked",
        "inbox_backlog",
    }
)

# The three #172 kinds, written from the hook handler and never derived. Keyed
# by the `hooks_service.HookEvent.event` name that produces each, because the
# recorder's only input is that name — a second mapping from kind back to
# event would be a second thing to keep in step.
HOOK_KINDS: dict[str, str] = {
    "PermissionRequest": "permission_request",
    "Elicitation": "elicitation",
    "Notification": "notification",
}

KINDS: frozenset[str] = DERIVED_KINDS | frozenset(HOOK_KINDS.values())
SEVERITIES: tuple[str, ...] = ("blocking", "stalled", "queued")
STATES: frozenset[str] = frozenset({"open", "resolved", "muted"})

# Why a row ended. 013's header says P1 writes only `condition_cleared` and P2
# adds the human verbs; `expired` is the one non-human addition, and it is a
# resolution rather than a read-path filter for the reason `_resolve_expired`
# gives.
RESOLUTION_CONDITION_CLEARED = "condition_cleared"
RESOLUTION_EXPIRED = "expired"
RESOLUTION_ANSWERED = "answered"
RESOLUTION_DISMISSED = "dismissed"
# The two a human can choose. `answered` means the question got its answer;
# `dismissed` means the human closed the row without giving one. Kept apart
# because "how many of these did anyone actually answer" is the question that
# says whether this queue is worth anything.
HUMAN_RESOLUTIONS: tuple[str, ...] = (RESOLUTION_ANSWERED, RESOLUTION_DISMISSED)
RESOLUTIONS: frozenset[str] = frozenset(
    {RESOLUTION_CONDITION_CLEARED, RESOLUTION_EXPIRED, *HUMAN_RESOLUTIONS}
)

# How long a hook-sourced item is worth showing, per kind.
#
# `permission_request` and `elicitation` hold a session's turn open while they
# wait, and nobody who was at the keyboard leaves one for a quarter of an hour
# — past that the prompt has been answered or abandoned in the terminal and
# the row is describing a moment that has gone. A `notification` holds nothing
# open; it is an announcement, and an hour of page space is a fair price for
# one. Neither number is a deadline for the human: expiry closes the row, it
# never changes what the session does.
_HOOK_ITEM_TTL_MINUTES: dict[str, int] = {
    "permission_request": 15,
    "elicitation": 15,
    "notification": 60,
}

# Hook-sourced kinds that are literally waiting on an answer, so `respond` has
# something to record. A `notification` is an announcement and is not.
_HOOK_KINDS_AWAITING_RESPONSE: frozenset[str] = frozenset(
    {"permission_request", "elicitation"}
)

# Title and detail caps. `agent_service._MAX_PAYLOAD_STR` already lets a 2 KB
# `message` through, and a 2 KB title is a page with one row on it.
_MAX_TITLE = 120
_MAX_DETAIL = 200

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


async def _resolve_expired(db: aiosqlite.Connection, moment: datetime) -> int:
    """Resolve items whose `expires_at` has passed, with resolution `expired`.

    A resolution, not a filter in the read path, and not a mute. 013's header
    draws the line: `resolved` is "the condition went away", `muted` is "still
    true, deliberately not shown". A permission prompt whose session has moved
    on is the first of those — it is not being hidden while it waits, it has
    stopped being a thing anyone can act on — so the honest record is a
    resolved row whose `resolution` says why it ended, and "resolved today"
    counts it as what it was.

    The read-path filter is also the option that quietly breaks the table. The
    partial unique index covers live rows only, so an expired row that stays
    live keeps owning its `dedup_key`: the next genuine prompt for the same
    tool in the same session would collide with the invisible corpse and merely
    bump its `seen_count`, and the new prompt would never appear at all.
    Resolving releases the key, and the recurrence mints a new row with
    `seen_count = 1` — exactly the upsert-then-recur behaviour 013 designed the
    index for.

    Rows with a NULL `expires_at` — every derived item — are untouched.
    """
    cur = await db.execute(
        "UPDATE attention_items "
        "SET state = 'resolved', resolved_at = ?, resolution = ? "
        "WHERE state <> 'resolved' AND expires_at IS NOT NULL "
        "AND replace(expires_at, 'T', ' ') <= ?",
        (_sql_ts(moment), RESOLUTION_EXPIRED, _sql_ts(moment)),
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
    the 24-hour ceiling its severity changes. `expires_at` is refreshed for the
    same reason and it matters more: a re-delivered permission prompt is a
    prompt that is *still* waiting, so its clock restarts rather than running
    out from the first delivery.
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
             first_seen_at, last_seen_at,
             hook_event, requires_response, expires_at)
        VALUES (?, ?, 'open', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup_key) WHERE state <> 'resolved' DO UPDATE SET
            seen_count = seen_count + 1,
            last_seen_at = excluded.last_seen_at,
            severity = excluded.severity,
            title = excluded.title,
            detail = excluded.detail,
            expires_at = excluded.expires_at
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
            candidate.get("hook_event"),
            1 if candidate.get("requires_response") else 0,
            candidate.get("expires_at"),
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
    conditions went away on this pass) and `expired` (how many hook-sourced
    prompts aged out), because the caller that just triggered a refresh is
    usually about to render exactly those numbers.
    """
    moment = now or _utcnow()
    await _unmute_expired(db, moment)
    expired = await _resolve_expired(db, moment)

    # `DERIVED_KINDS`, not `KINDS`. The ingested kinds have no producer, so
    # they emit no keys, so a sweep over them would resolve every hook-sourced
    # item on the first refresh after it was written. See the module header.
    produced: dict[str, set[str]] = {kind: set() for kind in DERIVED_KINDS}
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
    result["expired"] = expired
    return result


# ─── Hook-sourced items ───────────────────────────────────────────────────────
#
# The inward half of the table. Everything above derives; everything here is
# told. Called from `agent_service.record_hook_event` inside that recorder's
# transaction, so the attention row and the `agent_events` row it came from
# commit together or not at all — the same arrangement #173 uses for cwd spans,
# and for the same reason.


def _clip(text: str, limit: int) -> str:
    """First line of *text*, trimmed to *limit* with an ellipsis if it was cut."""
    first = text.strip().splitlines()[0].strip() if text.strip() else ""
    if len(first) <= limit:
        return first
    return first[: limit - 1].rstrip() + "…"


def _payload_text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    return value.strip() if isinstance(value, str) else ""


def _fingerprint(payload: dict[str, Any]) -> str:
    """A stable short name for *this prompt*, for the dedup key.

    The ids come first because they are what Claude Code itself uses to mean
    "this exact tool call" / "this exact prompt": a re-delivery carries the
    same one, and two genuinely different prompts never share one. The hash of
    the text is the fallback for an event that carries neither, and it is a
    hash rather than the text itself because a dedup key is compared, indexed
    and read in logs, and a 2 KB key is none of those things well.

    The consequence for `Notification` is the right one by accident and worth
    stating: the same "waiting for your input" message arriving five times is
    one row seen five times, not five rows saying the same sentence.
    """
    for key in ("tool_use_id", "prompt_id"):
        value = _payload_text(payload, key)
        if value:
            return value[:64]
    material = "\x00".join(
        _payload_text(payload, key)
        for key in ("tool_name", "notification_type", "message")
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _hook_item_title(kind: str, payload: dict[str, Any]) -> str:
    message = _payload_text(payload, "message")
    tool = _payload_text(payload, "tool_name")
    if kind == "permission_request":
        return _clip(
            f"Permission requested: {tool}" if tool else "Permission requested",
            _MAX_TITLE,
        )
    if kind == "elicitation":
        return _clip(message or "Claude is asking for input", _MAX_TITLE)
    return _clip(message or "Claude sent a notification", _MAX_TITLE)


def _hook_item_detail(payload: dict[str, Any], project_name: str | None) -> str | None:
    """Enrichment, never a precondition — the module header's rule.

    The message is repeated here for `permission_request`, whose title is the
    tool name; for the other two the title already *is* the message and this
    carries only the where.
    """
    bits: list[str] = []
    notification_type = _payload_text(payload, "notification_type")
    if notification_type:
        bits.append(notification_type)
    message = _payload_text(payload, "message")
    if message:
        bits.append(_clip(message, _MAX_DETAIL))
    where = project_name or _payload_text(payload, "cwd")
    if where:
        bits.append(where)
    detail = " · ".join(bits)
    return _clip(detail, _MAX_DETAIL) if detail else None


async def record_hook_item(
    db: aiosqlite.Connection,
    event: str,
    payload: dict[str, Any],
    *,
    now: datetime | None = None,
) -> str | None:
    """Write the blocking item for one hook event; return its `dedup_key`.

    Returns None — quietly — for an event this module does not raise items
    for, and for a payload with no `session_id`. This runs inside a hook
    handler: the only outcome it must never have is an exception reaching the
    recorder, so a payload it cannot make sense of costs the queue a row and
    costs the session nothing.

    Does not commit. `record_hook_event` owns the transaction.

    The timestamps written here are this module's space-separated spelling and
    not `agent_service._now()`'s `T`-separated one, even though the caller is
    `agent_service`. Every bound `attention_items` is compared against —
    `expires_at`, `muted_until`, `resolved_at` — assumes the one spelling, and
    a table with two of them is the problem the module header exists to
    describe.
    """
    kind = HOOK_KINDS.get(event)
    if kind is None:
        return None
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return None

    moment = now or _utcnow()
    try:
        cur = await db.execute(
            "SELECT s.project_id, p.name AS project_name "
            "  FROM agent_sessions s "
            "  LEFT JOIN projects p ON p.id = s.project_id "
            " WHERE s.session_id = ?",
            (session_id,),
        )
        row = await cur.fetchone()
        project_id = row["project_id"] if row is not None else None
        project_name = row["project_name"] if row is not None else None

        ttl = _HOOK_ITEM_TTL_MINUTES[kind]
        candidate: dict[str, Any] = {
            "kind": kind,
            # The severity 013 named and P1 could not produce. All three of
            # these events mean a session has stopped and is waiting on a
            # person.
            "severity": "blocking",
            "dedup_key": f"{kind}:{session_id}:{_fingerprint(payload)}",
            "title": _hook_item_title(kind, payload),
            "detail": _hook_item_detail(payload, project_name),
            "session_id": session_id,
            "project_id": project_id,
            "hook_event": event,
            "requires_response": kind in _HOOK_KINDS_AWAITING_RESPONSE,
            "expires_at": _sql_ts(moment + timedelta(minutes=ttl)),
        }
        tool_name = _payload_text(payload, "tool_name")
        if tool_name:
            candidate["payload_json"] = json.dumps({"tool_name": tool_name})
        await _upsert(db, candidate, moment)
    except Exception:
        logger.warning(
            "attention: could not record %s item for session %s",
            event,
            session_id,
            exc_info=True,
        )
        return None
    return str(candidate["dedup_key"])


async def respond(
    db: aiosqlite.Connection,
    item_id: int,
    *,
    response: Any = None,
    resolution: str = RESOLUTION_ANSWERED,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Record a human's answer to an item and close it. None if there is no
    such live item.

    What this is and is not: it writes down what the human decided, it does
    not deliver the decision. There is no channel from this process into a
    session's permission prompt — the one channel Claude Code offers is the
    `PreToolUse` hook's stdout, which is `preauth_service`, and it answers
    prompts before they are asked rather than after. The human answers at the
    terminal; this closes the row so the page stops asking.

    `resolution` is one of `HUMAN_RESOLUTIONS`, which is 013's "P2 adds the
    human verbs" made real. `responded_at` is set even for `dismissed`,
    because the row did get human attention at that moment and the time it
    took to get it is the number the page reports.

    Deliberately refuses an already-resolved item rather than re-resolving it:
    a second answer to a closed question would overwrite the first one's
    `response_json` and rewrite when it was given.
    """
    if resolution not in HUMAN_RESOLUTIONS:
        raise ValueError(f"unknown human resolution {resolution!r}")
    moment = now or _utcnow()
    stamp = _sql_ts(moment)
    cur = await db.execute(
        "UPDATE attention_items "
        "SET state = 'resolved', resolved_at = ?, resolution = ?, "
        "    response_json = ?, responded_at = ? "
        "WHERE id = ? AND state <> 'resolved'",
        (
            stamp,
            resolution,
            json.dumps(response) if response is not None else None,
            stamp,
            item_id,
        ),
    )
    if not cur.rowcount:
        await db.rollback()
        return None
    await db.commit()
    cur = await db.execute("SELECT * FROM attention_items WHERE id = ?", (item_id,))
    row = await cur.fetchone()
    return dict(row) if row is not None else None


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
               a.hook_event, a.requires_response, a.response_json,
               a.responded_at, a.expires_at,
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
