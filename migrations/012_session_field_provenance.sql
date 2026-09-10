-- session_field_provenance (epic #153 / #161): which lane last wrote which
-- `agent_sessions` field, so precedence is a decision rather than an accident
-- of hook ordering.
--
-- Three lanes write the same session row. Lane A is the hook path
-- (`app/services/agent_service.py`), which sees every SessionStart /
-- UserPromptSubmit / PreToolUse / PostToolUse / Stop payload and is the only
-- writer today. Lane C is this epic's transcript scan, which reads a session's
-- JSONL and can prove things no hook payload carries — `source_app`, `title`,
-- the branch a run actually started on. Lane B is the live-switch path (P3),
-- which reads a running session's own accounting and is therefore the last
-- word on money.
--
-- Without a record of who wrote what, "who wins" can only be expressed as a
-- `CASE WHEN` in whichever statement happens to run, and the answer changes
-- with hook ordering: a Stop hook that estimates cost at flat Sonnet rates
-- would overwrite Lane B's real figure purely because Stop fires later. This
-- table is the memory that makes the question answerable —
-- `app/services/lane_reconciler_service.py` records a claim row on every
-- write and consults the existing rows before the next one.
--
-- PK `(session_id, field, lane)`: one row per lane per field, not one row per
-- field. Only *effective* writes are recorded — a lane that was outranked
-- changed no column, so recording it would let the provenance read name a lane
-- that never wrote the value on display. Two rows for one field therefore mean
-- exactly one thing: a weaker lane wrote it first and a stronger lane later
-- took over, which is the history the Session Inspector needs and the reason
-- Lane B arriving late (P3) must not erase the evidence that Lane A had been
-- maintaining the column until then. Re-writes by the same lane upsert that
-- one row, which is what keeps the table bounded: at most 3 lanes x 20
-- registered fields per session, never one row per hook.
--
-- `value_text` stores the claimed value stringified, for diagnosis only. The
-- authoritative value always lives in the `agent_sessions` column; nothing
-- reads a session's state back out of here, and a mismatch (a hand-edited
-- column, a pre-012 write) is expected rather than a corruption. It is TEXT
-- for every field regardless of the column's own type because the point is a
-- human-readable audit line, not a typed shadow copy.
--
-- No CHECK constraint on `lane` or `field`, for the reason
-- 009_agent_sessions_provenance, 010_project_roots and 011_agent_sessions_kind
-- all give: SQLite's `ALTER TABLE ADD COLUMN` CHECK support is
-- version-dependent, and both vocabularies still widen — Lane B is not built
-- yet and `FIELD_LANES` grows as later phases register fields. Enforcement is
-- in the service layer, where `lane_reconciler_service.FIELD_LANES` and
-- `LANES` gate every write and an unregistered field is refused before it
-- reaches SQLite.
--
-- No foreign key to `agent_sessions`, following `session_project_costs` — the
-- other session-keyed side table in the baseline schema. A hook must never be
-- blocked by an FK check, and the wipe path
-- (`app/routers/command_center.py:factory_reset`) clears this table
-- explicitly rather than relying on a cascade.
--
-- The index is on `(field, lane)` and not on `session_id`, which the primary
-- key's own implicit index already covers as a leftmost prefix. It exists for
-- the reverse question — "which sessions has Lane C claimed a title on" — that
-- the P1 backfill reporting asks.
--
-- No rows are inserted by this file: provenance is written only by a lane that
-- actually wrote a column, so a freshly migrated database ships this table
-- empty and the clean-slate invariant holds.

CREATE TABLE IF NOT EXISTS session_field_provenance (
    session_id TEXT NOT NULL,
    field      TEXT NOT NULL,
    lane       TEXT NOT NULL,
    value_text TEXT,
    claimed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, field, lane)
);
CREATE INDEX IF NOT EXISTS idx_sfp_field_lane
    ON session_field_provenance(field, lane);
