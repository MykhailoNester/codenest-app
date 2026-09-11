-- Lane C transcript scan (epic #153 / #163): per-FILE scan progress, the
-- compaction history only the transcripts carry, and three rollups the hook
-- path cannot compute.
--
-- Why a per-FILE table and not a per-session one
-- ----------------------------------------------
-- The obvious shape — one progress row per session — cannot be written on
-- this machine's data. 68 of the 130 recorded `agent_sessions.transcript_path`
-- values no longer exist on disk, and 23 `sessionId`s that *do* exist in the
-- transcripts have no session row at all, so neither side of that join is a
-- complete list of the work. The pass is therefore driven by the files it can
-- actually open, and the unit of progress is the file: `realpath` is the
-- primary key because it is the only identifier a `stat()` and an `open()`
-- agree on, and because two config directories can hold the same session id.
--
-- `dev` + `inode` + `size_bytes` + `mtime_ns` are the resume guard, not
-- decoration. `byte_offset` alone is only meaningful while the bytes before it
-- are the same bytes: a file that was rotated (new inode), truncated (smaller
-- than the recorded size) or rewritten in place is detected by comparing all
-- four and is re-read from zero rather than resumed into the middle of a
-- different conversation. `parser_version` is the fifth member of that guard
-- and covers the case the other four cannot see — the file is unchanged and
-- our *reading* of it changed — so shipping a smarter parser re-reads history
-- instead of leaving it parsed by the old rules forever.
--
-- `session_id` is nullable and carries NO foreign key, for two distinct
-- reasons that both matter. Nullable: a file's session id is only known after
-- its first row is parsed, and `agent-<hex>.jsonl` sidechain files are keyed
-- on the `sessionId` *inside* their rows (their filename is a subagent id that
-- belongs to no session). No FK: 23 on-disk session ids have no
-- `agent_sessions` row, and Lane C deliberately does not mint one (owner
-- decision 3) — an FK would force the scanner to either invent those rows or
-- discard the only record that the transcripts exist. They are recorded here
-- and counted as `sessions_unmatched` instead. This also follows
-- `session_project_costs` and `session_field_provenance`, the other
-- session-keyed side tables, neither of which references `agent_sessions`.
--
-- `file_kind` separates `session` from `sidechain` because the distinction
-- changes arithmetic, not just labelling: 239 of the 335 files under
-- `~/.claude-work` are sidechain files whose rows carry the parent's
-- `sessionId`, and folding their per-turn occupancy into the parent's context
-- peak overstates it by up to 76%.
--
-- `rows_parsed` / `rows_unparsed` / `last_error` are the diagnosis surface. A
-- transcript is appended to while we read it, so a trailing partial line is
-- normal rather than corrupt and is simply left for the next pass; a line that
-- is complete and still will not decode is counted in `rows_unparsed` and the
-- scan continues. `last_error` holds the reason a file was abandoned (an
-- unreadable path, a vanished directory) so a file that stops making progress
-- says why without anyone re-running the pass by hand.
--
-- agent_session_compactions
-- -------------------------
-- Compaction is invisible to every hook: the CLI drops a `compact_boundary`
-- row into the transcript carrying `trigger`, `preTokens`, `postTokens`,
-- `cumulativeDroppedTokens` and `durationMs`, and nothing in a hook payload
-- mentions it. It is also the single largest distortion in the stored numbers
-- — a boundary on this machine dropped 940,368 tokens — so a session's history
-- is not readable without it.
--
-- PK `(session_id, row_uuid)` and not `row_uuid` alone. A resumed session
-- replays its parent's rows verbatim under its own new session id, so one
-- compaction genuinely belongs to two sessions' histories and both rows must
-- survive; keying on `row_uuid` alone would let the resumed session's copy
-- overwrite (or, with a DELETE-then-INSERT writer, destroy) the parent's. The
-- pair also makes a re-scan a no-op: the scanner inserts with
-- `ON CONFLICT DO NOTHING`, so re-reading bytes it has already seen changes
-- nothing rather than duplicating history.
--
-- The three ADD COLUMNs
-- ---------------------
-- These are the only `agent_sessions` columns this epic treats as
-- uncontested — no second lane computes them, so the scanner writes them with
-- a plain UPDATE while every field two lanes can disagree about goes through
-- `lane_reconciler_service.apply` first.
--
--   `context_peak_tokens`   — `context_tokens` is *overwritten* with the last
--                             turn's occupancy on every Stop
--                             (`agent_service.record_stop`), so it reports
--                             wherever a session happened to finish. The
--                             transcript's true peak is higher for 49 of the
--                             62 joinable sessions.
--   `compaction_count`      — how many boundaries the session crossed;
--                             recomputed from `agent_session_compactions`
--                             rather than incremented, so it cannot drift.
--   `transcript_last_row_at`— the timestamp of the last transcript row seen
--                             for the session, which is what makes "the
--                             transcript has moved since we last looked"
--                             answerable without re-reading the file.
--
-- All three are plain `ADD COLUMN`s: nullable TEXT/INTEGER, or a NOT NULL
-- INTEGER with a `0` default, which SQLite adds without a table rebuild. No
-- CHECK constraints, for the reason 009, 010, 011 and 012 all give — SQLite's
-- `ALTER TABLE ADD COLUMN` CHECK support is version-dependent and both
-- vocabularies here still widen. No rows are inserted or updated by this file,
-- so the clean-slate invariant (a freshly migrated database ships empty apart
-- from reference data) holds.

CREATE TABLE IF NOT EXISTS transcript_scan_state (
    realpath        TEXT PRIMARY KEY,
    config_dir      TEXT    NOT NULL,
    session_id      TEXT,
    file_kind       TEXT    NOT NULL DEFAULT 'session',
    dev             INTEGER,
    inode           INTEGER,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    mtime_ns        INTEGER NOT NULL DEFAULT 0,
    byte_offset     INTEGER NOT NULL DEFAULT 0,
    rows_parsed     INTEGER NOT NULL DEFAULT 0,
    rows_unparsed   INTEGER NOT NULL DEFAULT 0,
    parser_version  INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TIMESTAMP,
    last_error      TEXT
);

-- The reverse question the pass asks on every file: "which files belong to
-- this session id" (a session owns one transcript plus every sidechain file
-- its subagents wrote). The PK's own index already covers lookup by realpath.
CREATE INDEX IF NOT EXISTS idx_tss_session
    ON transcript_scan_state(session_id);
-- "Which files came from this config directory", for the per-directory
-- reporting that the >45% / >95% coverage target is stated against.
CREATE INDEX IF NOT EXISTS idx_tss_config_dir
    ON transcript_scan_state(config_dir);

CREATE TABLE IF NOT EXISTS agent_session_compactions (
    session_id                TEXT NOT NULL,
    row_uuid                  TEXT NOT NULL,
    trigger                   TEXT,
    pre_tokens                INTEGER,
    post_tokens               INTEGER,
    cumulative_dropped_tokens INTEGER,
    duration_ms               INTEGER,
    occurred_at               TIMESTAMP,
    recorded_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, row_uuid)
);

-- Chronological read-back for one session — the shape the Session Inspector's
-- context timeline wants. `session_id` alone is the PK's leftmost prefix and
-- needs no index of its own.
CREATE INDEX IF NOT EXISTS idx_asc_session_time
    ON agent_session_compactions(session_id, occurred_at);

ALTER TABLE agent_sessions ADD COLUMN context_peak_tokens    INTEGER;
ALTER TABLE agent_sessions ADD COLUMN compaction_count       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_sessions ADD COLUMN transcript_last_row_at TIMESTAMP;
