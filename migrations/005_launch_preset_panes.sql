-- Launch presets as an ordered typed pane list, not just a rows x cols grid.
--
-- Both columns are nullable and carry no DEFAULT: `panes_json IS NULL` is
-- the marker that a row is grid-shaped and must be read through the
-- compatibility path (app/services/launch_preset_service.py derives its
-- pane list from rows/cols/cells_json at read time). Backfilling either
-- column would erase that distinction and make every pre-existing preset
-- indistinguishable from a freshly saved one.
--
-- The clean-slate invariant is untouched: no INSERT in this file, and
-- ALTER TABLE ... ADD COLUMN does not re-validate existing rows against
-- the CHECK, so every row already in an install gets NULL in both columns
-- (verified against the venv's SQLite 3.45.3).
--
-- Not folded into 000_baseline_schema.sql: that file is applied, as-is,
-- in every existing install, and 001/002 already prove new columns land
-- in their own append-only migration rather than by editing it.
ALTER TABLE launch_presets ADD COLUMN panes_json TEXT;
ALTER TABLE launch_presets ADD COLUMN split TEXT
    CHECK (split IS NULL OR split IN ('cols', 'rows', 'grid'));
