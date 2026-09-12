"""Lane B — the OTLP/HTTP metrics receiver (epic #153 / #175).

Lane B has been declared since P1 and has never had a writer. `FIELD_LANES` in
`lane_reconciler_service` already ranks it *first* for `cost_usd`, `tokens_in`,
`tokens_out`, `context_tokens` and `model`, on the strength of one fact: Lane A
prices every model at flat Sonnet rates in `agent_service.record_stop`, and
Lane C reads a transcript whose `usage` object has no cost field at all. Only
the CLI itself knows what a turn cost. This module is how that number finally
arrives; it does **not** reconcile anything — `apply`/`accumulate` are not
called from here and no `agent_sessions` column is written. Lane B's
observations land in `otlp_metric_series` and stay there until #176 chooses to
supersede with them.

Zero new dependencies, and why that is possible
===============================================
`OTEL_EXPORTER_OTLP_PROTOCOL` accepts `http/json` alongside `http/protobuf` and
`grpc`, and the CLI's exporter honours it. `requirements.txt` carries neither
`protobuf` nor any `opentelemetry` package, and this module adds neither: OTLP
JSON is ordinary JSON with a documented nesting, and `json` + `gzip` +
`hashlib` from the stdlib parse it completely. The cost of that choice is that
a user who leaves the protocol on its `http/protobuf` default gets a 415 from
`POST /v1/metrics` with the one-line fix in the body, rather than silent
acceptance of bytes we cannot read.

Which instruments are stored, and which are dropped
===================================================
Eighteen instrument names ship in the 2.1.251 binary, but they are **not
eighteen metrics**. Exactly eight are counters created by the meter's
`installMeter`; the other ten are span names on the *tracing* signal, started
through `trace.getTracer("com.anthropic.claude_code.tracing")` — and in this
build most of them sit behind an enhanced-telemetry gate that returns `false`.
A metrics endpoint cannot receive a span. The split is therefore load-bearing
and not a matter of taste:

  Metrics (counters) — can arrive here
    claude_code.cost.usage             STORED as `cost_usd`
    claude_code.token.usage            STORED as `tokens_input` / `tokens_output`
                                       / `tokens_cache_read` / `tokens_cache_creation`,
                                       split on the point's `type` attribute
    claude_code.session.count          dropped
    claude_code.lines_of_code.count    dropped
    claude_code.pull_request.count     dropped
    claude_code.commit.count           dropped
    claude_code.code_edit_tool.decision  dropped
    claude_code.active_time.total      dropped

  Traces (spans) — cannot arrive here at all
    claude_code.interaction, claude_code.llm_request, claude_code.tool,
    claude_code.tool.execution, claude_code.tool.blocked_on_user,
    claude_code.hook, claude_code.subagent.spawn, claude_code.compaction,
    claude_code.mcp.rpc, claude_code.bash.subprocess

The two stored instruments are exactly the ones Lane B is ranked first for.
The six dropped counters are dropped on a rule, not on an omission: each one
either restates something a lane already inside this app observes directly, or
answers a question no surface asks. `session.count` and `active_time.total`
are liveness, which is Lane A's by precedence and which Lane A sees as it
happens rather than on a 60-second timer. `lines_of_code.count`,
`pull_request.count` and `commit.count` describe the repository, which the app
reads from git. `code_edit_tool.decision` restates the permission decisions
already in `agent_events`. Storing them "because the bytes are already here"
would put six more series per session under a retention policy for no reader,
which is the growth this receiver was written to avoid.

`claude_code.hook` deserves its own sentence, because the ticket asked for it
by name: it is the instrument that would finally make hook latency answerable,
and it is a **span**, not a counter. It arrives on `POST /v1/traces` or not at
all, so no metrics receiver can store it and this one does not pretend to.
That is a fact about the signal, not a scoping decision — see the report for
#178, which owns the latency surface and now owns the question of whether a
trace receiver is worth building for it.

Logs are refused, deliberately
==============================
`POST /v1/logs` is mounted and answers 501 rather than 404, so a user who
points `OTEL_LOGS_EXPORTER=otlp` at this sidecar reads why instead of guessing
at a missing route, and so their exporter treats the batch as permanently
rejected and stops retrying. Three reasons to refuse, in order of weight:

1. Claude Code's log signal is the one that carries prompt and response text.
   `OTEL_LOG_USER_PROMPTS` redacts it by default, but the point is that the
   body is the place where user content lives at all, and this app's storage
   for it would be a durable local file the user did not ask for.
2. Logs are one record per event with no aggregation — precisely the
   unbounded per-arrival row shape that `otlp_metric_series` exists to avoid.
3. Nothing downstream reads them. Lane B's job in `FIELD_LANES` is money and
   tokens, and those arrive on the metrics signal.

The body of a refused logs export is never read, so no prompt text is
materialised even transiently.

What this endpoint trusts, and what it does not
===============================================
The sidecar binds `127.0.0.1` and is unauthenticated by design; AGENTS.md
forbids widening the bind or the CORS allowlist, and the MCP manager's trust
model depends on that binding. Every other endpoint under that model *reads*.
This one accepts **pushed** data that Lane B's precedence will then make
authoritative about money, so the trust question has to be answered explicitly
rather than inherited.

  TRUSTED: that a POST to `/v1/metrics` originates from a process running as
  this user on this machine. Loopback gives us that and nothing more. It does
  not identify *which* process, and any program the user can run can post.

  NOT TRUSTED — and bounded accordingly:

  * **That the export belongs to a real session.** A point whose `session.id`
    does not already name a row in `agent_sessions` is refused. The receiver
    never creates a session, so an export cannot conjure a subject to attach
    money to; it can only speak about sessions the hook lane already recorded.
    This is a speed bump rather than a wall — session ids are readable from
    `~/.claude/projects` by anything that can post here — and it is stated as
    such rather than sold as a defence.
  * **That the instrument is one of ours.** A closed allowlist, and a closed
    vocabulary for the `type` attribute. An unknown name is counted and
    dropped, never stored, so the table cannot be used as arbitrary key/value
    storage by a caller that invents instrument names.
  * **That the numbers are sane.** Per-point caps (`MAX_COST_USD_PER_POINT`,
    `MAX_TOKENS_PER_POINT`), NaN/Inf refusal, and a refusal of negative values
    on monotonic counters. Read that bound precisely: it is per *point*, not
    per export and not per caller. A delta series accumulates, so one request
    may legitimately carry `MAX_POINTS_PER_REQUEST` points and move a total by
    their sum — on the order of 1e8 USD — and nothing bounds the total across
    successive requests at all. The per-point cap stops a single absurd number,
    not a determined caller.
  * **That the export is small.** A byte cap before parsing, a decompressed
    cap for gzip, and `MAX_POINTS_PER_REQUEST` after it. Excess is rejected
    with a count, not absorbed.
  * **That the caller will not exhaust storage.** `MAX_SERIES_PER_SESSION`
    caps distinct rows per session, so a caller varying an attribute per
    request cannot turn a bounded table into an unbounded one.

  **The exposure that remains, stated plainly.** Within those bounds a local
  process can still ratchet a real session's recorded cost upward — cumulative
  series take `MAX(stored, arrived)`, so a fabricated large value sticks and
  cannot later be lowered by a truthful smaller one. Nothing in this ticket
  closes that, and nothing could without either authentication (forbidden) or
  a trust decision this layer has no basis to make. Two things contain it
  today: #175 writes only to `otlp_metric_series`, so no displayed number, no
  budget hard-stop and no cost-threshold notification moves until #176 wires
  reconciliation; and Lane B's own precedence is per field, so a poisoned cost
  cannot reach anything outside the five money-and-token fields. #176 is the
  ticket that re-opens this by choosing to supersede, and it should decide
  there — with the numbers in hand — whether Lane B outranking Lane A on
  `cost_usd` is still the right default when the writer is an unauthenticated
  local push. That is a decision about precedence, not about this receiver.

Never 500
=========
This is the only route in the app whose body is written by something outside
it. Malformed JSON, a truncated gzip stream, a missing `resourceMetrics`, an
attribute typed as an array where a string was expected, a data point shape
from a future OTLP version — each is a counted rejection and a 200 with an
OTLP `partialSuccess`, or a 4xx, never an exception escaping into the app's
generic 500 handler. The parser reads only the fields it recognises and
ignores every other key, which is what makes an unknown OTLP version a no-op
rather than a failure.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import math
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import aiosqlite

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

LANE = "B"  # matches lane_reconciler_service.LANE_OTLP; #176 does the writing.

# The attribute that ties an export to a session row.
#
# It is a **data point** attribute, not a resource attribute. The CLI builds
# one common attribute map per process and spreads it into every counter's
# `add()` call (`{...commonAttributes(), ...callSiteAttrs}`); the OTLP Resource
# carries only `service.name` (`claude-code`), `service.version`, `os.type`,
# `os.version` and `host.arch`. Reading it off the resource block alone would
# find nothing on a real export and join nothing, while looking perfectly
# reasonable in a hand-written fixture — which is why `_resolve_session_id`
# checks the data point first and why the wire-shaped fixture in
# `tests/sidecar/test_otlp_receiver.py` puts it where the CLI puts it.
#
# Scope and resource are still consulted as fallbacks: `OTEL_RESOURCE_ATTRIBUTES`
# entries are folded into the same common map, so a user who pins the session
# id there costs us one dict lookup to honour.
SESSION_ID_ATTR = "session.id"

# Instrument -> how to derive a `metric_key`. Anything absent is dropped.
INSTRUMENT_COST = "claude_code.cost.usage"
INSTRUMENT_TOKENS = "claude_code.token.usage"
STORED_INSTRUMENTS: frozenset[str] = frozenset({INSTRUMENT_COST, INSTRUMENT_TOKENS})

# Counters the CLI emits that this receiver deliberately does not store. Listed
# as data so the module docstring's claim is checkable by a test rather than
# only by reading prose, and so a name added to the CLI later shows up as
# "unknown instrument" instead of being quietly assumed to be one of these.
DROPPED_INSTRUMENTS: frozenset[str] = frozenset(
    {
        "claude_code.session.count",
        "claude_code.lines_of_code.count",
        "claude_code.pull_request.count",
        "claude_code.commit.count",
        "claude_code.code_edit_tool.decision",
        "claude_code.active_time.total",
    }
)

# `claude_code.token.usage`'s `type` attribute, verbatim from the CLI's four
# `add()` call sites. A closed map, so an unrecognised value is a counted
# rejection rather than a new `metric_key` invented by the caller.
TOKEN_TYPE_TO_METRIC_KEY: dict[str, str] = {
    "input": "tokens_input",
    "output": "tokens_output",
    "cacheRead": "tokens_cache_read",
    "cacheCreation": "tokens_cache_creation",
}

METRIC_KEY_COST = "cost_usd"
METRIC_KEYS: frozenset[str] = frozenset(
    {METRIC_KEY_COST, *TOKEN_TYPE_TO_METRIC_KEY.values()}
)

TEMPORALITY_DELTA = "delta"
TEMPORALITY_CUMULATIVE = "cumulative"

# OTLP JSON renders the enum either as its integer or as its full name,
# depending on the serializer. Both spellings, plus the absent case.
#
# The absent case resolves to CUMULATIVE, not DELTA, and the asymmetry is
# deliberate: treating an unlabelled series as delta would make the receiver
# *sum* restatements of a running total, multiplying a session's cost by its
# export count. Treating it as cumulative at worst under-reports a genuinely
# delta series to its largest single increment. Between a silent multiplication
# and a visible under-count, the under-count is the one a human notices.
_TEMPORALITY_BY_WIRE: dict[Any, str] = {
    1: TEMPORALITY_DELTA,
    "1": TEMPORALITY_DELTA,
    "AGGREGATION_TEMPORALITY_DELTA": TEMPORALITY_DELTA,
    2: TEMPORALITY_CUMULATIVE,
    "2": TEMPORALITY_CUMULATIVE,
    "AGGREGATION_TEMPORALITY_CUMULATIVE": TEMPORALITY_CUMULATIVE,
}

# Attributes that are constant for the lifetime of a session and therefore
# carry no series identity. Stripped before the digest so `series_key` stays a
# function of the counter's real dimensions — and so a CLI that starts adding
# another per-process attribute does not silently re-key every existing series
# and double-count a live session's cost.
_IDENTITY_ATTRS: frozenset[str] = frozenset(
    {
        SESSION_ID_ATTR,
        "ccr.session.id",
        "user.id",
        # Set from the gateway OIDC claims. Constant per session like the rest
        # of this set, so they never split a series — but they do reach the
        # digest, and the stated rationale for stripping is that every
        # per-process constant is stripped. Leaving them out made that claim
        # untrue rather than merely incomplete.
        "identity.source",
        "user.groups",
        "user.email",
        "user.account_uuid",
        "user.account_id",
        "organization.id",
        "app.version",
        "app.entrypoint",
        "terminal.type",
        "service.name",
        "service.version",
        "os.type",
        "os.version",
        "host.arch",
    }
)


# ---------------------------------------------------------------------------
# Bounds
# ---------------------------------------------------------------------------

# Compressed (or raw) request body. A real export from one CLI is single-digit
# kilobytes; a megabyte is four orders of magnitude of headroom and still small
# enough that rejecting it costs nothing.
MAX_BODY_BYTES = 1_048_576

# Decompressed ceiling for a gzip body, checked while inflating rather than
# after. Without it, `MAX_BODY_BYTES` bounds only what arrives on the wire and
# a 1 MB compressed bomb could expand to gigabytes inside the sidecar.
MAX_DECOMPRESSED_BYTES = 8 * 1_048_576

# Data points considered per request. Everything past this is rejected and
# counted; the response says how many, so a legitimately large export is
# visible rather than silently truncated.
MAX_POINTS_PER_REQUEST = 10_000

# Distinct series rows one session may hold.
#
# An earlier version of this comment said a real session runs 5–20, counting
# only `model` against `speed` / `query_source` / `effort`. That was wrong, and
# wrong in the direction that costs money. The CLI's cost/token `.add()` site
# spreads a per-call-site map into every point — `agent.name`, `skill.name`,
# `plugin.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name` — none
# of which is constant for a session. Real cardinality is five metric keys
# times the distinct combinations of all ten dimensions, so a long session
# touching a dozen skills and several subagent types plausibly reaches the low
# hundreds of series without anyone doing anything unusual.
#
# That matters because hitting this cap does not merely truncate a report: it
# drops genuine cost points, and Lane B outranks every other lane on money, so
# the app would under-report real spend. The rejection is counted and returned
# in `partialSuccess`, so it is traceable rather than silent — but traceable
# under-reporting is still under-reporting.
#
# Hence 2048 rather than 512: roughly an order of magnitude above the worst
# honest session measured so far, while still bounding the caller who varies an
# attribute on purpose. The right number wants real data, which #176 is the
# first ticket to have; revisit it there rather than guessing again here.
MAX_SERIES_PER_SESSION = 2048

# Per-point sanity ceilings. Not a fraud test — a caller can still send
# `MAX_COST_USD_PER_POINT` — but a bound on what a single point may assert, so
# no one arrival can move a total by an arbitrary amount.
MAX_COST_USD_PER_POINT = 10_000.0
MAX_TOKENS_PER_POINT = 1e12

# Stored `model` string. Long enough for every real model id with room to
# spare, short enough that the column cannot become a payload smuggled past
# the "no blobs" rule.
MAX_MODEL_LEN = 128

# Seconds between repeats of the same rejection-reason warning. A misconfigured
# exporter pushes every 5–60 s forever; without a cooldown one broken setup
# fills the log with the same line. The counters in `receiver_stats()` keep the
# exact tally regardless of what the log prints.
_WARN_COOLDOWN_SECONDS = 300.0

# Distinct unjoinable session ids remembered for diagnosis. Bounded because the
# ids come from outside.
_MAX_TRACKED_UNKNOWN_SESSIONS = 50


# ---------------------------------------------------------------------------
# Rejection reasons — a closed vocabulary
# ---------------------------------------------------------------------------
#
# Every point this receiver refuses is refused for exactly one of these, and
# the reason is what both the log line and `receiver_stats()` count. Closed so
# that "why is nothing joining?" has an enumerable answer rather than a free
# text search.

REJECT_NO_SESSION_ID = "no-session-id"
REJECT_MALFORMED_SESSION_ID = "malformed-session-id"
REJECT_UNKNOWN_SESSION = "unknown-session"
REJECT_UNKNOWN_INSTRUMENT = "unknown-instrument"
REJECT_DROPPED_INSTRUMENT = "dropped-instrument"
REJECT_UNSUPPORTED_SHAPE = "unsupported-data-shape"
REJECT_UNKNOWN_TOKEN_TYPE = "unknown-token-type"
REJECT_BAD_VALUE = "bad-value"
REJECT_VALUE_OUT_OF_RANGE = "value-out-of-range"
REJECT_POINT_CAP = "point-cap-exceeded"
REJECT_SERIES_CAP = "series-cap-exceeded"

REJECT_REASONS: tuple[str, ...] = (
    REJECT_NO_SESSION_ID,
    REJECT_MALFORMED_SESSION_ID,
    REJECT_UNKNOWN_SESSION,
    REJECT_UNKNOWN_INSTRUMENT,
    REJECT_DROPPED_INSTRUMENT,
    REJECT_UNSUPPORTED_SHAPE,
    REJECT_UNKNOWN_TOKEN_TYPE,
    REJECT_BAD_VALUE,
    REJECT_VALUE_OUT_OF_RANGE,
    REJECT_POINT_CAP,
    REJECT_SERIES_CAP,
)


class OtlpRejected(Exception):
    """A whole export could not be read. Carries the HTTP status to answer with.

    Raised only for request-level failures — unreadable gzip, unparseable JSON,
    a body that is not a JSON object, the wrong protocol. A *point*-level
    problem is never an exception: it is a counted rejection inside an
    otherwise successful 200, because an export of 40 points with one bad
    attribute should store the other 39.
    """

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


# ---------------------------------------------------------------------------
# In-process diagnostics
# ---------------------------------------------------------------------------
#
# Counters, not rows. "An export that cannot be joined must not be silently
# dropped without trace" is answered in three places, none of which grows the
# database: the OTLP `partialSuccess` block in the response (which is the
# protocol's own channel and lands in the exporter's diagnostics), a
# rate-limited log line, and these counters. The tradeoff is that they are
# in-process and reset when the sidecar restarts — a durable rejection ledger
# would be a table that grows on exactly the misconfiguration that produces the
# most traffic, which is the thing this module refuses to build. The log line
# is the durable half.

_stats: dict[str, Any] = {
    "requests": 0,
    "points_seen": 0,
    "points_stored": 0,
    "points_rejected": 0,
    "rejections": dict.fromkeys(REJECT_REASONS, 0),
    "unknown_sessions": [],
    "unknown_instruments": [],
}

_last_warn_at: dict[str, float] = {}


def receiver_stats() -> dict[str, Any]:
    """Snapshot of what this process has ingested and refused since start."""
    return {
        "requests": _stats["requests"],
        "points_seen": _stats["points_seen"],
        "points_stored": _stats["points_stored"],
        "points_rejected": _stats["points_rejected"],
        "rejections": dict(_stats["rejections"]),
        "unknown_sessions": list(_stats["unknown_sessions"]),
        "unknown_instruments": list(_stats["unknown_instruments"]),
    }


def reset_receiver_stats() -> None:
    """Zero the counters. For tests; nothing in the app calls it."""
    _stats["requests"] = 0
    _stats["points_seen"] = 0
    _stats["points_stored"] = 0
    _stats["points_rejected"] = 0
    _stats["rejections"] = dict.fromkeys(REJECT_REASONS, 0)
    _stats["unknown_sessions"] = []
    _stats["unknown_instruments"] = []
    _last_warn_at.clear()


def _note_seen(bucket: str, value: str) -> None:
    seen: list[str] = _stats[bucket]
    if value in seen:
        return
    if len(seen) >= _MAX_TRACKED_UNKNOWN_SESSIONS:
        return
    seen.append(value)


def _warn_throttled(reason: str, message: str, *args: Any) -> None:
    now = time.monotonic()
    last = _last_warn_at.get(reason)
    if last is not None and (now - last) < _WARN_COOLDOWN_SECONDS:
        return
    _last_warn_at[reason] = now
    logger.warning(message, *args)


# ---------------------------------------------------------------------------
# OTLP JSON reading
# ---------------------------------------------------------------------------
#
# Proto3's JSON mapping allows either the camelCase or the original snake_case
# spelling of every field, and 64-bit integers are rendered as *strings*. The
# CLI's serializer emits camelCase, so that is what the fixtures use — but
# accepting both costs one tuple lookup and removes a whole class of "works
# against my fixture, fails against the wire" bug.


def _pick(obj: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in obj:
            return obj[name]
    return None


def _as_list(value: Any) -> list[Any]:
    """A repeated field, or an empty list for anything that is not one.

    Repeated OTLP fields are omitted entirely when empty, and a caller is free
    to send `null` or a scalar where a list belongs. Normalising here is what
    lets every loop below iterate without a type check of its own.
    """
    return value if isinstance(value, list) else []


def _attr_value(raw: Any) -> str | int | float | bool | None:
    """One OTLP `AnyValue` as a Python scalar, or None if it is not a scalar.

    `arrayValue` and `kvlistValue` return None on purpose. They are legal OTLP
    and a legal attribute value, but nothing this receiver reads is ever
    legitimately a list or a map, and flattening one into the series digest
    would let a caller vary the digest without varying any dimension we
    understand. `bytesValue` is refused for the same reason.
    """
    if not isinstance(raw, dict):
        return None
    if "stringValue" in raw or "string_value" in raw:
        value = _pick(raw, "stringValue", "string_value")
        return value if isinstance(value, str) else None
    if "boolValue" in raw or "bool_value" in raw:
        value = _pick(raw, "boolValue", "bool_value")
        return value if isinstance(value, bool) else None
    if "intValue" in raw or "int_value" in raw:
        value = _pick(raw, "intValue", "int_value")
        # int64 arrives as a string under the proto3 JSON mapping.
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                return None
        return None
    if "doubleValue" in raw or "double_value" in raw:
        value = _pick(raw, "doubleValue", "double_value")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return float(value)
    return None


def _attributes(raw: Any) -> dict[str, str | int | float | bool]:
    """An OTLP `KeyValue` list as a flat dict, skipping anything unreadable.

    A malformed entry is skipped rather than failing the point: an exporter
    that adds one attribute shape we do not model must not cost us a session's
    cost figure.
    """
    out: dict[str, str | int | float | bool] = {}
    for entry in _as_list(raw):
        if not isinstance(entry, dict):
            continue
        key = entry.get("key")
        if not isinstance(key, str) or not key:
            continue
        value = _attr_value(entry.get("value"))
        if value is None:
            continue
        out[key] = value
    return out


def _point_number(point: dict[str, Any]) -> float | None:
    """A `NumberDataPoint`'s value, from whichever of the two fields carries it.

    `asInt` is a string in OTLP JSON; `asDouble` is a JSON number. Returns None
    for a point carrying neither, for a non-finite double (NaN and ±Inf are
    valid JSON5 but not valid money), and for a value the JSON parser produced
    as a bool.
    """
    if "asDouble" in point or "as_double" in point:
        raw = _pick(point, "asDouble", "as_double")
        if isinstance(raw, bool):
            return None
        if isinstance(raw, (int, float)):
            value = float(raw)
            return value if math.isfinite(value) else None
        if isinstance(raw, str):
            # Permitted by proto3 JSON for the special values, and some
            # serializers stringify doubles wholesale.
            try:
                value = float(raw)
            except ValueError:
                return None
            return value if math.isfinite(value) else None
        return None
    if "asInt" in point or "as_int" in point:
        raw = _pick(point, "asInt", "as_int")
        if isinstance(raw, bool):
            return None
        if isinstance(raw, int):
            return float(raw)
        if isinstance(raw, str):
            try:
                return float(int(raw))
            except ValueError:
                return None
        return None
    return None


def _temporality(sum_block: dict[str, Any]) -> str:
    raw = _pick(sum_block, "aggregationTemporality", "aggregation_temporality")
    return _TEMPORALITY_BY_WIRE.get(raw, TEMPORALITY_CUMULATIVE)


def _series_key(instrument: str, attrs: dict[str, str | int | float | bool]) -> str:
    """Stable digest of a counter's dimension attributes.

    Sorted so key order on the wire cannot split one series into two, and
    typed (`s:` / `i:` / `f:` / `b:`) so `"1"` and `1` are not the same
    dimension. Truncated to 32 hex characters: collision risk at the scale of a
    few hundred series per session is nil, and a full digest is 64 bytes of
    index per row for nothing.
    """
    parts = [instrument]
    for key in sorted(attrs):
        value = attrs[key]
        if isinstance(value, bool):
            tag = f"b:{value}"
        elif isinstance(value, int):
            tag = f"i:{value}"
        elif isinstance(value, float):
            tag = f"f:{value!r}"
        else:
            tag = f"s:{value}"
        parts.append(f"{key}={tag}")
    digest = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()
    return digest[:32]


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Observation:
    """One accepted data point, already reduced to what gets stored."""

    session_id: str
    metric_key: str
    series_key: str
    model: str | None
    temporality: str
    value: float


@dataclass
class ParseResult:
    observations: list[Observation] = field(default_factory=list)
    rejected: dict[str, int] = field(default_factory=dict)
    points_seen: int = 0

    def reject(self, reason: str, count: int = 1) -> None:
        self.rejected[reason] = self.rejected.get(reason, 0) + count

    @property
    def rejected_total(self) -> int:
        return sum(self.rejected.values())


def decode_body(raw: bytes, content_encoding: str | None) -> dict[str, Any]:
    """Bytes on the wire to a JSON object, or `OtlpRejected`.

    Handles the `gzip` content encoding the OTLP HTTP exporters can be
    configured to use, with a decompressed ceiling so the body cap means
    something. Anything other than gzip or identity is refused rather than
    guessed at.
    """
    if len(raw) > MAX_BODY_BYTES:
        raise OtlpRejected(413, f"body too large ({len(raw)} bytes)")

    encoding = (content_encoding or "").strip().lower()
    if encoding in {"", "identity"}:
        payload = raw
    elif encoding == "gzip":
        try:
            payload = gzip.decompress(raw)
        except Exception as exc:  # noqa: BLE001 — zlib raises several types
            raise OtlpRejected(400, f"gzip body could not be decompressed: {exc}")
        if len(payload) > MAX_DECOMPRESSED_BYTES:
            raise OtlpRejected(
                413, f"decompressed body too large ({len(payload)} bytes)"
            )
    else:
        raise OtlpRejected(415, f"unsupported Content-Encoding {encoding!r}")

    try:
        body = json.loads(payload or b"{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise OtlpRejected(400, f"invalid OTLP JSON: {exc}")
    if not isinstance(body, dict):
        raise OtlpRejected(400, "OTLP body must be a JSON object")
    return body


def _resolve_session_id(
    point_attrs: dict[str, str | int | float | bool],
    scope_attrs: dict[str, str | int | float | bool],
    resource_attrs: dict[str, str | int | float | bool],
) -> tuple[str | None, str | None]:
    """`(session_id, rejection reason)` — exactly one of the two is None.

    Data point first: that is where the CLI puts it. Scope and resource are
    consulted after, for the user who pins it through
    `OTEL_RESOURCE_ATTRIBUTES`.

    A present-but-wrong-typed value (an int, a bool, an array, an empty string)
    is `malformed-session-id` and NOT `no-session-id`. The distinction is the
    whole point of returning a reason: "the attribute never arrived" is a
    configuration problem (`OTEL_METRICS_INCLUDE_SESSION_ID=false`), and "it
    arrived as the wrong thing" is a sender problem. Collapsing them would make
    the counter unable to tell a user which of the two they have.
    """
    found: Any = None
    for source in (point_attrs, scope_attrs, resource_attrs):
        if SESSION_ID_ATTR in source:
            found = source[SESSION_ID_ATTR]
            break
    if found is None:
        return None, REJECT_NO_SESSION_ID
    if not isinstance(found, str):
        return None, REJECT_MALFORMED_SESSION_ID
    session_id = found.strip()
    # Session ids are UUIDs; the length ceiling is only here so a rejected
    # value cannot be a large string we then carry into a log line.
    if not session_id or len(session_id) > 128:
        return None, REJECT_MALFORMED_SESSION_ID
    return session_id, None


def _metric_key(
    instrument: str, attrs: dict[str, str | int | float | bool]
) -> tuple[str | None, str | None]:
    """`(metric_key, rejection reason)` for one instrument + attribute set."""
    if instrument == INSTRUMENT_COST:
        return METRIC_KEY_COST, None
    if instrument == INSTRUMENT_TOKENS:
        token_type = attrs.get("type")
        if not isinstance(token_type, str):
            return None, REJECT_UNKNOWN_TOKEN_TYPE
        key = TOKEN_TYPE_TO_METRIC_KEY.get(token_type)
        if key is None:
            return None, REJECT_UNKNOWN_TOKEN_TYPE
        return key, None
    if instrument in DROPPED_INSTRUMENTS:
        return None, REJECT_DROPPED_INSTRUMENT
    return None, REJECT_UNKNOWN_INSTRUMENT


def _value_in_range(metric_key: str, value: float) -> bool:
    if value < 0:
        # Both stored instruments are monotonic counters. A negative arrival is
        # either a sender error or an attempt to walk a total back down.
        return False
    ceiling = (
        MAX_COST_USD_PER_POINT
        if metric_key == METRIC_KEY_COST
        else MAX_TOKENS_PER_POINT
    )
    return value <= ceiling


def parse_export(body: dict[str, Any]) -> ParseResult:
    """Walk `resourceMetrics → scopeMetrics → metrics → sum.dataPoints`.

    Every level tolerates absence and wrong types by skipping, because every
    level is attacker- (or future-version-) controlled. An export whose
    top-level key is not `resourceMetrics` at all — a different OTLP version, a
    logs body posted to the metrics route, an empty object — yields zero
    observations and zero rejections, which the caller reports as an accepted
    export that stored nothing rather than as an error.
    """
    result = ParseResult()

    for resource_metrics in _as_list(
        _pick(body, "resourceMetrics", "resource_metrics")
    ):
        if not isinstance(resource_metrics, dict):
            continue
        resource = resource_metrics.get("resource")
        resource_attrs = _attributes(
            resource.get("attributes") if isinstance(resource, dict) else None
        )

        for scope_metrics in _as_list(
            _pick(resource_metrics, "scopeMetrics", "scope_metrics")
        ):
            if not isinstance(scope_metrics, dict):
                continue
            scope = scope_metrics.get("scope")
            scope_attrs = _attributes(
                scope.get("attributes") if isinstance(scope, dict) else None
            )

            for metric in _as_list(scope_metrics.get("metrics")):
                if not isinstance(metric, dict):
                    continue
                instrument = metric.get("name")
                if not isinstance(instrument, str) or not instrument:
                    continue

                sum_block = metric.get("sum")
                if not isinstance(sum_block, dict):
                    # A gauge or histogram carrying one of our instrument
                    # names. Counted rather than ignored: it means the CLI
                    # changed an instrument's kind, which is exactly the
                    # silent-drift case worth a log line.
                    if instrument in STORED_INSTRUMENTS:
                        result.reject(REJECT_UNSUPPORTED_SHAPE)
                    continue

                temporality = _temporality(sum_block)

                for point in _as_list(_pick(sum_block, "dataPoints", "data_points")):
                    if not isinstance(point, dict):
                        continue
                    result.points_seen += 1
                    if result.points_seen > MAX_POINTS_PER_REQUEST:
                        result.reject(REJECT_POINT_CAP)
                        continue

                    point_attrs = _attributes(point.get("attributes"))

                    metric_key, reason = _metric_key(instrument, point_attrs)
                    if metric_key is None:
                        result.reject(reason or REJECT_UNKNOWN_INSTRUMENT)
                        if reason == REJECT_UNKNOWN_INSTRUMENT:
                            _note_seen("unknown_instruments", instrument[:128])
                        continue

                    session_id, reason = _resolve_session_id(
                        point_attrs, scope_attrs, resource_attrs
                    )
                    if session_id is None:
                        result.reject(reason or REJECT_NO_SESSION_ID)
                        continue

                    value = _point_number(point)
                    if value is None:
                        result.reject(REJECT_BAD_VALUE)
                        continue
                    if not _value_in_range(metric_key, value):
                        result.reject(REJECT_VALUE_OUT_OF_RANGE)
                        continue

                    dimensions = {
                        k: v for k, v in point_attrs.items() if k not in _IDENTITY_ATTRS
                    }
                    model = dimensions.get("model")
                    result.observations.append(
                        Observation(
                            session_id=session_id,
                            metric_key=metric_key,
                            series_key=_series_key(instrument, dimensions),
                            model=(
                                model[:MAX_MODEL_LEN]
                                if isinstance(model, str) and model
                                else None
                            ),
                            temporality=temporality,
                            value=value,
                        )
                    )

    return result


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _now() -> str:
    """`agent_service._now()`'s spelling, so both writers agree.

    `event_retention_service._prune_class` normalises `'T'` to `' '` before
    comparing precisely because the table has historically held both; matching
    the hook path keeps this table on one of them.
    """
    return datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")


_UPSERT_SQL = """
INSERT INTO otlp_metric_series
    (session_id, metric_key, series_key, model, temporality, value, points,
     created_at, last_seen_at)
VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
ON CONFLICT(session_id, metric_key, series_key) DO UPDATE SET
    -- Cumulative series restate a running total, so the arrival replaces
    -- rather than adds; MAX rather than a plain assignment because a
    -- monotonic counter can only go up and exports can arrive out of order
    -- after a retry, and a late older restatement must not walk the total
    -- back down. Delta series carry an increment, so they accumulate.
    value = CASE
        WHEN excluded.temporality = 'cumulative'
            THEN MAX(otlp_metric_series.value, excluded.value)
        ELSE otlp_metric_series.value + excluded.value
    END,
    points = otlp_metric_series.points + 1,
    -- COALESCE, so a point that arrives without a `model` attribute cannot
    -- blank a model this series already told us.
    model = COALESCE(excluded.model, otlp_metric_series.model),
    temporality = excluded.temporality,
    last_seen_at = excluded.last_seen_at
"""


async def _known_sessions(db: aiosqlite.Connection, session_ids: set[str]) -> set[str]:
    """Which of these ids actually name an `agent_sessions` row.

    One statement per export rather than one per point: an export carries a
    single session's points in practice, and the set is what bounds the query.
    """
    if not session_ids:
        return set()
    ids = list(session_ids)
    known: set[str] = set()
    # Chunked so a pathological export cannot build a statement with thousands
    # of bind parameters and trip SQLITE_MAX_VARIABLE_NUMBER.
    for start in range(0, len(ids), 200):
        chunk = ids[start : start + 200]
        placeholders = ", ".join("?" * len(chunk))
        async with db.execute(
            f"SELECT session_id FROM agent_sessions WHERE session_id IN ({placeholders})",
            chunk,
        ) as cur:
            rows = await cur.fetchall()
        known.update(row["session_id"] for row in rows)
    return known


async def _existing_series(
    db: aiosqlite.Connection, session_id: str
) -> set[tuple[str, str]]:
    """Every `(metric_key, series_key)` this session already has a row for.

    The set, not a count, because the cap has to distinguish "a new series,
    which costs a row" from "an arrival on a series we already store, which
    costs nothing and must never be refused" — a session that tripped the cap
    and then stopped recording the models it was already using would lose real
    money to a defence against a hypothetical one.

    Read once per session per export and then held for the rest of it. One
    indexed read of at most `MAX_SERIES_PER_SESSION` rows (tens to low
    hundreds in practice — see the constant for why it is not single digits),
    against an export that is about to issue that many writes anyway. The
    alternative — counting rows and inferring novelty — was wrong in exactly
    the way `test_series_cap_does_not_block_updates_to_existing_rows` pins.
    """
    async with db.execute(
        "SELECT metric_key, series_key FROM otlp_metric_series WHERE session_id = ?",
        (session_id,),
    ) as cur:
        return {(row["metric_key"], row["series_key"]) for row in await cur.fetchall()}


@dataclass
class IngestResult:
    """What one export did. `rejected_points` is what the 200 reports back."""

    accepted_points: int
    rejected_points: int
    rejections: dict[str, int]
    points_seen: int


async def ingest(
    db: aiosqlite.Connection, raw: bytes, content_encoding: str | None = None
) -> IngestResult:
    """Store one OTLP metrics export. Raises `OtlpRejected` for a bad request.

    Point-level problems never raise — they come back in `rejections` and
    become the response's `partialSuccess`. The whole write runs in one
    transaction and commits once, so a failure part-way through stores nothing
    rather than half an export.
    """
    body = decode_body(raw, content_encoding)
    parsed = parse_export(body)

    _stats["requests"] += 1
    _stats["points_seen"] += parsed.points_seen

    wanted = {obs.session_id for obs in parsed.observations}
    known = await _known_sessions(db, wanted)

    unknown = wanted - known
    for session_id in unknown:
        _note_seen("unknown_sessions", session_id)

    # Which series each session already stores, read lazily on first use and
    # then kept current as this export adds rows — so the cap holds within one
    # export as well as across them.
    known_series: dict[str, set[tuple[str, str]]] = {}

    now = _now()
    accepted = 0
    for obs in parsed.observations:
        if obs.session_id not in known:
            parsed.reject(REJECT_UNKNOWN_SESSION)
            continue

        existing = known_series.get(obs.session_id)
        if existing is None:
            existing = await _existing_series(db, obs.session_id)
            known_series[obs.session_id] = existing

        identity = (obs.metric_key, obs.series_key)
        is_new = identity not in existing
        if is_new and len(existing) >= MAX_SERIES_PER_SESSION:
            parsed.reject(REJECT_SERIES_CAP)
            continue

        await db.execute(
            _UPSERT_SQL,
            (
                obs.session_id,
                obs.metric_key,
                obs.series_key,
                obs.model,
                obs.temporality,
                obs.value,
                now,
                now,
            ),
        )
        if is_new:
            existing.add(identity)
        accepted += 1

    await db.commit()

    rejected_total = parsed.rejected_total
    _stats["points_stored"] += accepted
    _stats["points_rejected"] += rejected_total
    for reason, count in parsed.rejected.items():
        if reason in _stats["rejections"]:
            _stats["rejections"][reason] += count

    if rejected_total:
        # One line naming the reasons, throttled per reason so a permanently
        # misconfigured exporter does not fill the log. The exact tally is
        # always available from `receiver_stats()`.
        for reason, count in sorted(parsed.rejected.items()):
            _warn_throttled(
                reason,
                "otlp receiver: rejected %d data point(s) — %s"
                " (suppressing repeats of this reason for %ds)",
                count,
                reason,
                int(_WARN_COOLDOWN_SECONDS),
            )

    return IngestResult(
        accepted_points=accepted,
        rejected_points=rejected_total,
        rejections=dict(parsed.rejected),
        points_seen=parsed.points_seen,
    )


# ---------------------------------------------------------------------------
# Read — for #176, and for tests
# ---------------------------------------------------------------------------


async def session_totals(db: aiosqlite.Connection, session_id: str) -> dict[str, Any]:
    """Lane B's view of one session: `{metric_key: total}` plus a model.

    `SUM(value)` across the session's series is the correct total under either
    temporality, because each row already holds its own series' total (see the
    migration's header). Read-only and reconciles nothing — #176 decides what
    to do with these numbers; this function exists so that decision does not
    have to re-derive the arithmetic.

    `model` is the model of the highest-cost series, which is the one a session
    with a main model and an occasional Haiku sub-agent should be labelled
    with. None when no series carried a model attribute.
    """
    totals: dict[str, float] = dict.fromkeys(sorted(METRIC_KEYS), 0.0)
    async with db.execute(
        "SELECT metric_key, SUM(value) AS total FROM otlp_metric_series"
        " WHERE session_id = ? GROUP BY metric_key",
        (session_id,),
    ) as cur:
        for row in await cur.fetchall():
            if row["metric_key"] in totals:
                totals[row["metric_key"]] = float(row["total"] or 0.0)

    async with db.execute(
        "SELECT model FROM otlp_metric_series"
        " WHERE session_id = ? AND model IS NOT NULL AND metric_key = ?"
        " ORDER BY value DESC LIMIT 1",
        (session_id, METRIC_KEY_COST),
    ) as cur:
        top = await cur.fetchone()
    model = top["model"] if top else None

    return {
        "session_id": session_id,
        "lane": LANE,
        "model": model,
        **totals,
    }
