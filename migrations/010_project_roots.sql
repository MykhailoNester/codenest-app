-- project_roots (epic #153 / #155): a first-class notion of a *root* — a
-- directory under which each git repo is its own project. A root is
-- user-owned state, not a derived view: it carries an `enabled` flag (and
-- in a later change a `label`), it can hold a `manual` root for a directory
-- with no imported project yet, and it must not silently change meaning as
-- projects are imported or removed.
--
-- No CHECK constraint on `source`: as with 009_agent_sessions_provenance,
-- the vocabulary belongs to the writer (`app/services/project_roots_service.py`
-- validates it against `_VALID_SOURCES`), and a CHECK would need a table
-- rebuild to widen later.
--
-- The seed below is `INSERT OR IGNORE`, so it is safe to re-run this file's
-- raw SQL directly (it is not, in production — `init_db` skips an applied
-- migration by stem — but the test harness re-executes migration files
-- directly against pre-migration fixtures). It records one `source='seeded'`
-- row for every directory that is already the parent of two or more
-- non-workspace `projects` rows, because a lone project under a directory
-- does not make that directory a "root" in the sense this table models.
-- On a freshly migrated database the only `projects` row is the
-- `Unassigned` sentinel, whose `path` and `root_path` are both NULL, so the
-- seed's `WHERE ... np IS NOT NULL` clause matches nothing and this file
-- inserts zero rows there — the clean-slate invariant holds.
CREATE TABLE IF NOT EXISTS project_roots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT    NOT NULL UNIQUE,
    label      TEXT,
    source     TEXT    NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO project_roots (path, label, source, enabled)
SELECT parent, NULL, 'seeded', 1
  FROM (
      SELECT np,
             rtrim(rtrim(np, replace(np, '/', '')), '/') AS parent
        FROM (
            SELECT rtrim(COALESCE(NULLIF(root_path, ''), NULLIF(path, '')), '/') AS np
              FROM projects
             WHERE is_workspace = 0
        )
       WHERE np IS NOT NULL AND np <> '' AND np <> '/'
  )
 WHERE parent <> '' AND parent <> '/' AND substr(parent, 1, 1) = '/'
 GROUP BY parent
HAVING COUNT(DISTINCT np) >= 2;
