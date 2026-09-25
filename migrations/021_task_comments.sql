-- Free-form comments on a task (#28).
--
-- Nothing already in the schema can hold a note: `tasks.description` is the
-- task itself, `activity_log` is a machine-written audit trail that must stay
-- non-hand-editable, and `documents` links files rather than inline text. So:
-- its own table, owned by exactly one task, carrying a body and an author.
--
-- 000_baseline_schema.sql is idempotent (CREATE ... IF NOT EXISTS) and cannot
-- add a table to an existing DB retroactively, so this needs its own stem.
-- Stems are append-only, applied in filename order and never re-read once
-- recorded; 020_task_subtasks.sql is the previous one.
--
-- ON DELETE CASCADE on task_id mirrors task_subtasks (020), task_blockers and
-- task_label_assignments (004): `delete_task` leans on the FK instead of
-- deleting children by hand, which also covers the raw `DELETE FROM tasks`
-- paths (the factory reset) that never call it.
--
-- AUTHORSHIP — the decision the ticket asked to settle in planning.
-- Agents MAY post here: the composer placeholder promises "for yourself or an
-- agent" and this app exists to supervise agents, so silently refusing agent
-- writes would be the wrong call. But accepting them unattributed is worse
-- than refusing them, so every row carries an identity and the UI always shows
-- it. `author_kind` is that identity, and it is stored rather than derived:
--   'operator' — author_id IS NULL, the person driving this install. Renders
--                as the operator, never as a fabricated member name.
--   'human'    — a members row with type='human'.
--   'agent'    — a members row with type='agent'; the UI marks it visibly.
-- It is pinned at write time from members.type so attribution survives the
-- member row being edited or removed. author_id is ON DELETE SET NULL for the
-- same reason: removing a member must not take their comments with them, and
-- the kind still says what wrote the row even once the name is gone.
--
-- `updated_at` is written by the edit path, not by a trigger — the read path
-- compares it with created_at to show an "edited" marker, and a trigger firing
-- on every UPDATE would make that marker meaningless.
--
-- Seeds nothing. A freshly migrated DB ships empty apart from functional
-- reference data, and a sample comment is not reference data.

CREATE TABLE IF NOT EXISTS task_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
    author_kind TEXT NOT NULL DEFAULT 'operator'
                CHECK (author_kind IN ('operator', 'human', 'agent')),
    body        TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task
    ON task_comments(task_id, created_at, id);
