"""Which ingest lane may write which `agent_sessions` field, and the record of who did.

Three lanes converge on one session row and they do not agree:

* **Lane A — hooks** (`agent_service`). Real time, sees every SessionStart /
  UserPromptSubmit / PreToolUse / PostToolUse / Stop payload, and is the only
  lane that exists today. It is authoritative about *liveness* — whether a
  session is running right now, what tool it is in, when it last did anything
  — because it is the only lane that observes those as they happen.
* **Lane C — transcript scan** (#163, this phase). Reads a session's JSONL off
  disk and can prove things no hook payload carries: which client started it
  (`source_app`), which CLI build (`cli_version`), the title the model gave it.
  It works retroactively on history that already exists, which is exactly why
  it must never be trusted about liveness: a file read minutes later says
  nothing about whether the session is still alive.
* **Lane B — OTLP** (P3). Vendor-authoritative on money. Lane A's Stop handler
  prices *every* model at Sonnet rates (see `agent_service.record_stop`), so
  its `cost_usd` is an estimate that Lane B supersedes outright. Its receiver
  is `otlp_receiver_service` (#175) and its writer is
  `otlp_reconcile_service` (#176). It claims four of the five fields it is
  ranked first for; `context_tokens` is the exception, because it is a
  per-turn measurement and Lane B has only session totals — that module's
  header has the argument. Being ranked first means "if this lane writes the
  field, it wins", never "this lane must write it".

Why a registry rather than a `CASE WHEN` at each write
------------------------------------------------------
Without a record of who wrote what, "who wins" can only be expressed inside
whichever statement happens to run, and the answer then depends on hook
ordering. A Stop hook estimating cost at flat Sonnet rates would clobber Lane
B's real figure purely because Stop fires later. Encoding precedence per call
site also guarantees drift: the same class of bug as the dry-run/real-run
divergence #158 shipped and had to repair, where two code paths modelled the
same rule and one of them was wrong.

So precedence lives here, once, as data (`FIELD_LANES`), and every converted
writer asks before it writes. `grep -rn "CASE WHEN lane" app/` and
`grep -rn "LANE_RANK" app/` returning only this file is an acceptance
criterion, not a style preference.

Registered is not the same as converted
---------------------------------------
`FIELD_LANES` declares the rule for all 20 fields a second lane will ever
contest, so the policy is written down in one place from the start. Only three
writers are *converted* in P1 — `agent_service._record_git_branch`,
`_record_provenance` and `record_stop` — because those are the only fields a
second lane actually contests this phase. `_upsert_session_start` and
`session_backfill_service._apply_updates` deliberately keep their existing SQL
until Lane B needs them (P3): they are the two riskiest edits on the hook
path, and converting them buys nothing while Lane A is the only writer of the
fields they touch.

Lane B's arrival in #176 did not change that list, because neither of those two
writes any of the five money-and-token fields — `_upsert_session_start` sets
liveness, attribution and provenance columns only. What #176 *did* have to
change is that `record_stop` now **honours** the verdicts it was already
recording. Claiming and then writing regardless was invisible while Lane A was
the only writer of those columns and would have become an upward drift the
moment Lane B landed: a Stop firing after reconciliation would add its
estimated delta on top of the vendor's total while provenance still named
Lane B. Recording a claim is not the point; branching on it is.

Never raises into ingest
------------------------
`apply` and `accumulate` are reached from hook handlers. They return a
`ReconcileResult` saying what happened and swallow every failure — an
unregistered field, an unknown lane, a database still short of migration
`012_`. A caller that gets `applied=False` skips its column write and the hook
still commits its `agent_events` row. Nothing in this module commits; every
statement rides inside the caller's transaction.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import aiosqlite

logger = logging.getLogger(__name__)

# Lane identifiers. Ranked by *nothing* globally — precedence is per field, in
# FIELD_LANES, because Lane A outranks Lane C on liveness and loses to it on
# provenance. A single global ordering is exactly the mistake this table exists
# to prevent.
LANE_HOOK = "A"
LANE_OTLP = "B"
LANE_TRANSCRIPT = "C"
LANES: frozenset[str] = frozenset({LANE_HOOK, LANE_OTLP, LANE_TRANSCRIPT})

# field -> lanes that may write it, HIGHEST PRECEDENCE FIRST.
#
# Exactly 20 fields, in five groups. The count is asserted by
# tests/sidecar/test_lane_reconciler.py so this enumeration and any number
# quoted about it cannot drift apart.
#
#   money and tokens (5)  B > C > A  — Lane A prices everything at Sonnet
#                                      rates; vendor cost supersedes it.
#   provenance (5)        C > A      — only the transcript carries these at
#                                      all; Lane A has no source for them.
#   branch (1)            C > A      — the transcript records the branch the
#                                      run actually started on.
#   live switches (2)     A > C      — permission mode and effort change
#                                      mid-session (there is a live switch in
#                                      frontend/src/lib/ipc.ts), so a hook
#                                      that just observed one beats a file
#                                      read from minutes ago.
#   liveness (4)          A > C      — only hooks see these as they happen.
#   attribution (3)       A > C      — the resolver runs on the hook path.
FIELD_LANES: dict[str, tuple[str, ...]] = {
    # money and tokens
    "tokens_in": (LANE_OTLP, LANE_TRANSCRIPT, LANE_HOOK),
    "tokens_out": (LANE_OTLP, LANE_TRANSCRIPT, LANE_HOOK),
    "cost_usd": (LANE_OTLP, LANE_TRANSCRIPT, LANE_HOOK),
    "context_tokens": (LANE_OTLP, LANE_TRANSCRIPT, LANE_HOOK),
    "model": (LANE_OTLP, LANE_TRANSCRIPT, LANE_HOOK),
    # provenance — Lane C is the only source
    "source_app": (LANE_TRANSCRIPT, LANE_HOOK),
    "source_detail": (LANE_TRANSCRIPT, LANE_HOOK),
    "cli_version": (LANE_TRANSCRIPT, LANE_HOOK),
    "title": (LANE_TRANSCRIPT, LANE_HOOK),
    "title_source": (LANE_TRANSCRIPT, LANE_HOOK),
    # branch
    "git_branch": (LANE_TRANSCRIPT, LANE_HOOK),
    # live switches — a hook that saw the switch beats a stale file read
    "permission_mode": (LANE_HOOK, LANE_TRANSCRIPT),
    "effort": (LANE_HOOK, LANE_TRANSCRIPT),
    # liveness
    "status": (LANE_HOOK, LANE_TRANSCRIPT),
    "last_event_at": (LANE_HOOK, LANE_TRANSCRIPT),
    "ended_at": (LANE_HOOK, LANE_TRANSCRIPT),
    "current_tool": (LANE_HOOK, LANE_TRANSCRIPT),
    # attribution
    "project_id": (LANE_HOOK, LANE_TRANSCRIPT),
    "cwd": (LANE_HOOK, LANE_TRANSCRIPT),
    "session_kind": (LANE_HOOK, LANE_TRANSCRIPT),
}

# Rank lookup, built from FIELD_LANES so the two can never disagree. Lower is
# stronger. A lane absent from a field's tuple gets a rank worse than every
# present lane, which is what makes an unlisted lane lose without a special
# case.
LANE_RANK: dict[str, dict[str, int]] = {
    field: {lane: i for i, lane in enumerate(lanes)}
    for field, lanes in FIELD_LANES.items()
}

_UNRANKED = 1_000


@dataclass(frozen=True)
class ReconcileResult:
    """What `apply` / `accumulate` decided, and why.

    `applied` is the only field a caller must branch on: True means "your write
    won, go ahead and update the column". Everything else is for diagnosis and
    for tests, so a rejection is legible rather than a silent no-op.
    """

    applied: bool
    field: str
    lane: str
    reason: str
    winning_lane: str | None = None


def _rank(field: str, lane: str) -> int:
    return LANE_RANK.get(field, {}).get(lane, _UNRANKED)


def is_registered(field: str) -> bool:
    return field in FIELD_LANES


async def _winning_claim(
    db: aiosqlite.Connection, session_id: str, field: str
) -> str | None:
    """The strongest lane that has already claimed `field` on this session.

    None when nothing has claimed it, which is the common case on a first
    write and the reason a fresh session accepts whatever arrives first.
    """
    cursor = await db.execute(
        "SELECT lane FROM session_field_provenance WHERE session_id = ? AND field = ?",
        (session_id, field),
    )
    rows = await cursor.fetchall()
    if not rows:
        return None
    lanes = [r["lane"] if hasattr(r, "keys") else r[0] for r in rows]
    return min(lanes, key=lambda ln: _rank(field, ln))


async def _record_claim(
    db: aiosqlite.Connection, session_id: str, field: str, lane: str, value: Any
) -> None:
    """Upsert this lane's claim on this field.

    One row per (session, field, lane) — a re-write by the same lane updates
    its own row rather than appending, which is what keeps the table bounded at
    3 lanes x 20 fields per session instead of growing with every hook.
    """
    await db.execute(
        """INSERT INTO session_field_provenance
               (session_id, field, lane, value_text, claimed_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(session_id, field, lane) DO UPDATE SET
               value_text = excluded.value_text,
               claimed_at = excluded.claimed_at""",
        (session_id, field, lane, None if value is None else str(value)[:2048]),
    )


async def _decide(
    db: aiosqlite.Connection, session_id: str, lane: str, field: str, value: Any
) -> ReconcileResult:
    if lane not in LANES:
        return ReconcileResult(False, field, lane, "unknown-lane")
    if not is_registered(field):
        return ReconcileResult(False, field, lane, "unregistered-field")
    if _rank(field, lane) >= _UNRANKED:
        return ReconcileResult(False, field, lane, "lane-not-permitted")

    winner = await _winning_claim(db, session_id, field)
    if winner is not None and _rank(field, winner) < _rank(field, lane):
        return ReconcileResult(False, field, lane, "outranked", winning_lane=winner)

    await _record_claim(db, session_id, field, lane, value)
    return ReconcileResult(True, field, lane, "claimed", winning_lane=lane)


async def apply(
    db: aiosqlite.Connection, session_id: str, lane: str, field: str, value: Any
) -> ReconcileResult:
    """May `lane` set `field` to `value` on this session?

    Records the claim and returns `applied=True` when it may; the caller then
    performs its own column UPDATE. The column write is deliberately left to
    the caller: the statements differ per field (COALESCE, conditional SET
    fragments, additive updates) and centralising them here would mean this
    module owning SQL it cannot see the context of.

    Never raises — see the module docstring.
    """
    try:
        return await _decide(db, session_id, lane, field, value)
    except Exception:
        logger.warning(
            "lane reconciler: claim failed for %s.%s (lane %s)",
            session_id,
            field,
            lane,
            exc_info=True,
        )
        return ReconcileResult(False, field, lane, "error")


async def accumulate(
    db: aiosqlite.Connection, session_id: str, lane: str, field: str, delta: Any
) -> ReconcileResult:
    """Same decision as `apply`, for a field the caller *adds* to.

    Separate from `apply` because the semantics a caller must honour differ:
    on `applied=True` it runs `col = col + ?`, not `col = ?`. The precedence
    question is identical, which is why both route through `_decide` rather
    than each re-deriving the rule.
    """
    try:
        return await _decide(db, session_id, lane, field, delta)
    except Exception:
        logger.warning(
            "lane reconciler: accumulate failed for %s.%s (lane %s)",
            session_id,
            field,
            lane,
            exc_info=True,
        )
        return ReconcileResult(False, field, lane, "error")


async def read(
    db: aiosqlite.Connection, session_id: str, field: str | None = None
) -> dict[str, dict[str, Any]]:
    """Every claim on a session, as `{field: {lane, value_text, claimed_at}}`.

    Reports the *winning* lane per field, which is what the Session Inspector's
    field-provenance panel renders. The read path may raise: it is reachable
    from no hook, and a caller asking for provenance on a database that cannot
    answer should hear about it rather than be handed an empty dict.
    """
    if field is not None and not is_registered(field):
        raise ValueError(f"{field!r} is not a registered provenance field")

    sql = "SELECT field, lane, value_text, claimed_at FROM session_field_provenance WHERE session_id = ?"
    params: list[Any] = [session_id]
    if field is not None:
        sql += " AND field = ?"
        params.append(field)

    cursor = await db.execute(sql, params)
    rows = await cursor.fetchall()

    best: dict[str, dict[str, Any]] = {}
    for row in rows:
        fld = row["field"]
        current = best.get(fld)
        if current is None or _rank(fld, row["lane"]) < _rank(fld, current["lane"]):
            best[fld] = {
                "lane": row["lane"],
                "value_text": row["value_text"],
                "claimed_at": row["claimed_at"],
            }
    return best
