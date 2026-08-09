-- Multi-value task labels.
--
-- `taxonomies` already governs single-value vocabularies (task_status,
-- task_priority, workflow_status): stable slug, editable display_name, colour,
-- sort_order, is_active. Labels reuse that shape under a new `task_label` kind
-- so Settings -> Workflow Labels manages them with machinery that already
-- exists. A task carries MANY labels, so the link needs its own table rather
-- than a column on `tasks` -- this is the first multi-value kind.
--
-- 000_baseline_schema.sql is idempotent (CREATE ... IF NOT EXISTS) and cannot
-- add anything to a table that already exists, so this needs its own migration.
--
-- No explicit ids in the seed INSERT: taxonomies.id is AUTOINCREMENT and an
-- existing install may already have user-created rows at 14+ (the baseline seed
-- occupies 1..13). Explicit ids would collide.
--
-- ON DELETE CASCADE on task_id mirrors task_blockers: delete_task relies on the
-- FK rather than deleting children by hand. The cascade on label_id only ever
-- fires for a hard DELETE FROM taxonomies (the factory reset) -- through the API
-- taxonomy_service.delete only flips is_active, so assignments survive a label
-- being hidden and reappear on Restore.
--
-- Seeded with is_default = 0: is_default = 1 rows cannot be deleted at all, and
-- a starter label set the user cannot remove would be wrong.

CREATE TABLE IF NOT EXISTS task_label_assignments (
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    label_id   INTEGER NOT NULL REFERENCES taxonomies(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (task_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_task_label_assignments_label
    ON task_label_assignments(label_id);

INSERT OR IGNORE INTO taxonomies
    (kind, slug, display_name, sort_order, color, is_default)
VALUES
    ('task_label', 'bug',      'Bug',      10, '#ef4444', 0),
    ('task_label', 'feature',  'Feature',  20, '#3b82f6', 0),
    ('task_label', 'chore',    'Chore',    30, '#6b7280', 0),
    ('task_label', 'research', 'Research', 40, '#a855f7', 0),
    ('task_label', 'docs',     'Docs',     50, '#38bdf8', 0);
