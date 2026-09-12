-- otlp_metric_series (epic #153 / #175): Lane B's storage — one row per
-- *metric series*, never one row per exported data point.
--
-- Why a series table and not a point table
-- ----------------------------------------
-- An OTLP exporter is a timer, not an event source. Claude Code's metric
-- reader pushes on `OTEL_METRIC_EXPORT_INTERVAL` (60 s by default, and people
-- turn it down to 5 s while they are watching) for as long as the process
-- lives, whether or not anything happened in between. A receiver that
-- appended a row per data point per export would add roughly
-- `interval⁻¹ × series` rows per second per live session, forever, with no
-- relationship to how much work was actually done — the same failure #159 had
-- to repair when 186 MB of a 232 MB database turned out to be tool payload
-- bodies, except arriving on a clock instead of on activity. Raw export
-- bodies are not stored at all, for the same reason and because they carry
-- `user.email` and `organization.id` that this app has no business retaining.
--
-- So the unit of storage is the series: one row per
-- `(session, metric_key, series_key)`. A session exporting every 5 seconds for
-- eight hours writes its handful of rows in the first minute and then only
-- ever UPDATEs them. Table growth is bounded by *distinct series*, which is
-- bounded per session by `otlp_receiver_service.MAX_SERIES_PER_SESSION`, and
-- the whole table is bounded again by the `otlp` retention class in
-- `event_retention_service`.
--
-- What a series is, and why `series_key` is a digest
-- --------------------------------------------------
-- OTLP identity for a counter is (instrument, full attribute set). Claude
-- Code's cost and token counters carry `model`, and also `type`, `speed`,
-- `query_source` and `effort` — every distinct combination is its own
-- independent counter with its own independent running total.
--
-- That matters because of temporality. The CLI's exporter defaults to
-- CUMULATIVE (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`, default
-- `cumulative`), so each export restates the running total for every series
-- since process start. Summing those arrivals would multiply a session's cost
-- by the number of exports; collapsing two distinct series into one row and
-- keeping the larger would silently discard the other one's money. Neither
-- error looks like an error — the number stays plausible and is wrong — and
-- Lane B outranks Lanes A and C on `cost_usd`, so the wrong number would be
-- the one on display.
--
-- `series_key` is therefore a digest of the point's *dimension* attributes,
-- with the per-session constants (`session.id`, `user.id`, `user.email`,
-- `organization.id`, `app.version`, `terminal.type`, …) stripped — they are
-- identical on every point of a session and would only pad the digest. Two
-- points land on the same row when and only when they belong to the same
-- counter. `value` then means "this series' running total" for a cumulative
-- series and "the sum of this series' increments" for a delta one, so a
-- session's true total is `SUM(value)` over its rows under either temporality,
-- and a mix of the two across series is still correct.
--
-- `temporality` is stored per row rather than per export because the exporter
-- is allowed to choose it per instrument (the `lowmemory` preference does
-- exactly that: delta for counters, cumulative for up-down counters), and
-- because a row whose arithmetic is `max()` and a row whose arithmetic is `+=`
-- must not be confusable after the fact.
--
-- `model` is denormalised out of the digest deliberately
-- -----------------------------------------------------
-- It is already inside `series_key`; the column is a readable copy, capped in
-- length by the service, so `#176`'s reconciliation can pick a session's model
-- without reversing a hash and so a human debugging a wrong cost figure can
-- see which model's series it came from. Nothing joins on it.
--
-- No foreign key to `agent_sessions`, and no `ON DELETE CASCADE`
-- -------------------------------------------------------------
-- Following `session_field_provenance` (012) and `session_project_spans`
-- (015). The receiver already refuses any point whose `session.id` does not
-- match an existing `agent_sessions` row — it will not invent a session — so
-- the FK would buy no integrity that the service does not already enforce,
-- while costing a constraint check on a path that accepts pushed input from
-- outside the app. The wipe path (`app/routers/command_center.py:factory_reset`)
-- names this table explicitly, as it does for the other three.
--
-- `id` exists only so `event_retention_service._prune_class` can keep its
-- `DELETE … WHERE id IN (SELECT id … LIMIT n)` batching shape against this
-- table without a second code path. The real identity is the UNIQUE triple.
--
-- No index on `last_seen_at`: the prune compares
-- `replace(last_seen_at, 'T', ' ')`, an expression SQLite cannot answer from a
-- plain index, and this table is small enough by construction that a scan is
-- the cheaper thing to pay for once a day. The UNIQUE constraint's implicit
-- index already serves the only hot read — "every series on this session" —
-- as its leftmost prefix.
--
-- No CHECK on `metric_key` or `temporality`, for the reason 009/010/011/012
-- all give: SQLite's ALTER TABLE CHECK support is version-dependent and both
-- vocabularies still widen. Enforcement lives in
-- `otlp_receiver_service`, where an unknown instrument is refused before it
-- reaches SQLite.
--
-- No rows are inserted by this file: a freshly migrated database ships this
-- table empty, so the clean-slate invariant holds.

CREATE TABLE IF NOT EXISTS otlp_metric_series (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    metric_key   TEXT NOT NULL,
    series_key   TEXT NOT NULL,
    model        TEXT,
    temporality  TEXT NOT NULL,
    value        REAL NOT NULL DEFAULT 0,
    points       INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, metric_key, series_key)
);
