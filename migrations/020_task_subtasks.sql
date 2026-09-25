-- Subtask checklist rows (#27).
--
-- A subtask is a checklist LINE, not a task. `task_blockers` already models
-- the other relationship — a dependency between two whole `tasks` rows — and
-- conflating the two would give every checkbox a status, a priority, an
-- assignee and a place on the Work Board, none of which a checklist line
-- wants. So: its own table, owned by exactly one task, with nothing but a
-- title and a done flag.
--
-- 000_baseline_schema.sql is idempotent (CREATE ... IF NOT EXISTS) and cannot
-- add anything to a table that already exists, so this needs its own migration.
--
-- ON DELETE CASCADE on task_id mirrors task_label_assignments (004) and
-- task_blockers: `delete_task` relies on the FK rather than deleting children
-- by hand, which also covers the raw `DELETE FROM tasks` paths (the factory
-- reset) that never call it.
--
-- `done` carries CHECK (done IN (0, 1)) because SQLite would otherwise store
-- any integer in it, and the progress bar divides by the row count — a stray
-- 2 would render a bar past 100%.
--
-- `sort_order` is NOT NULL DEFAULT 0 rather than nullable: the read path
-- orders by it and NULLs would sort together ahead of everything, making the
-- list order depend on insertion history. Nothing writes it but the insert
-- (max + 1) today; reorder is a follow-up and needs no further schema.
--
-- Seeds nothing. A freshly migrated DB ships empty apart from functional
-- reference data, and a starter checklist is not reference data.

CREATE TABLE IF NOT EXISTS task_subtasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_subtasks_task
    ON task_subtasks(task_id, sort_order, id);
