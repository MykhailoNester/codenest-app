"""Lane B's OTLP/HTTP trace receiver (#178).

Claude Code emits `claude_code.hook`, `claude_code.tool` and eight siblings as
spans under the tracer `com.anthropic.claude_code.tracing`, not as metrics, so
`/v1/metrics` can never see them. This is the receiver that can, and the
aggregate it keeps is the hook-latency figure the epic could not otherwise
produce.

Storage is an aggregate per (session, span name, operation) — never a row per
span. Spans arrive per operation rather than per timer tick, so a row-per-span
table would grow with activity; this one grows with the number of distinct
operations a session touched. Raw request bodies are never stored.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import aiosqlite

from app.services.otlp_receiver_service import (  # noqa: F401  (re-exported bounds)
    MAX_BODY_BYTES,
    SESSION_ID_ATTR,
    OtlpRejected,
    _as_list,
    _attributes,
    _pick,
    decode_body,
)

logger = logging.getLogger(__name__)

TRACER_NAME = "com.anthropic.claude_code.tracing"

SPAN_HOOK = "claude_code.hook"
SPAN_TOOL = "claude_code.tool"
SPAN_TOOL_EXECUTION = "claude_code.tool.execution"
SPAN_TOOL_BLOCKED = "claude_code.tool.blocked_on_user"
SPAN_LLM_REQUEST = "claude_code.llm_request"
SPAN_INTERACTION = "claude_code.interaction"
SPAN_SUBAGENT = "claude_code.subagent.spawn"
SPAN_COMPACTION = "claude_code.compaction"
SPAN_MCP_RPC = "claude_code.mcp.rpc"
SPAN_BASH = "claude_code.bash.subprocess"

# Closed allowlist. An unknown span name is counted and dropped, so the table
# cannot be used as arbitrary key/value storage by whatever can reach loopback.
STORED_SPANS: frozenset[str] = frozenset(
    {
        SPAN_HOOK,
        SPAN_TOOL,
        SPAN_TOOL_EXECUTION,
        SPAN_TOOL_BLOCKED,
        SPAN_LLM_REQUEST,
        SPAN_INTERACTION,
        SPAN_SUBAGENT,
        SPAN_COMPACTION,
        SPAN_MCP_RPC,
        SPAN_BASH,
    }
)

# The category each span belongs to, for the surface's grouping.
SPAN_CATEGORY: dict[str, str] = {
    SPAN_HOOK: "hook",
    SPAN_TOOL: "tool",
    SPAN_TOOL_EXECUTION: "tool",
    SPAN_TOOL_BLOCKED: "tool",
    SPAN_MCP_RPC: "mcp",
    SPAN_BASH: "bash",
    SPAN_LLM_REQUEST: "llm",
    SPAN_SUBAGENT: "subagent",
    SPAN_COMPACTION: "compaction",
    SPAN_INTERACTION: "interaction",
}

# Attribute holding the name of the thing that ran, per span, most specific
# first. Which spelling the CLI uses is version-dependent, so every plausible
# one is tried and the first string wins; a span carrying none aggregates under
# the empty operation.
_OPERATION_ATTRS: dict[str, tuple[str, ...]] = {
    SPAN_HOOK: ("hook.event", "hook_event_name", "hook.event_name", "event.name"),
    SPAN_TOOL: ("tool.name", "tool_name"),
    SPAN_TOOL_EXECUTION: ("tool.name", "tool_name"),
    SPAN_TOOL_BLOCKED: ("tool.name", "tool_name"),
    SPAN_MCP_RPC: ("mcp.tool.name", "mcp_tool.name", "mcp.server.name", "method"),
    SPAN_BASH: ("command.name", "tool.name"),
    SPAN_LLM_REQUEST: ("model", "gen_ai.request.model"),
    SPAN_SUBAGENT: ("subagent.type", "agent.name", "agent.type"),
    SPAN_COMPACTION: ("trigger", "compaction.trigger"),
    SPAN_INTERACTION: ("query_source", "interaction.type"),
}

# Attributes that mean "this operation failed" when truthy/falsey respectively.
_ERROR_ATTRS: tuple[str, ...] = ("error", "error.type", "exception.type")
_SUCCESS_ATTRS: tuple[str, ...] = ("success", "tool.success")

_ERROR_STATUS_CODES: frozenset[Any] = frozenset({2, "2", "STATUS_CODE_ERROR", "ERROR"})


# ─── bounds ──────────────────────────────────────────────────────────────────

MAX_SPANS_PER_REQUEST = 20_000

# Distinct (span name, operation) pairs one session may hold. Tool names and
# hook events are a small closed-ish set in practice; this bounds a caller who
# invents one per request.
MAX_OPERATIONS_PER_SESSION = 512

# A single span longer than this is a clock problem, not an operation.
MAX_DURATION_MS = 24 * 60 * 60 * 1000.0

MAX_OPERATION_LEN = 96

_WARN_COOLDOWN_SECONDS = 300.0
_MAX_TRACKED_UNKNOWN = 50


# ─── rejection reasons ───────────────────────────────────────────────────────

REJECT_NO_SESSION_ID = "no-session-id"
REJECT_MALFORMED_SESSION_ID = "malformed-session-id"
REJECT_UNKNOWN_SESSION = "unknown-session"
REJECT_UNKNOWN_SPAN = "unknown-span"
REJECT_BAD_TIMESTAMP = "bad-timestamp"
REJECT_DURATION_OUT_OF_RANGE = "duration-out-of-range"
REJECT_SPAN_CAP = "span-cap-exceeded"
REJECT_OPERATION_CAP = "operation-cap-exceeded"

REJECT_REASONS: tuple[str, ...] = (
    REJECT_NO_SESSION_ID,
    REJECT_MALFORMED_SESSION_ID,
    REJECT_UNKNOWN_SESSION,
    REJECT_UNKNOWN_SPAN,
    REJECT_BAD_TIMESTAMP,
    REJECT_DURATION_OUT_OF_RANGE,
    REJECT_SPAN_CAP,
    REJECT_OPERATION_CAP,
)


# ─── in-process diagnostics ──────────────────────────────────────────────────

_stats: dict[str, Any] = {
    "requests": 0,
    "spans_seen": 0,
    "spans_stored": 0,
    "spans_rejected": 0,
    "rejections": dict.fromkeys(REJECT_REASONS, 0),
    "unknown_sessions": [],
    "unknown_spans": [],
}

_last_warn_at: dict[str, float] = {}


def receiver_stats() -> dict[str, Any]:
    return {
        "requests": _stats["requests"],
        "spans_seen": _stats["spans_seen"],
        "spans_stored": _stats["spans_stored"],
        "spans_rejected": _stats["spans_rejected"],
        "rejections": dict(_stats["rejections"]),
        "unknown_sessions": list(_stats["unknown_sessions"]),
        "unknown_spans": list(_stats["unknown_spans"]),
    }


def reset_receiver_stats() -> None:
    _stats["requests"] = 0
    _stats["spans_seen"] = 0
    _stats["spans_stored"] = 0
    _stats["spans_rejected"] = 0
    _stats["rejections"] = dict.fromkeys(REJECT_REASONS, 0)
    _stats["unknown_sessions"] = []
    _stats["unknown_spans"] = []
    _last_warn_at.clear()


def _note_seen(bucket: str, value: str) -> None:
    seen: list[str] = _stats[bucket]
    if value in seen or len(seen) >= _MAX_TRACKED_UNKNOWN:
        return
    seen.append(value)


def _warn_throttled(reason: str, message: str, *args: Any) -> None:
    now = time.monotonic()
    last = _last_warn_at.get(reason)
    if last is not None and (now - last) < _WARN_COOLDOWN_SECONDS:
        return
    _last_warn_at[reason] = now
    logger.warning(message, *args)


# ─── parsing ─────────────────────────────────────────────────────────────────


def _unix_nano(raw: Any) -> int | None:
    """A uint64 nanosecond timestamp, which OTLP JSON renders as a string."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        return int(raw)
    if isinstance(raw, str):
        try:
            return int(raw)
        except ValueError:
            return None
    return None


def _resolve_session_id(
    *sources: dict[str, str | int | float | bool],
) -> tuple[str | None, str | None]:
    found: Any = None
    for source in sources:
        if SESSION_ID_ATTR in source:
            found = source[SESSION_ID_ATTR]
            break
    if found is None:
        return None, REJECT_NO_SESSION_ID
    if not isinstance(found, str):
        return None, REJECT_MALFORMED_SESSION_ID
    session_id = found.strip()
    if not session_id or len(session_id) > 128:
        return None, REJECT_MALFORMED_SESSION_ID
    return session_id, None


def _operation(span_name: str, attrs: dict[str, str | int | float | bool]) -> str:
    for key in _OPERATION_ATTRS.get(span_name, ()):
        value = attrs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:MAX_OPERATION_LEN]
    return ""


def _is_error(span: dict[str, Any], attrs: dict[str, str | int | float | bool]) -> bool:
    status = span.get("status")
    if isinstance(status, dict) and status.get("code") in _ERROR_STATUS_CODES:
        return True
    for key in _SUCCESS_ATTRS:
        if attrs.get(key) is False:
            return True
    for key in _ERROR_ATTRS:
        value = attrs.get(key)
        if value is True or (isinstance(value, str) and value.strip()):
            return True
    return False


@dataclass(frozen=True)
class SpanObservation:
    session_id: str
    span_name: str
    operation: str
    duration_ms: float
    is_error: bool


@dataclass
class ParseResult:
    observations: list[SpanObservation] = field(default_factory=list)
    rejected: dict[str, int] = field(default_factory=dict)
    spans_seen: int = 0

    def reject(self, reason: str, count: int = 1) -> None:
        self.rejected[reason] = self.rejected.get(reason, 0) + count

    @property
    def rejected_total(self) -> int:
        return sum(self.rejected.values())


def parse_export(body: dict[str, Any]) -> ParseResult:
    """Walk `resourceSpans → scopeSpans → spans`, skipping anything unreadable."""
    result = ParseResult()

    for resource_spans in _as_list(_pick(body, "resourceSpans", "resource_spans")):
        if not isinstance(resource_spans, dict):
            continue
        resource = resource_spans.get("resource")
        resource_attrs = _attributes(
            resource.get("attributes") if isinstance(resource, dict) else None
        )

        for scope_spans in _as_list(_pick(resource_spans, "scopeSpans", "scope_spans")):
            if not isinstance(scope_spans, dict):
                continue
            scope = scope_spans.get("scope")
            scope_attrs = _attributes(
                scope.get("attributes") if isinstance(scope, dict) else None
            )

            for span in _as_list(scope_spans.get("spans")):
                if not isinstance(span, dict):
                    continue
                result.spans_seen += 1
                if result.spans_seen > MAX_SPANS_PER_REQUEST:
                    result.reject(REJECT_SPAN_CAP)
                    continue

                name = span.get("name")
                if not isinstance(name, str) or not name:
                    result.reject(REJECT_UNKNOWN_SPAN)
                    continue
                if name not in STORED_SPANS:
                    result.reject(REJECT_UNKNOWN_SPAN)
                    _note_seen("unknown_spans", name[:128])
                    continue

                attrs = _attributes(span.get("attributes"))
                session_id, reason = _resolve_session_id(
                    attrs, scope_attrs, resource_attrs
                )
                if session_id is None:
                    result.reject(reason or REJECT_NO_SESSION_ID)
                    continue

                start = _unix_nano(
                    _pick(span, "startTimeUnixNano", "start_time_unix_nano")
                )
                end = _unix_nano(_pick(span, "endTimeUnixNano", "end_time_unix_nano"))
                if start is None or end is None:
                    result.reject(REJECT_BAD_TIMESTAMP)
                    continue
                duration_ms = (end - start) / 1_000_000.0
                if duration_ms < 0 or duration_ms > MAX_DURATION_MS:
                    result.reject(REJECT_DURATION_OUT_OF_RANGE)
                    continue

                result.observations.append(
                    SpanObservation(
                        session_id=session_id,
                        span_name=name,
                        operation=_operation(name, attrs),
                        duration_ms=duration_ms,
                        is_error=_is_error(span, attrs),
                    )
                )

    return result


# ─── storage ─────────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")


_UPSERT_SQL = """
INSERT INTO otlp_span_stats
    (session_id, span_name, operation, count, error_count, total_duration_ms,
     min_duration_ms, max_duration_ms, created_at, last_seen_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id, span_name, operation) DO UPDATE SET
    count = otlp_span_stats.count + excluded.count,
    error_count = otlp_span_stats.error_count + excluded.error_count,
    total_duration_ms = otlp_span_stats.total_duration_ms
                        + excluded.total_duration_ms,
    min_duration_ms = MIN(otlp_span_stats.min_duration_ms,
                          excluded.min_duration_ms),
    max_duration_ms = MAX(otlp_span_stats.max_duration_ms,
                          excluded.max_duration_ms),
    last_seen_at = excluded.last_seen_at
"""


@dataclass
class _Bucket:
    count: int = 0
    error_count: int = 0
    total_ms: float = 0.0
    min_ms: float = 0.0
    max_ms: float = 0.0

    def add(self, duration_ms: float, is_error: bool) -> None:
        self.min_ms = duration_ms if self.count == 0 else min(self.min_ms, duration_ms)
        self.max_ms = duration_ms if self.count == 0 else max(self.max_ms, duration_ms)
        self.count += 1
        self.error_count += 1 if is_error else 0
        self.total_ms += duration_ms


async def _known_sessions(db: aiosqlite.Connection, session_ids: set[str]) -> set[str]:
    if not session_ids:
        return set()
    ids = list(session_ids)
    known: set[str] = set()
    for start in range(0, len(ids), 200):
        chunk = ids[start : start + 200]
        placeholders = ", ".join("?" * len(chunk))
        async with db.execute(
            f"SELECT session_id FROM agent_sessions"
            f" WHERE session_id IN ({placeholders})",
            chunk,
        ) as cur:
            rows = await cur.fetchall()
        known.update(row["session_id"] for row in rows)
    return known


async def _existing_operations(
    db: aiosqlite.Connection, session_id: str
) -> set[tuple[str, str]]:
    async with db.execute(
        "SELECT span_name, operation FROM otlp_span_stats WHERE session_id = ?",
        (session_id,),
    ) as cur:
        return {(row["span_name"], row["operation"]) for row in await cur.fetchall()}


@dataclass
class IngestResult:
    accepted_spans: int
    rejected_spans: int
    rejections: dict[str, int]
    spans_seen: int


async def ingest(
    db: aiosqlite.Connection, raw: bytes, content_encoding: str | None = None
) -> IngestResult:
    """Store one OTLP trace export. Raises `OtlpRejected` for a bad request."""
    body = decode_body(raw, content_encoding)
    parsed = parse_export(body)

    _stats["requests"] += 1
    _stats["spans_seen"] += parsed.spans_seen

    wanted = {obs.session_id for obs in parsed.observations}
    known = await _known_sessions(db, wanted)
    for session_id in wanted - known:
        _note_seen("unknown_sessions", session_id)

    buckets: dict[tuple[str, str, str], _Bucket] = {}
    accepted = 0
    for obs in parsed.observations:
        if obs.session_id not in known:
            parsed.reject(REJECT_UNKNOWN_SESSION)
            continue
        key = (obs.session_id, obs.span_name, obs.operation)
        buckets.setdefault(key, _Bucket()).add(obs.duration_ms, obs.is_error)
        accepted += 1

    now = _now()
    existing_by_session: dict[str, set[tuple[str, str]]] = {}
    for (session_id, span_name, operation), bucket in buckets.items():
        existing = existing_by_session.get(session_id)
        if existing is None:
            existing = await _existing_operations(db, session_id)
            existing_by_session[session_id] = existing

        identity = (span_name, operation)
        if identity not in existing and len(existing) >= MAX_OPERATIONS_PER_SESSION:
            parsed.reject(REJECT_OPERATION_CAP, bucket.count)
            accepted -= bucket.count
            continue

        await db.execute(
            _UPSERT_SQL,
            (
                session_id,
                span_name,
                operation,
                bucket.count,
                bucket.error_count,
                bucket.total_ms,
                bucket.min_ms,
                bucket.max_ms,
                now,
                now,
            ),
        )
        existing.add(identity)

    await db.commit()

    rejected_total = parsed.rejected_total
    _stats["spans_stored"] += accepted
    _stats["spans_rejected"] += rejected_total
    for reason, count in parsed.rejected.items():
        if reason in _stats["rejections"]:
            _stats["rejections"][reason] += count

    for reason, count in sorted(parsed.rejected.items()):
        _warn_throttled(
            reason,
            "otlp trace receiver: rejected %d span(s) — %s"
            " (suppressing repeats of this reason for %ds)",
            count,
            reason,
            int(_WARN_COOLDOWN_SECONDS),
        )

    return IngestResult(
        accepted_spans=accepted,
        rejected_spans=rejected_total,
        rejections=dict(parsed.rejected),
        spans_seen=parsed.spans_seen,
    )


# ─── read — the #178 surface ─────────────────────────────────────────────────


async def operation_stats(db: aiosqlite.Connection, limit: int = 500) -> dict[str, Any]:
    """Every observed operation, rolled up across sessions."""
    async with db.execute(
        "SELECT span_name, operation,"
        "       SUM(count) AS count,"
        "       SUM(error_count) AS error_count,"
        "       SUM(total_duration_ms) AS total_duration_ms,"
        "       MIN(min_duration_ms) AS min_duration_ms,"
        "       MAX(max_duration_ms) AS max_duration_ms,"
        "       COUNT(DISTINCT session_id) AS sessions,"
        "       MAX(last_seen_at) AS last_seen_at"
        "  FROM otlp_span_stats"
        " GROUP BY span_name, operation"
        " ORDER BY SUM(count) DESC"
        " LIMIT ?",
        (limit,),
    ) as cur:
        rows = await cur.fetchall()

    operations = []
    for row in rows:
        count = int(row["count"] or 0)
        total_ms = float(row["total_duration_ms"] or 0.0)
        operations.append(
            {
                "span_name": row["span_name"],
                "category": SPAN_CATEGORY.get(row["span_name"], "other"),
                "operation": row["operation"] or "",
                "count": count,
                "error_count": int(row["error_count"] or 0),
                "total_duration_ms": total_ms,
                "avg_duration_ms": (total_ms / count) if count else 0.0,
                "min_duration_ms": float(row["min_duration_ms"] or 0.0),
                "max_duration_ms": float(row["max_duration_ms"] or 0.0),
                "sessions": int(row["sessions"] or 0),
                "last_seen_at": row["last_seen_at"],
            }
        )

    async with db.execute(
        "SELECT COUNT(DISTINCT session_id) AS sessions, SUM(count) AS spans"
        "  FROM otlp_span_stats"
    ) as cur:
        totals = await cur.fetchone()

    return {
        "operations": operations,
        "session_count": int(totals["sessions"] or 0) if totals else 0,
        "span_count": int(totals["spans"] or 0) if totals else 0,
        "receiver": receiver_stats(),
    }
