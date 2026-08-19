-- Drop the legacy rows x cols x provider_id grid header from launch_presets.
--
-- 005 added `panes_json`/`split` alongside the original grid columns and left
-- `rows`, `cols` and `provider_id` NOT NULL, so every write still had to derive
-- values for them from the pane list — and `provider_id` is only derivable when
-- at least one pane carries a provider. That is where the "a saved preset needs
-- at least one agent pane" 400 came from: a schema constraint, not a product
-- rule. #35 deleted the last reader of the grid columns (`launch-modal.tsx`),
-- so they can go, and the constraint with them.
--
-- SQLite cannot drop NOT NULL (or a column carrying an FK) in place, so this is
-- the canonical create-new / copy / drop / rename rebuild. `PRAGMA foreign_keys`
-- is toggled around it and restored to ON at the end — `app/database.py` sets it
-- on the connection and every later statement in the process depends on it.
--
-- Step 1 converts every row still in the grid shape (`panes_json IS NULL`) into
-- a pane list *here*, rather than leaving it to a read-time compatibility path:
-- this migration deletes that path, so a row that survived in the old shape
-- would have no reader at all. The projection reproduces the departing
-- `launch_preset_service._panes_from_grid` exactly — row-major over
-- rows x cols, each position taking its own cell's `provider_id` when
-- `cells_json` has one and the header `provider_id` otherwise, every pane an
-- agent pane with `model=null`, `permission_mode=""`, `send_prompt=true`. The
-- recursive walk accumulates positions in order; `group_concat` would have
-- needed the aggregate ORDER BY of SQLite 3.44+, which the frozen sidecar
-- cannot assume.
--
-- `cells_json` goes with them. Its per-cell `extra_args`, `env_overlay` and
-- `project_id` have had no pane equivalent and no reader since #34; keeping the
-- column would preserve exactly the silent-dead-data shape this migration is
-- here to remove.
PRAGMA foreign_keys=OFF;

WITH RECURSIVE
legacy(pid, n_rows, n_cols, header_provider, cells) AS (
    SELECT id, rows, cols, provider_id, cells_json
      FROM launch_presets
     WHERE panes_json IS NULL
),
walk(pid, k, total, acc) AS (
    SELECT pid, 0, n_rows * n_cols, '' FROM legacy
    UNION ALL
    SELECT w.pid, w.k + 1, w.total,
           w.acc
             || CASE WHEN w.k > 0 THEN ',' ELSE '' END
             || json_object(
                  'kind', 'agent',
                  'provider_id', COALESCE(
                      (SELECT json_extract(c.value, '$.provider_id')
                         FROM json_each(l.cells) AS c
                        WHERE json_extract(c.value, '$.row') = w.k / l.n_cols
                          AND json_extract(c.value, '$.col') = w.k % l.n_cols),
                      l.header_provider),
                  'model', NULL,
                  'permission_mode', '',
                  'send_prompt', json('true'))
      FROM walk AS w JOIN legacy AS l ON l.pid = w.pid
     WHERE w.k < w.total
)
UPDATE launch_presets
   SET panes_json = (SELECT '[' || w.acc || ']' FROM walk AS w
                      WHERE w.pid = launch_presets.id AND w.k = w.total),
       split = CASE WHEN rows = 1 THEN 'cols'
                    WHEN cols = 1 THEN 'rows'
                    ELSE 'grid' END
 WHERE panes_json IS NULL;

CREATE TABLE launch_presets_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    extra_args TEXT    NOT NULL DEFAULT '',
    target     TEXT    NOT NULL CHECK (target IN ('embedded', 'popout')),
    profile_id INTEGER NULL REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    panes_json TEXT    NOT NULL,
    split      TEXT    NOT NULL DEFAULT 'cols'
                       CHECK (split IN ('cols', 'rows', 'grid'))
);

INSERT INTO launch_presets_new
    (id, name, project_id, extra_args, target, profile_id, created_at,
     panes_json, split)
SELECT id, name, project_id, extra_args, target, profile_id, created_at,
       panes_json, COALESCE(split, 'cols')
  FROM launch_presets;

DROP TABLE launch_presets;
ALTER TABLE launch_presets_new RENAME TO launch_presets;
CREATE INDEX IF NOT EXISTS idx_launch_presets_project ON launch_presets(project_id);

PRAGMA foreign_keys=ON;
