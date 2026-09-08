-- Session provenance columns (epic #153): where a session came from, and
-- what its last-known permission mode / effort level were.
--
-- P0 (this migration + this change) writes only `permission_mode` and
-- `effort`, from the UserPromptSubmit, PreToolUse and Stop hooks — the three
-- payload shapes the live-DB sample actually carries either field on. Both
-- are stored verbatim, last-known-wins, with COALESCE no-clobber semantics
-- so a later hook that omits the field cannot erase what an earlier one set.
--
-- `git_branch` is filled by #156 (a resolver, not a hook payload — hook
-- payloads carry no branch, and the sidecar must not shell out to `git`;
-- process spawning lives in the Rust shell only). `source_app`,
-- `source_detail`, `cli_version`, `title` and `title_source` are Lane C /
-- P1: inferred from transcripts and client state that this change does not
-- read. All six stay NULL until then.
--
-- No CHECK constraint on `source_app` (or any other column): SQLite's
-- `ALTER TABLE ADD COLUMN` CHECK support is version-dependent, and the
-- vocabulary is unvalidated until Lane C sees real `entrypoint` values —
-- whoever writes the column in P1 owns validating it, in the service layer,
-- not here.
--
-- All eight columns are nullable TEXT with no DEFAULT, so this is a plain
-- `ADD COLUMN` on every one: no table rebuild, no data motion, every
-- existing row keeps its current values with NULL in the eight new slots.
-- No rows are inserted or updated by this file — the clean-slate invariant
-- (a freshly migrated DB ships empty apart from reference data) holds.

ALTER TABLE agent_sessions ADD COLUMN source_app      TEXT;
ALTER TABLE agent_sessions ADD COLUMN source_detail   TEXT;
ALTER TABLE agent_sessions ADD COLUMN git_branch      TEXT;
ALTER TABLE agent_sessions ADD COLUMN cli_version     TEXT;
ALTER TABLE agent_sessions ADD COLUMN permission_mode TEXT;
ALTER TABLE agent_sessions ADD COLUMN effort          TEXT;
ALTER TABLE agent_sessions ADD COLUMN title           TEXT;
ALTER TABLE agent_sessions ADD COLUMN title_source    TEXT;
