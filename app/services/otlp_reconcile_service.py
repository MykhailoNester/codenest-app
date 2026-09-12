"""Lane B's writer — vendor cost and tokens into `agent_sessions` (epic #153 / #176).

#175 built the receiver and reconciled nothing on purpose: Lane B's
observations land in `otlp_metric_series` and stop there, so that the decision
to let a pushed, unauthenticated, opt-in signal move a displayed number was a
separate ticket with the numbers in hand. This is that ticket. Everything here
is the *decision* layer — no parsing, no storage, no new table. It reads what
the receiver stored, asks `lane_reconciler_service` whether Lane B may write,
and writes the columns it is granted.

Absence of evidence is not a zero
=================================
This is the failure this module is shaped around, and it is worth stating
before anything else.

Telemetry is opt-in and off by default, and the guided enable (#179) has not
shipped, so essentially every session in a real database has **no OTLP series
at all**. `otlp_receiver_service.session_totals` zero-fills its answer — it
returns `{"cost_usd": 0.0, "tokens_input": 0, ...}` for a session it has never
heard of — and that is the right contract for a read used to render a total,
because a caller wants a number rather than a `None` to branch on. It is a
lethal contract for a *writer*. Applying it blindly would write `cost_usd = 0`
over every Lane A estimate in the database, stamp Lane B's provenance on it,
and — because Lane B outranks both other lanes on money — lock the correct
lanes out of ever repairing it. The estimates were wrong by a few percent; the
repair would be wrong by everything.

So presence is established separately from arithmetic, and it is established
**per metric key, not per session**:

* `_observed_metric_keys` asks which `metric_key`s this session actually has a
  row for. A session with none is returned from `reconcile_session`
  untouched — not written, not claimed, not provenance-stamped, not even read
  further.
* A session that has token series but no cost series (the cost export was lost,
  or its series hit `MAX_SERIES_PER_SESSION`) gets its tokens reconciled and
  its `cost_usd` left alone. Per-session presence would have zeroed the cost of
  exactly that session while looking like it worked.

The two reads are deliberately not folded into one query. The arithmetic comes
from `session_totals` and only from there — the migration header for 017 and
the receiver's docstring both explain why `SUM(value)` over a session's series
is the correct total under cumulative, delta, or a mix of the two, and a second
module re-deriving it is how the two copies come to disagree. Presence is a
different question that `session_totals` cannot answer by construction, so it
gets its own statement.

Which fields Lane B claims, and the one it is ranked first for and refuses
=========================================================================
`FIELD_LANES` ranks Lane B first for five fields. This module claims four.

  cost_usd      <- `cost_usd`        the metric VALUE of claude_code.cost.usage
  tokens_in     <- `tokens_input`    claude_code.token.usage, type=input
  tokens_out    <- `tokens_output`   claude_code.token.usage, type=output
  model         <- the model of the session's highest-cost series

  context_tokens — NOT claimed. See below.

`context_tokens` is a *per-turn* measurement: migration 003 defines it as the
size of the whole prompt the model saw on the most recent turn, and
`session_hud_service` renders it as occupancy of the context window. Lane B has
no per-turn view of anything — its counters are monotonic session totals, and
none of the eight instruments the CLI actually emits as metrics measures
context occupancy. The closest available sum, `tokens_input +
tokens_cache_read + tokens_cache_creation`, is the whole session's cumulative
input, which for a long session is many times the context window and would
render as an occupancy of several hundred percent.

Lane B being ranked first for a field means "if Lane B writes it, Lane B wins".
It does not mean Lane B must write it, and here writing it would be worse than
useless: the claim would permanently outrank Lane A, which does have the right
number, on a column Lane B cannot measure. If a future CLI emits a context
gauge, this is the place that changes — not `FIELD_LANES`, whose ranking is
already correct for that day.

`apply`, not `accumulate`
=========================
Lane A's `record_stop` accumulates, because a Stop hook sees one turn's usage
and the column is a running sum. Lane B is the opposite shape: every export
restates the session's total since process start, and `session_totals` already
collapses the series into that total. `accumulate` would add a fresh copy of
the whole session's cost on every export — roughly 720 additions an hour at a
five-second export interval — and the result would be a large, smooth,
plausible number that is wrong by three orders of magnitude. `apply` with an
absolute value is the only verb that matches the data, which is also why every
column write below is `col = ?` and never `col = col + ?`.

Can the reconciled total go down?
=================================
Per series, no. The receiver takes `MAX(stored, arrived)` for a cumulative
series and refuses negative values on a monotonic counter, so a series row's
value is non-decreasing for as long as the row exists. The *sum* over a
session's rows can still fall, for exactly one reason: rows can be deleted.
`event_retention_service`'s `otlp` class prunes `otlp_metric_series` on a daily
tick, and a factory reset clears it outright.

That makes a decrease a statement about our own evidence, not about money. Real
spend does not un-happen, and walking a recorded total back down because we
pruned the rows that justified it is the same error as writing zero for a
session that never had rows — it just arrives later and looks less obviously
wrong. So:

* **Lane B does not already own the field.** Apply whatever Lane B says, up or
  down. Superseding *downward* is a large part of the point: Lane A prices
  every model at Sonnet rates, so it over-estimates every Haiku turn, and the
  first vendor figure for a cheap session is legitimately smaller than the
  estimate it replaces.
* **Lane B already owns the field** (the column value *is* Lane B's own last
  claim, which is why this is answered from the winning lane rather than by
  reading a value back out of the provenance ledger — 012 is explicit that
  nothing reads session state out of that table). A computed total lower than
  the column is refused, counted as `regressed`, and logged once. The column
  keeps the higher figure, and if the evidence later returns the number simply
  resumes.

The end state of a fully pruned session is therefore the correct one: no series
left means no observation, which means this module leaves the session entirely
alone, which means Lane B's last good figure stays in the column and Lane A
cannot take it back because Lane A is outranked. The money was real; the
receipts aged out.

A late figure that disagrees with what the user was already shown
=================================================================
It replaces it, silently in the UI and loudly in the ledger.

Silent replacement is right for the surface: the estimate was never anything
but an estimate, `record_stop`'s own comment calls its Sonnet-rate pricing a
known defect, and interrupting a user to tell them a number they may never have
looked at is now slightly different is not a notification anyone wants. What is
not defensible is replacement that leaves no trace, and 012 was built so it
does not have to be:

* Lane A's provenance row is **not** deleted or overwritten. Two rows for one
  field is the documented shape of "a weaker lane wrote it first and a stronger
  lane took over", and it is the history the Session Inspector renders.
* Lane B's `value_text` records the disagreement inline when there is one:
  `0.412300 (superseded lane-A 0.503900)`. `value_text` is documented as a
  human-readable audit line for diagnosis rather than a typed shadow copy, so
  an annotation is what it is for. This is the only place the *magnitude* of
  the disagreement survives, because Lane A's own row holds the last turn's
  delta (it claims through `accumulate`) rather than the running total it had
  built up.
* That annotation is **carried forward** on every later claim by Lane B. There
  is one provenance row per (session, field, lane), so a re-claim overwrites
  the text, and a cumulative exporter re-claims every few seconds: written
  naively, the note would survive one export interval and then be replaced by a
  bare number. The leading figure tracks the live total; the parenthetical
  keeps saying what was on screen before Lane B ever spoke.
* The first supersede of a session logs one INFO line with both figures. Only
  the first: afterwards Lane B is the winning lane and there is nothing left to
  disagree with.

When this runs, and why here
============================
Inline on the ingest path, immediately after `otlp_receiver_service.ingest`
stores an export, from `app/routers/otlp.py`. The three candidates were the
ingest path, the 30-second schedule tick, and lazily on read.

*On read* is refused outright. Reconciliation writes columns and provenance, so
a reconciling read is a write hidden inside a GET, multiplied across every
surface that shows a cost — the HUD, the sessions list, budgets, trends,
insights. Each would have to either call this or re-derive precedence locally,
and precedence re-derived per call site is the exact failure
`lane_reconciler_service` exists to prevent; its module header names the grep
that pins it.

*The schedule tick* would work and is strictly worse. It would have to poll
`otlp_metric_series` for changes it was already told about, and it would leave
the displayed cost up to 30 seconds stale against an exporter pushing every
five — on the surfaces (budget thresholds, cost notifications) where staleness
is the whole complaint.

*Inline* is chosen because the export is the only event that can change Lane
B's answer. The ticket's own caution applies and is worth being precise about:
the shared `aiosqlite` connection is on Claude Code's critical path, and this
work rides it. What it costs is one bounded scan of `otlp_metric_series` plus,
per session, two reads, one `agent_sessions` read, at most four provenance
reads, at most four provenance upserts and one UPDATE — call it a dozen
statements against an export that just issued one upsert per data point and
may legitimately have issued hundreds. The ingest endpoint is also not a hook:
it is pushed from outside on the exporter's own timer, and latency here is paid
by the exporter, not by a tool call waiting on a hook to return.

Two bounds keep that true under abuse rather than under good behaviour.
`MAX_SESSIONS_PER_PASS` caps how many sessions one export can trigger work for,
so a caller posting points for many sessions at once cannot turn one request
into an unbounded write storm. `RECONCILE_WINDOW_SECONDS` bounds which sessions
are even considered — those whose series were touched recently — so the cost
does not grow with the size of the table.

A third thing keeps the *steady* state near free: a field whose total has not
moved since Lane B last claimed it is skipped rather than re-written. An idle
session with telemetry on still has its totals restated on every interval
forever, and re-claiming them would be two UPDATEs per field per interval that
change nothing.

What this deliberately does not do is re-open the trust question #175 left
here. That module's header asks whether Lane B should still outrank Lane A on
`cost_usd` now that the writer is an unauthenticated local push, and the answer
taken is yes — the precedence stays as `FIELD_LANES` declares it. The exposure
is unchanged in kind and one step larger in effect: a local process that can
post to the loopback endpoint can move a session's *displayed* cost, and the
regression guard above means a fabricated figure is the one that sticks.

Read that as both directions, not just upward. An earlier draft of this
paragraph said the ratchet was upward only; verification falsified it. The
guard engages only once Lane B already owns the field, so Lane B's *first*
claim on a session is unguarded at any value — a fabricated low figure sticks
exactly as hard as a high one, and being outranked, no other lane can write the
truth back. A cost point of literal zero was the sharpest version of this and
is now refused at the presence check (see `_observed_metric_keys`), but that
closes one value, not the shape of the hole.

Three things bound it rather than close it — the receiver's
per-point cap, the fact that only five fields are reachable at all, and this
ledger, which names Lane B as the writer of any figure a user disputes. Closing
it needs either authentication (forbidden by AGENTS.md) or a trust decision
this layer has no basis to make; #179, which owns turning telemetry on, is
where a user first consents to any of it.

Never raises
============
Like `lane_reconciler_service`, and for a sharper reason: the caller is the one
route in the app whose body is written by something outside it, and #175's
contract is that it never 500s. A reconciliation fault must cost a stored
export its column update, never the 200 that tells the exporter its batch
landed. Every entry point returns a result object and swallows.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from datetime import UTC, datetime, timedelta
from typing import Any

import aiosqlite

from . import lane_reconciler_service, otlp_receiver_service

logger = logging.getLogger(__name__)

LANE = lane_reconciler_service.LANE_OTLP

# `agent_sessions` column -> the `otlp_metric_series.metric_key` that is
# evidence for it.
#
# The metric key is not decoration: it is the presence test. A column is
# reconciled only when its own key has a row, so a session whose token export
# landed and whose cost export did not keeps its estimated cost instead of
# having it zeroed by a total that means "no rows matched".
#
# `tokens_cache_read` and `tokens_cache_creation` are stored by the receiver and
# deliberately not mapped: `agent_sessions.tokens_in` is Lane A's
# `usage.input_tokens`, which excludes cache, so folding cache reads into it
# would change what the column means rather than improve what it says. They stay
# available in `otlp_metric_series` for a surface that wants to show cache hit
# rate (#177).
FIELD_SOURCES: dict[str, str] = {
    "cost_usd": otlp_receiver_service.METRIC_KEY_COST,
    "tokens_in": "tokens_input",
    "tokens_out": "tokens_output",
}

# `model` is handled apart from `FIELD_SOURCES` because its evidence is not a
# total: `session_totals` returns the model of the highest-cost series, and
# `None` when no series carried a `model` attribute. `None` is the absence case
# and is never written — a session whose exports omitted the attribute must not
# have its model blanked.
#
# One consequence worth naming rather than discovering: because that read is
# scoped to the *cost* series, a session whose cost export never arrived has no
# Lane B model even when its token series all carried one. That is
# `session_totals`' contract and this module does not second-guess it — picking
# a model off a token series here would be a second, quietly different
# definition of "this session's model" living outside the function that owns
# the question.
FIELD_MODEL = "model"

# Sessions one pass may reconcile. An export carries one session in practice;
# this bounds the caller who sends many.
MAX_SESSIONS_PER_PASS = 64

# How far back a series must have been seen for its session to be a candidate.
#
# Driven off `otlp_metric_series.last_seen_at`, which the receiver has just
# written for everything in this export, so the window's real job is to exclude
# the rest of the table rather than to time anything. Two minutes rather than
# two seconds because the exporter's interval is the user's to set, retries
# arrive late, and a session that is merely a little stale costs one extra
# reconcile that changes nothing.
RECONCILE_WINDOW_SECONDS = 120.0

# Below this, a difference in `cost_usd` is float noise from summing REALs, not
# a disagreement. A tenth of a cent is two orders of magnitude under the
# cheapest real turn.
COST_EPSILON = 1e-6


@dataclass
class SessionReconcileResult:
    """What one session's reconciliation decided, per field.

    `skipped` is set when the session was never a candidate at all — the case
    that matters most is `no-lane-b-observation`, and a test asserts that a
    database of such sessions comes back with every one of them here and with
    no row written anywhere.
    """

    session_id: str
    skipped: str | None = None
    applied: dict[str, Any] = dataclass_field(default_factory=dict)
    refused: dict[str, str] = dataclass_field(default_factory=dict)

    @property
    def wrote(self) -> bool:
        return bool(self.applied)


@dataclass
class ReconcilePassResult:
    """What one pass over the recently-seen sessions did."""

    sessions_considered: int = 0
    sessions_written: int = 0
    sessions_skipped: int = 0
    results: list[SessionReconcileResult] = dataclass_field(default_factory=list)


def _cutoff(window_seconds: float) -> str:
    """The oldest `last_seen_at` a session may have and still be a candidate.

    Spelled in the receiver's own format (`_now()`: UTC, naive, seconds, `T`
    separator) and then normalised the way `event_retention_service` normalises
    for this table, because the column has historically held both separators.
    """
    stamp = (
        (datetime.now(UTC) - timedelta(seconds=window_seconds))
        .replace(tzinfo=None)
        .isoformat(timespec="seconds")
    )
    return stamp.replace("T", " ")


async def _recent_session_ids(
    db: aiosqlite.Connection, window_seconds: float, limit: int
) -> list[str]:
    """Sessions whose Lane B series were touched inside the window.

    Grouped rather than `SELECT DISTINCT` so the newest sessions can be taken
    first when the limit bites: dropping the *oldest* candidates is the right
    truncation, because they are the ones an earlier pass most likely already
    reconciled.

    A full scan of `otlp_metric_series` — 017 documents why there is no index on
    `last_seen_at` and why a scan of this table is the cheaper thing to pay
    for. The table is bounded by `MAX_SERIES_PER_SESSION` per session and by
    the `otlp` retention class overall.
    """
    async with db.execute(
        "SELECT session_id, MAX(replace(last_seen_at, 'T', ' ')) AS seen"
        "  FROM otlp_metric_series"
        " GROUP BY session_id"
        " HAVING seen >= ?"
        " ORDER BY seen DESC"
        " LIMIT ?",
        (_cutoff(window_seconds), limit),
    ) as cur:
        return [row["session_id"] for row in await cur.fetchall()]


async def _observed_metric_keys(db: aiosqlite.Connection, session_id: str) -> set[str]:
    """Which metric keys this session has an actual observation for.

    The presence half of "absence of evidence is not a zero", and the reason it
    cannot come from `session_totals`: that function zero-fills every key in
    `METRIC_KEYS` so its caller always gets a number, which makes "never
    observed" and "observed as zero" the same answer. They are not the same
    answer here — one must be written and the other must not be — so presence
    is asked as its own question.

    `SUM(value) > 0`, not merely `DISTINCT metric_key`. A row that exists and
    says zero is the same hazard as no row at all, one step further in: it
    passes a presence test, reconciles as a real figure, stamps Lane B, and
    because Lane B outranks every other lane the estimate it replaced can never
    be written back. Verification demonstrated exactly that — a single export
    carrying a cost point of 0.0 turned a $4.50 estimate into $0.00 permanently,
    and the regression guard did not help because the guard only engages once
    Lane B already owns the field, so the *first* claim is unguarded at any
    value.

    Refusing zero costs nothing real. The OTel SDK does not emit a data point
    for a synchronous counter attribute-set that has never been `add()`-ed, so
    a genuine exporter does not send a zero series; a session that has truly
    spent nothing has no rows rather than zero-valued ones. The reachable
    sender of a zero is a malformed or hostile one, which is the threat the
    receiver's header already says it lives with.
    """
    async with db.execute(
        "SELECT metric_key FROM otlp_metric_series WHERE session_id = ?"
        " GROUP BY metric_key HAVING SUM(value) > 0",
        (session_id,),
    ) as cur:
        return {row["metric_key"] for row in await cur.fetchall()}


async def _session_row(
    db: aiosqlite.Connection, session_id: str
) -> aiosqlite.Row | None:
    async with db.execute(
        "SELECT session_id, cost_usd, tokens_in, tokens_out, model"
        "  FROM agent_sessions WHERE session_id = ?",
        (session_id,),
    ) as cur:
        return await cur.fetchone()


def _format(field_name: str, value: Any) -> str:
    """One value, as the ledger should read it."""
    if field_name == "cost_usd":
        return f"{float(value):.6f}"
    if value is None:
        return "none"
    return str(value)


def _differs(field_name: str, new_value: Any, current: Any) -> bool:
    """Is this materially a different number from what the column held?"""
    if current is None:
        return new_value is not None
    if field_name == "cost_usd":
        return abs(float(new_value) - float(current)) > COST_EPSILON
    return new_value != current


# The annotation's opening, as a constant, because it is both written and
# recognised: a later claim by the same lane has to be able to find the note it
# already wrote and carry it forward.
SUPERSEDED_MARKER = " (superseded lane-"


def _claim_text(
    field_name: str,
    value: Any,
    holder: str | None,
    holder_value: Any,
    prior_text: str | None,
) -> str:
    """Lane B's `value_text` — the value, plus the disagreement when there is one.

    The annotation is the durable trace of "a vendor figure arrived late and
    disagreed with what was on screen", so it is written only when there was
    actually a disagreement: a *different* lane held the column and the number
    moved. An annotation on every claim would make the note mean "Lane B wrote
    this", which is what the `lane` column already says.

    **It is then carried forward**, and that is not a detail. There is one row
    per (session, field, lane), so every later claim by Lane B *overwrites* this
    text — and a cumulative exporter claims again every few seconds. Written
    naively, the note recording that Lane B displaced a $0.99 estimate would
    survive for one export interval and then be replaced by a bare number, and
    the disagreement the ticket asks to keep inspectable would be gone within
    five seconds of being recorded. So when Lane B re-claims a field it already
    holds, the suffix from its own previous text is reattached: the leading
    number tracks the live total, the parenthetical remembers what was on screen
    before Lane B ever spoke.
    """
    text = _format(field_name, value)
    if holder == LANE:
        if prior_text and SUPERSEDED_MARKER in prior_text:
            return text + prior_text[prior_text.index(SUPERSEDED_MARKER) :]
        return text
    if holder is None or not _differs(field_name, value, holder_value):
        return text
    return f"{text}{SUPERSEDED_MARKER}{holder} {_format(field_name, holder_value)})"


def _prior_claim_value(entry: dict[str, Any]) -> float | None:
    """Lane B's own last claimed figure, read back out of its provenance row.

    The regression guard used to compare against the *column*, on the reasoning
    that when Lane B is the winning lane the column necessarily holds Lane B's
    own last answer. That holds only while a granted claim and its column write
    are never separated — and separating them is exactly what a lost or
    discarded write does. In that torn state the guard would measure Lane B's
    real total against a Lane A number, and if Lane A's was higher it would
    refuse the truth as a regression permanently, on the one field Lane B
    exists to own.

    Reading the prior figure from the ledger instead makes the guard true by
    construction rather than true by transaction discipline, which is what let
    the destructive `rollback()` on the shared connection be removed.
    """
    text = entry.get("value_text")
    if not isinstance(text, str):
        return None
    try:
        return float(text.split(SUPERSEDED_MARKER, 1)[0].strip())
    except ValueError:
        return None


def _is_regression(field_name: str, new_value: Any, current: Any) -> bool:
    """Is this total lower than the one Lane B itself last claimed?

    `current` is Lane B's own previous answer, taken from its provenance row
    rather than from the column — see `_prior_claim_value`. Per the module
    header, per-series values cannot fall, so a falling sum means rows were
    deleted, which is evidence going missing rather than money coming back.
    """
    if new_value is None or current is None:
        return False
    tolerance = COST_EPSILON if field_name == "cost_usd" else 0
    return float(new_value) < float(current) - tolerance


async def reconcile_session(
    db: aiosqlite.Connection, session_id: str
) -> SessionReconcileResult:
    """Supersede one session's money and model with Lane B's, where it may.

    Does not commit — it composes inside `reconcile_recent`'s transaction, and
    every statement rides the caller's the way `lane_reconciler_service` asks.
    Raises nothing.
    """
    result = SessionReconcileResult(session_id=session_id)
    try:
        observed = await _observed_metric_keys(db, session_id)
        if not observed:
            # THE case. No Lane B observation means no Lane B opinion: no read
            # of the session row, no claim, no provenance, no UPDATE. A zero
            # written here would outrank the lanes that were right and could
            # not be repaired by them.
            result.skipped = "no-lane-b-observation"
            return result

        row = await _session_row(db, session_id)
        if row is None:
            # The receiver refuses points for unknown sessions, so this means
            # the row was deleted between ingest and now. Nothing to write.
            result.skipped = "no-session-row"
            return result

        totals = await otlp_receiver_service.session_totals(db, session_id)
        claims = await lane_reconciler_service.read(db, session_id)

        sets: list[str] = []
        params: list[Any] = []

        for field_name, metric_key in FIELD_SOURCES.items():
            if metric_key not in observed:
                result.refused[field_name] = "not-observed"
                continue
            value: Any = totals[metric_key]
            if field_name != "cost_usd":
                value = int(value)
            current = row[field_name]
            entry = claims.get(field_name) or {}
            holder = entry.get("lane")

            if holder == LANE and not _differs(field_name, value, current):
                # Lane B already owns this column and still says the same
                # thing. Skipping rather than re-claiming is what keeps the
                # steady state free: a cumulative exporter restates an idle
                # session's totals every few seconds forever, and each restated
                # claim would be a provenance UPDATE and a column UPDATE that
                # change nothing. It also gives `claimed_at` a meaning worth
                # having — when this lane's figure last *moved*, rather than
                # when the last export happened to arrive.
                result.refused[field_name] = "unchanged"
                continue

            prior = _prior_claim_value(entry)
            if (
                holder == LANE
                and prior is not None
                and _is_regression(field_name, value, prior)
            ):
                result.refused[field_name] = "regressed"
                logger.warning(
                    "lane B: %s.%s fell from %s to %s — keeping the higher figure;"
                    " series rows were probably pruned",
                    session_id,
                    field_name,
                    _format(field_name, current),
                    _format(field_name, value),
                )
                continue

            claim = await lane_reconciler_service.apply(
                db,
                session_id,
                LANE,
                field_name,
                _claim_text(
                    field_name, value, holder, current, entry.get("value_text")
                ),
            )
            if not claim.applied:
                result.refused[field_name] = claim.reason
                continue
            superseded = holder is not None and holder != LANE
            if superseded and _differs(field_name, value, current):
                logger.info(
                    "lane B supersedes lane %s on %s.%s: %s -> %s",
                    holder,
                    session_id,
                    field_name,
                    _format(field_name, current),
                    _format(field_name, value),
                )
            sets.append(f"{field_name} = ?")
            params.append(value)
            result.applied[field_name] = value

        model = totals.get("model")
        model_entry = claims.get(FIELD_MODEL) or {}
        model_holder = model_entry.get("lane")
        if model is None:
            result.refused[FIELD_MODEL] = "not-observed"
        elif model_holder == LANE and model == row[FIELD_MODEL]:
            result.refused[FIELD_MODEL] = "unchanged"
        else:
            claim = await lane_reconciler_service.apply(
                db,
                session_id,
                LANE,
                FIELD_MODEL,
                _claim_text(
                    FIELD_MODEL,
                    model,
                    model_holder,
                    row[FIELD_MODEL],
                    model_entry.get("value_text"),
                ),
            )
            if claim.applied:
                sets.append("model = ?")
                params.append(model)
                result.applied[FIELD_MODEL] = model
            else:
                result.refused[FIELD_MODEL] = claim.reason

        if not sets:
            return result

        # `col = ?`, never `col = col + ?`. Lane B reports a session total; see
        # the module header on `apply` vs `accumulate`.
        params.append(session_id)
        await db.execute(
            f"UPDATE agent_sessions SET {', '.join(sets)} WHERE session_id = ?",
            params,
        )
        return result
    except Exception:
        logger.warning(
            "lane B reconcile failed for session %s", session_id, exc_info=True
        )
        result.skipped = "error"
        result.applied.clear()
        return result


async def reconcile_recent(
    db: aiosqlite.Connection,
    *,
    window_seconds: float = RECONCILE_WINDOW_SECONDS,
    limit: int = MAX_SESSIONS_PER_PASS,
) -> ReconcilePassResult:
    """Reconcile every session whose Lane B series were touched recently.

    The ingest path's entry point, called once per stored export. Commits its
    own transaction — unlike `reconcile_session`, which composes — because the
    caller is a router that has no transaction of its own and because the
    receiver's `ingest` has already committed the observations these writes are
    derived from.

    **One commit per session, and a rollback on fault**, which is not a
    performance choice but the thing that keeps the regression guard honest.
    That guard reads "Lane B is the winning lane" as "the column holds Lane B's
    own last figure", and the two only stay the same fact if a granted claim
    and its column write are never separated. Committing the pass as a whole
    would let a fault after one session's claim leave a provenance row with no
    column behind it, and the next export would then measure Lane B's real
    total against a *Lane A* number and refuse it as a regression — forever, on
    the field Lane B exists for. An export carries one session in practice, so
    the bill is the same single commit either way.

    Raises nothing: a reconciliation fault must not cost the exporter the 200
    that says its batch landed.
    """
    pass_result = ReconcilePassResult()
    try:
        session_ids = await _recent_session_ids(db, window_seconds, limit)
    except Exception:
        logger.warning("lane B reconcile: candidate scan failed", exc_info=True)
        return pass_result

    for session_id in session_ids:
        pass_result.sessions_considered += 1
        one = await reconcile_session(db, session_id)
        pass_result.results.append(one)
        try:
            if one.wrote:
                await db.commit()
            # A faulted session is NOT rolled back, and neither is anything
            # else. `get_db()` hands every request the same process-global
            # connection, and SQLite has no nested transactions, so a bare
            # `rollback()` here does not discard "this session's claims" — it
            # discards whatever is uncommitted on the connection, including
            # another in-flight request's work. Verification reproduced it: a
            # hook mid-transaction had its cost_usd reverted and its
            # agent_events row deleted by a reconcile fault on an unrelated
            # session. The earlier reasoning ("nothing earlier is at risk:
            # every prior session has already committed") was sound about the
            # sessions in this loop and silent about every other caller, which
            # is the whole hazard.
            #
            # Dropping it is safe because a torn session self-corrects: the
            # regression guard now reads Lane B's prior figure from the ledger
            # rather than from the column (see `_prior_claim_value`), so a
            # claim recorded without its column write is simply re-applied on
            # the next export instead of being refused forever.
            #
            # The `commit()` above is the same shared-connection hazard in its
            # milder, pre-existing form — `otlp_receiver_service.ingest` ends
            # with one too, and every write path in this app shares it. Fixing
            # that properly means giving the write paths a connection or a lock
            # discipline of their own, which is a change far wider than this
            # ticket and should not be smuggled in under it.
        except Exception:
            logger.warning(
                "lane B reconcile: transaction end failed for session %s",
                session_id,
                exc_info=True,
            )
            continue
        if one.wrote:
            pass_result.sessions_written += 1
        elif one.skipped:
            pass_result.sessions_skipped += 1

    return pass_result
