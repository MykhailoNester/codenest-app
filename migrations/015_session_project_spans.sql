-- session_project_spans (epic #153 / #173): the per-repo stretches of one
-- session, so a root session that touches five repos is five attributed
-- spans instead of one guess.
--
-- Why the session row is not enough
-- --------------------------------
-- `agent_sessions.project_id` is decided once, from the cwd the session
-- happened to start in (`agent_service._upsert_session_start`, whose clause is
-- `project_id=COALESCE(project_id, ?)` — a row that already has an answer is
-- never revisited). For a session opened at a directory that parents many
-- repos that answer is correct for the first minute and wrong for the rest:
-- every later repo's work is filed under whichever repo the session opened in.
-- On this machine 42 unattributed sessions have a cwd that exists but sits
-- under no enabled `project_roots` row, and the root-folder case is the one
-- that opened the epic.
--
-- These rows are strictly *additive*. `agent_sessions.project_id` stays the
-- session's primary attribution and nothing that reads it changes meaning
-- because this table exists; a consumer that wants the split opts into it.
--
-- `(session_id, seq)` as the primary key
-- -------------------------------------
-- Not `(session_id, started_at)`, and not a surrogate id. `started_at` is
-- second-granularity (`agent_service._now` truncates to seconds), so two cwd
-- changes inside one second would collide on a key built from it — and cwd
-- changes arrive in bursts, because entering a repo and adding a directory
-- are two hooks about one movement. `seq` is the span's ordinal within its
-- session, counted from 0, which makes the whole table a deterministic
-- function of an ordered observation list: replaying the same events produces
-- the same rows at the same keys, which is what lets a backfill over the
-- `CwdChanged` / `DirectoryAdded` history already in `agent_events` be run
-- more than once without duplicating anything. The pair also gives the read
-- the app actually performs — "this session's spans, in order" — its index for
-- free.
--
-- Three timestamps, because they answer three different questions
-- --------------------------------------------------------------
--   `started_at`   — when the session entered this repo. Always known: it is
--                    the timestamp of the observation that opened the span.
--   `ended_at`     — when the session *left*, and NULL while it has not. This
--                    is a boundary, not an estimate: it is only ever written
--                    as the `started_at` of the span that displaced this one,
--                    so consecutive spans chain exactly and no stretch of a
--                    session is counted twice.
--   `last_seen_at` — the last observation that fell *inside* this span. The
--                    final span of a session normally has no `ended_at` at all
--                    (sessions end where they were working), so without this
--                    column the most recent repo of every session would
--                    measure zero and the table would be useless for the
--                    arithmetic it was added for. It is evidence rather than a
--                    boundary: it advances only when a cwd event proves the
--                    session was still there, which is a floor on the span's
--                    real extent, never a claim about its end.
--
-- `project_id` is nullable and a span may carry NULL
-- -------------------------------------------------
-- A session that steps into a temp directory, an unimported repo, or a
-- directory under no enabled root resolves to no project, and that stretch is
-- recorded as an unattributed span rather than dropped. Dropping it would
-- silently extend the *previous* span across time the session demonstrably
-- spent elsewhere — attributing work to a repo it had already left, which is
-- the precise failure this table exists to end.
--
-- No foreign keys, on either `session_id` or `project_id`, following
-- `session_project_costs` and `session_field_provenance` — the other
-- session-keyed side tables. These rows are written from the hook ingest path,
-- and a hook must never be blocked by an FK check; the wipe path
-- (`app/routers/command_center.py:factory_reset`) names this table explicitly
-- rather than relying on a cascade that cannot reach it. It also means spans
-- outlive `agent_events`: `event_retention_service` prunes the events a span
-- was derived from long before the span stops being interesting, and
-- `source_event_id` is therefore a diagnostic pointer, not a dependency.
--
-- No CHECK constraints, for the reason 009, 010, 011, 012 and 014 all give:
-- SQLite's `ALTER TABLE ADD COLUMN` CHECK support is version-dependent and
-- widening one later needs a table rebuild. Enforcement lives in
-- `app/services/session_project_spans_service.py`, the only writer.
--
-- No rows are inserted by this file — spans exist only for sessions that
-- actually moved — so a freshly migrated database ships this table empty and
-- the clean-slate invariant holds.

CREATE TABLE IF NOT EXISTS session_project_spans (
    session_id      TEXT    NOT NULL,
    seq             INTEGER NOT NULL,
    project_id      INTEGER,
    repo_path       TEXT,
    cwd             TEXT    NOT NULL,
    started_at      TIMESTAMP NOT NULL,
    ended_at        TIMESTAMP,
    last_seen_at    TIMESTAMP NOT NULL,
    source_event_id INTEGER,
    recorded_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, seq)
);

-- The reverse question: "which sessions touched this project, and when" — the
-- per-project rollup that the split is for. `session_id` alone is the primary
-- key's leftmost prefix and needs no index of its own.
CREATE INDEX IF NOT EXISTS idx_sps_project
    ON session_project_spans(project_id, started_at);
