-- otlp_metric_series.query_source (#177): the dimension that says what asked
-- for a turn, denormalised out of `series_key` for the same reason `model`
-- already is — the digest is one-way, so the value cannot be read back out of
-- a stored row, and a split by query source has to read it back.
--
-- Deliberately no CHECK and no vocabulary anywhere in this file. The set of
-- values the CLI emits is not known here and is not stable; the surface
-- discovers it by reading DISTINCT query_source off this column. NULL is a
-- real answer (a point that carried no such attribute, or a row written before
-- this migration) and gets its own bucket rather than a guess.

ALTER TABLE otlp_metric_series ADD COLUMN query_source TEXT;
