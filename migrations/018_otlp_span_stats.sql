-- otlp_span_stats (#178): Lane B's trace storage — one row per
-- (session, span name, operation), never one row per span.
--
-- Spans arrive per operation, not per timer tick, so a row-per-span table
-- would grow with activity: a busy session emits a span for every tool call,
-- every hook, every LLM request. The unit of storage is therefore the
-- aggregate — count, error count, total/min/max duration — and the table grows
-- with the number of distinct operations a session touched.
--
-- `operation` is the discriminator the surface needs: the tool name on
-- `claude_code.tool`, the event name on `claude_code.hook`, the server or tool
-- name on `claude_code.mcp.rpc`. Empty string, never NULL, so the UNIQUE
-- constraint keeps working (NULLs are distinct in SQLite).
--
-- `id` exists so `event_retention_service._prune_class` can batch its DELETE
-- against this table with no second code path, exactly as in 017.

CREATE TABLE IF NOT EXISTS otlp_span_stats (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL,
    span_name         TEXT NOT NULL,
    operation         TEXT NOT NULL DEFAULT '',
    count             INTEGER NOT NULL DEFAULT 0,
    error_count       INTEGER NOT NULL DEFAULT 0,
    total_duration_ms REAL NOT NULL DEFAULT 0,
    min_duration_ms   REAL NOT NULL DEFAULT 0,
    max_duration_ms   REAL NOT NULL DEFAULT 0,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, span_name, operation)
);
