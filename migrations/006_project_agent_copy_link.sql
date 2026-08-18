-- Materialized agent aliases: allow link_type = 'copy' on project_agents.
--
-- Two projects that both ship a `code-reviewer` cannot both be *linked* into the
-- workspace: Claude Code resolves an agent by its frontmatter `name:`, and a
-- symlink shares its target's bytes, so the second file would declare the same
-- name and the CLI could not tell them apart (command_center_service's
-- _collect_desired_links documents this at length). The fix is to stop linking
-- the duplicates and generate them instead — a copy whose frontmatter `name:` is
-- rewritten to `<project-slug>--<name>` — which needs a fourth value in the
-- link_type enum to record what the workspace entry actually is.
--
-- `copy` is written only for a materialized alias, so the value doubles as the
-- "this entry is generated, not a link" flag: an aliased row is a copy and a
-- copy is an aliased row. The alias itself is not stored — it is the stem of
-- `link_path`, and recomputed by the same collector that decides it, so there is
-- no second copy of the policy to drift (the reason list_agent_name_conflicts
-- is recomputed rather than persisted, too).
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. Columns,
-- defaults, constraints and indexes are reproduced verbatim from
-- 000_baseline_schema.sql apart from the widened enum. Nothing references
-- project_agents, so the DROP cascades nowhere; foreign_keys is toggled off for
-- the swap the same way the baseline schema does it.
--
-- No INSERT: the clean-slate invariant holds, and existing rows carry over with
-- their current link_type untouched (a fresh regeneration re-derives them all).

PRAGMA foreign_keys=OFF;

CREATE TABLE project_agents_new (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider_id            INTEGER NULL    REFERENCES providers(id) ON DELETE SET NULL,
    name                   TEXT    NOT NULL,
    frontmatter_name_raw   TEXT,
    description            TEXT,
    model                  TEXT,
    canonical_path         TEXT    NOT NULL,
    link_path              TEXT    NOT NULL,
    link_type              TEXT    NOT NULL DEFAULT 'symlink'
                           CHECK(link_type IN ('symlink','hardlink','junction','copy')),
    enabled                INTEGER NOT NULL DEFAULT 1,
    has_name_mismatch      INTEGER NOT NULL DEFAULT 0,
    verify_status          TEXT    NOT NULL DEFAULT 'ok'
                           CHECK(verify_status IN ('ok','dangling','mismatch','missing_target')),
    last_scanned_at        TIMESTAMP,
    last_verified_at       TIMESTAMP,
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, name)
);

INSERT INTO project_agents_new
    (id, project_id, provider_id, name, frontmatter_name_raw, description, model,
     canonical_path, link_path, link_type, enabled, has_name_mismatch,
     verify_status, last_scanned_at, last_verified_at, created_at)
SELECT
     id, project_id, provider_id, name, frontmatter_name_raw, description, model,
     canonical_path, link_path, link_type, enabled, has_name_mismatch,
     verify_status, last_scanned_at, last_verified_at, created_at
  FROM project_agents;

DROP TABLE project_agents;
ALTER TABLE project_agents_new RENAME TO project_agents;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_agents_link_path ON project_agents(link_path);
CREATE INDEX IF NOT EXISTS idx_project_agents_project ON project_agents(project_id);
CREATE INDEX IF NOT EXISTS idx_project_agents_enabled ON project_agents(enabled);
CREATE INDEX IF NOT EXISTS idx_project_agents_verify  ON project_agents(verify_status);

PRAGMA foreign_keys=ON;
