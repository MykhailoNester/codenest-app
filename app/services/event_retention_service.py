"""Per-source retention for `agent_events` (epic #153 / #160).

Retention in this app started as exactly one policy: `schedule_service`'s
`prune_transcript_blobs` reads the single `schedule_transcript_retention_days`
app_setting and clears schedule-run transcript logs. `agent_events` had no
policy at all, and it is the table that actually grows — every hook on every
session appends a row, so the live database carries tens of thousands of them
(≈295 events per session) and hundreds of megabytes, none of it ever removed.

This module is the generalisation of that pattern rather than a second copy of
it: the same `app_settings` / `value_json` storage, the same 1–365 validation
range, the same "resolve the window, compute a cutoff, delete, log one summary
line" shape — but with the window split per *class of record*, because the
classes have wildly different value-per-byte:

  * **ephemeral** — every event belonging to a session whose
    `agent_sessions.session_kind` is `ephemeral` (migration 011 / #157): a
    harness or `/ship` worktree run under a throwaway root. These rows are
    scratch by construction, never attributable to a project, and stop being
    interesting the moment the run ends. Shortest window (7 days).
  * **tool** — the per-tool-call events on a non-ephemeral session, listed in
    `_TOOL_EVENT_TYPES`. The bulk of the table by a wide margin (~95% of rows
    live) and the coarsest per-row value: they answer "what did this session
    actually do", which matters while the work is fresh and rarely after.
    Middle window (30 days).
  * **session** — everything else on a non-ephemeral session (`SessionStart`,
    `UserPromptSubmit`, `Stop`, `SessionEnd`, and the session-grain events
    #168 added). Few rows, and each one anchors a session's shape: when it
    started, what was asked, how it ended. Longest window (90 days).

The three classes are **mutually exclusive and exhaustive** — every row lands
in exactly one, with `ephemeral` taking precedence over the event-type split.
That precedence is the point of having the class at all: a scratch run's tool
events must age out on the 7-day clock, not the 30-day one, and its
`SessionStart` must not sit around for 90 days because it happened to not be
a tool event. Exclusivity also makes the reported counts exact rather than
double-counted, and makes the prune's total equal the rows actually removed.

Two invariants this module will not break:

  * **Sessions are never deleted.** Only `agent_events` rows are. A session
    that loses every one of its events keeps its row, its counters
    (`total_tool_calls`, `tokens_in`/`tokens_out`, `cost_usd`) and its
    provenance (`project_id`, `session_kind`, `git_branch`) — those are
    rollups and attribution facts, not telemetry, and the dashboards that
    read them must not develop holes because a window elapsed. Deleting
    sessions (or projects) is explicitly out of scope for #160.
  * **Deleting rows does not shrink the database file.** SQLite returns the
    freed pages to its own freelist and reuses them for subsequent inserts;
    the file stays the size of its high-water mark until someone runs
    `VACUUM`. This module deliberately does not: `VACUUM` rewrites the whole
    database, needs room for a second copy of it, and cannot run inside a
    transaction — an unacceptable thing to do unannounced to a user's live
    DB from a background tick. The win here is that the file stops *growing*,
    not that it shrinks. `retention_payload` repeats this in the API response
    so nobody reads a large `rows_deleted` and then goes looking for the
    disk space.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import cwd_resolver_service

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------

# Rows deleted per DELETE statement. A single unbounded
# `DELETE FROM agent_events WHERE created_at < ?` on the live table would take
# one write lock over ~40k rows *and* fire the `agent_events_fts_ad` trigger
# for every one of them, stalling the hook ingest path that Claude Code blocks
# on. Batching bounds each statement and each transaction, so the prune
# interleaves with hook writes instead of blocking them.
_BATCH_ROWS = 5000

# `event_type` values written by `agent_service._append_event` for tool
# activity. Everything else is the `session` class by exclusion, deliberately:
# a new hook type added later falls into the *longest* window rather than
# silently inheriting the shortest one.
#
# That default is the right one for a *session*-grain event and the wrong one
# for a tool-grain event, which is why this tuple had to grow when #168 widened
# ingest from 6 hook events to 22. `PermissionRequest`, `PermissionDenied` and
# `PostToolUseFailure` are each emitted once per tool call, on the same events
# and at the same volume as the `PreToolUse`/`PostToolUse` pair they sit
# alongside — they are the 30-day class by every property that put the pair
# there. Left out, they would have inherited the 90-day session window: three
# more high-volume event types on the window that exists for the handful of
# rows that anchor a session's shape, which is the growth this module was
# written to stop.
#
# The other thirteen events #168 added are genuinely session-grain — a
# `SessionStart`-like cardinality of a few rows per session — and correctly
# take the default by exclusion.
_TOOL_EVENT_TYPES: tuple[str, ...] = (
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUseFailure",
)

_TOOL_TYPE_LIST = ", ".join(f"'{t}'" for t in _TOOL_EVENT_TYPES)

# Membership of the ephemeral class. Keyed off `agent_sessions.session_kind`
# (#157) rather than re-deriving "is this cwd under a temp root" here — the
# classifier is `cwd_resolver_service` and the column is its recorded answer,
# so two places can never disagree about which sessions are scratch.
# `EXISTS` rather than `IN (SELECT …)` so SQLite can use the session PK, and
# so an orphaned event (a row whose session went missing despite the FK)
# reads as non-ephemeral and ages out on a longer window instead of vanishing.
_EPHEMERAL_SESSION = (
    "EXISTS (SELECT 1 FROM agent_sessions s"
    " WHERE s.session_id = agent_events.session_id"
    f" AND s.session_kind = '{cwd_resolver_service.SESSION_KIND_EPHEMERAL}')"
)


@dataclass(frozen=True)
class RetentionClass:
    """One retention policy: which rows it covers, where its window is stored.

    `key` is the public name of the class — it names the field in the API
    payload (`<key>_retention_days`) and the per-class entry in the prune
    summary, so it is part of the contract and should not be renamed lightly.
    `where_sql` is a fragment appended to the prune's `WHERE`, referencing
    `agent_events` by name so it can carry correlated subqueries; the
    fragments below must stay mutually exclusive, or a row would be counted
    twice and the shortest window would stop being the one that wins.
    """

    key: str
    setting_key: str
    default_days: int
    where_sql: str


# The one and only definition of the default windows. Nothing else in the
# codebase may hardcode 7/30/90 for agent events: the resolver below, the
# GET/PUT endpoints, and the prune all read them from here, so changing a
# default is a one-line change with no second place to forget.
#
# Ordered shortest window first. Functionally irrelevant (the classes are
# disjoint, so the order cannot change what gets deleted) but it means the
# cheapest, highest-yield class is cleared before the expensive ones and the
# log lines read in window order.
RETENTION_CLASSES: tuple[RetentionClass, ...] = (
    # 7 days — every event on a `session_kind='ephemeral'` session. Scratch
    # runs under a throwaway root; nothing here outlives the run itself.
    RetentionClass(
        key="ephemeral",
        setting_key="agent_event_ephemeral_retention_days",
        default_days=7,
        where_sql=_EPHEMERAL_SESSION,
    ),
    # 30 days — the per-tool-call events on a real session. ~95% of the
    # table; the "what did it do" detail, valuable while the work is fresh.
    RetentionClass(
        key="tool",
        setting_key="agent_event_tool_retention_days",
        default_days=30,
        where_sql=f"event_type IN ({_TOOL_TYPE_LIST}) AND NOT {_EPHEMERAL_SESSION}",
    ),
    # 90 days — everything else on a real session (`SessionStart`,
    # `UserPromptSubmit`, `Stop`, `SessionEnd`). Few rows, and each anchors a
    # session's shape, so this is the window that gets the benefit of doubt.
    RetentionClass(
        key="session",
        setting_key="agent_event_session_retention_days",
        default_days=90,
        where_sql=f"event_type NOT IN ({_TOOL_TYPE_LIST}) AND NOT {_EPHEMERAL_SESSION}",
    ),
)

_CLASSES_BY_KEY: dict[str, RetentionClass] = {c.key: c for c in RETENTION_CLASSES}

# Surfaced verbatim in the GET/PUT response so the acceptance criterion
# ("the API response says so") is met by the payload and not just by docs.
FILE_SIZE_NOTE = (
    "Pruning deletes rows but does not shrink the database file: SQLite keeps"
    " the freed pages on its freelist and reuses them for new events. No"
    " VACUUM is run automatically."
)


def field_name(key: str) -> str:
    """API field carrying one class's window, e.g. `tool_retention_days`.

    Mirrors `/api/v1/schedules/retention`'s single `retention_days` field,
    extended with the class name — so the shape is recognisably the same one
    and the 400 texts can quote a real field name.
    """
    return f"{key}_retention_days"


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def default_retention_days() -> dict[str, int]:
    """The documented defaults, as `{class key: days}`."""
    return {c.key: c.default_days for c in RETENTION_CLASSES}


async def resolve_retention_days(db: aiosqlite.Connection) -> dict[str, int]:
    """Effective window per class: stored `app_settings` value, else default.

    Falling back to the default rather than to "retain forever" is a
    deliberate choice, and the one #160 leaves to the implementer: a fresh
    install prunes from the documented defaults with no setting ever written.
    It matches `prune_transcript_blobs`, which has always defaulted to 30 days
    with no row present, and it is the only behaviour that actually solves the
    problem the epic filed — #160 ships no retention UI (P1 owns that
    surface), so a policy that waited for an explicit write would leave every
    user's `agent_events` growing unbounded with no in-app way to stop it.

    An unparseable stored value falls back to that class's default too, same
    as the transcript prune: a corrupt setting must not escalate into "delete
    nothing forever" or, worse, a crash on a background tick.
    """
    effective = default_retention_days()
    placeholders = ", ".join("?" * len(RETENTION_CLASSES))
    async with db.execute(
        f"SELECT key, value_json FROM app_settings WHERE key IN ({placeholders})",
        tuple(c.setting_key for c in RETENTION_CLASSES),
    ) as cur:
        rows = await cur.fetchall()

    by_setting_key = {c.setting_key: c for c in RETENTION_CLASSES}
    for row in rows:
        cls = by_setting_key.get(row["key"])
        if cls is None:
            continue
        try:
            effective[cls.key] = int(json.loads(row["value_json"]))
        except (ValueError, TypeError, json.JSONDecodeError):
            logger.warning(
                "event retention: setting %s is not an integer; using default %dd",
                cls.setting_key,
                cls.default_days,
            )
    return effective


async def set_retention_days(db: aiosqlite.Connection, days: dict[str, int]) -> None:
    """Upsert one or more class windows into `app_settings`.

    Callers validate the range; this only stores. Same statement shape as
    `PUT /api/v1/schedules/retention` so both settings read back identically.
    """
    now = datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")
    for key, value in days.items():
        cls = _CLASSES_BY_KEY[key]
        await db.execute(
            """INSERT INTO app_settings (key, value_json, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET
                   value_json = excluded.value_json,
                   updated_at = excluded.updated_at""",
            (cls.setting_key, json.dumps(value), now),
        )
    await db.commit()


def retention_payload(days: dict[str, int]) -> dict[str, Any]:
    """The GET/PUT response body: one field per class, plus the file-size note."""
    payload: dict[str, Any] = {field_name(key): days[key] for key in days}
    payload["note"] = FILE_SIZE_NOTE
    return payload


# ---------------------------------------------------------------------------
# Prune
# ---------------------------------------------------------------------------


def _cutoff(days: int) -> str:
    """Space-separated cutoff timestamp for a `days`-wide window.

    Matches `prune_transcript_blobs`' `isoformat(sep=" ")`, which is also
    SQLite's own `CURRENT_TIMESTAMP` spelling. `agent_events.created_at` is
    written by `agent_service._now()` in the `T`-separated spelling instead,
    which is why the prune normalises the column rather than comparing it
    raw — see `_prune_class`.
    """
    return (datetime.now(UTC).replace(tzinfo=None) - timedelta(days=days)).isoformat(
        sep=" ", timespec="seconds"
    )


async def _prune_class(
    db: aiosqlite.Connection, cls: RetentionClass, retention_days: int
) -> dict[str, int]:
    """Delete one class's expired events in bounded batches.

    The `replace(created_at, 'T', ' ')` is not decoration. `agent_events` has
    two timestamp spellings in the wild: `agent_service._now()` writes
    `2026-09-09T14:30:00` on every hook, while the column's
    `DEFAULT CURRENT_TIMESTAMP` writes `2026-09-09 14:30:00`. A raw string
    comparison against either spelling is wrong for the other, because `'T'`
    sorts *above* `' '` — same-day rows would be kept or deleted depending on
    which writer produced them. Normalising the column costs a scan of a
    table we are already scanning for the session-kind correlation, once a
    day, and makes the comparison correct for both.

    The loop terminates because every batch strictly shrinks the matching set
    and we stop on the first statement that deletes nothing; a short batch
    means the set is exhausted. Each batch commits on its own so the write
    lock is never held across the whole prune.
    """
    sql = f"""
        DELETE FROM agent_events
        WHERE id IN (
            SELECT id FROM agent_events
            WHERE replace(created_at, 'T', ' ') < ?
              AND ({cls.where_sql})
            LIMIT {_BATCH_ROWS}
        )
    """
    cutoff = _cutoff(retention_days)

    rows_deleted = 0
    batches = 0
    while True:
        cursor = await db.execute(sql, (cutoff,))
        # `rowcount` is -1 when the driver cannot report a count; treat that
        # as "nothing removed" and stop rather than looping forever.
        removed = max(cursor.rowcount, 0)
        # Commit every iteration, including the empty final one: even a DELETE
        # that matches no row opens a transaction on this shared connection,
        # and leaving it open would fold the next hook write into our batch.
        await db.commit()
        if removed == 0:
            break
        rows_deleted += removed
        batches += 1
        if removed < _BATCH_ROWS:
            break

    # One line per class, in the shape of schedule_service.py's
    # `prune_transcript_blobs` summary — logged unconditionally, including the
    # zero case, so "the prune ran and found nothing" is distinguishable from
    # "the prune never ran".
    logger.info(
        "prune_agent_events[%s]: retention=%dd, rows_deleted=%d, batches=%d",
        cls.key,
        retention_days,
        rows_deleted,
        batches,
    )
    return {
        "retention_days": retention_days,
        "rows_deleted": rows_deleted,
        "batches": batches,
    }


async def prune_agent_events(
    db: aiosqlite.Connection,
    *,
    retention_days: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Delete `agent_events` rows past their class's retention window.

    Idempotent: a second call with the same clock deletes nothing, because the
    first call already removed everything on the far side of every cutoff.
    Safe to call from a background tick and safe to call twice.

    **Sessions are never deleted here** — `agent_sessions` is not written at
    all. A session whose every event has aged out keeps its row, its counters
    and its provenance.

    **This does not shrink the database file.** SQLite reuses the freed pages
    for future events rather than returning them to the filesystem, and no
    `VACUUM` is run (see the module docstring for why not). The file stops
    growing; it does not get smaller.

    Args:
        retention_days: Per-class override, `{class key: days}`. Missing keys
                        fall back to `resolve_retention_days` — the stored
                        `app_settings` value, and ultimately the documented
                        default in `RETENTION_CLASSES`.

    Returns a summary: `{"rows_deleted": N, "classes": {<key>: {...}},
    "note": ...}`.
    """
    effective = await resolve_retention_days(db)
    if retention_days:
        for key, value in retention_days.items():
            if key in effective:
                effective[key] = value

    classes: dict[str, dict[str, int]] = {}
    for cls in RETENTION_CLASSES:
        classes[cls.key] = await _prune_class(db, cls, effective[cls.key])

    return {
        "rows_deleted": sum(c["rows_deleted"] for c in classes.values()),
        "classes": classes,
        "note": FILE_SIZE_NOTE,
    }


async def prune_agent_events_if_enabled(
    db: aiosqlite.Connection,
) -> dict[str, Any] | None:
    """Tick entry point: prune unless background jobs are disabled.

    `CODENEST_DISABLE_SCHEDULE_TICK=1` is how tests and standalone uvicorn
    runs opt out of background work touching their database, and the schedule
    tick loop that calls this is already gated on it. The check is repeated
    here on purpose so the guard belongs to the prune rather than to one
    caller: nothing can wire this into a new loop and quietly start deleting
    rows in a test run. Tests that *want* the prune call
    `prune_agent_events` directly, which is never gated.

    Returns None when disabled, so a caller can tell "skipped" from
    "ran and deleted nothing".
    """
    if os.environ.get("CODENEST_DISABLE_SCHEDULE_TICK") == "1":
        return None
    return await prune_agent_events(db)
