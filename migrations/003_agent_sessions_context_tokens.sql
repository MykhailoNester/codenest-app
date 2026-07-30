-- Window occupancy at the end of the most recent completed turn, in tokens.
-- Written by agent_service.record_stop from the transcript usage it already
-- reads; the per-turn number is otherwise discarded (tokens_in/tokens_out are
-- cumulative and cannot be used to derive context %).
-- NULL = unknown. There is no backfill: historical sessions genuinely have no
-- per-turn usage recorded anywhere, and inventing one would put a fake number
-- on screen.
ALTER TABLE agent_sessions ADD COLUMN context_tokens INTEGER;
