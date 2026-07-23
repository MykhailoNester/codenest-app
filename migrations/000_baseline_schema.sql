-- 000_baseline_schema.sql
-- The initial database schema. Applied verbatim via db.executescript() by
-- app/database.py:init_db() on first launch.
--
-- Idempotent: CREATE TABLE/INDEX/TRIGGER/VIRTUAL TABLE IF NOT EXISTS and
-- INSERT OR IGNORE, so it is safe against both a brand-new empty database and a
-- database from an older dev build that already has some objects — existing
-- tables/indexes/triggers/rows are skipped without error.
--
-- Contains the full schema PLUS functional reference data only (app settings,
-- taxonomies, integration catalog, the default workspace, and the 'Unassigned'
-- sentinel project). It deliberately contains NO test/demo data and NO
-- environment-specific rows (portfolio projects are imported at runtime via
-- onboarding).
--
-- FTS5 shadow tables are omitted (auto-created by CREATE VIRTUAL TABLE); the
-- FTS indexes rebuild via their content triggers as base rows are inserted.
-- foreign_keys is disabled for the duration of this script so seed-row insert
-- order is irrelevant, then re-enabled.

PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('human', 'agent')),
    department TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'planned', 'inactive')),
    agent_file TEXT,
    joined_date TEXT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, subtype TEXT DEFAULT 'persona');
CREATE TABLE IF NOT EXISTS task_blockers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    blocked_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    blocking_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    resolved INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blocked_task_id, blocking_task_id)
);
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL
        CHECK(category IN ('report', 'decision', 'retro', 'strategy', 'agent', 'process', 'other')),
    file_path TEXT NOT NULL,
    author_id INTEGER REFERENCES members(id),
    task_id INTEGER REFERENCES tasks(id),
    summary TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, session_id TEXT REFERENCES agent_sessions(session_id));
CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    actor TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, project_id INTEGER REFERENCES projects(id));
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    tech_stack TEXT,
    status TEXT DEFAULT 'active',
    path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, root_path TEXT, git_remote TEXT, is_active INTEGER NOT NULL DEFAULT 1, is_workspace INTEGER NOT NULL DEFAULT 0, imported_at TIMESTAMP, last_scanned_at TIMESTAMP, workspace_id INTEGER NOT NULL DEFAULT 1, default_provider_id INTEGER NULL REFERENCES providers(id) ON DELETE SET NULL, profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_task_blockers_blocked ON task_blockers(blocked_task_id);
CREATE INDEX IF NOT EXISTS idx_task_blockers_blocking ON task_blockers(blocking_task_id);
CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    profile TEXT NOT NULL DEFAULT 'unknown',
    cwd TEXT,
    transcript_path TEXT,
    initial_prompt TEXT,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'idle', 'stopped', 'ended')),
    current_tool TEXT,
    current_tool_use_id TEXT,
    current_tool_started_at TEXT,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_event_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    total_tool_calls INTEGER NOT NULL DEFAULT 0,
    project_id INTEGER REFERENCES projects(id),
    task_id INTEGER REFERENCES tasks(id)
, model TEXT, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0.0, provider_id INTEGER REFERENCES providers(id), pane_id TEXT);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_profile ON agent_sessions(profile);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_last_event ON agent_sessions(last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_pane_id ON agent_sessions(pane_id);
CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    tool_use_id TEXT,
    summary TEXT,
    payload_json TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
, project_id INTEGER);
CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_model ON agent_sessions(model);
CREATE TABLE IF NOT EXISTS profiles (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NOT NULL UNIQUE,
    color              TEXT    NOT NULL DEFAULT '#6366f1',
    icon               TEXT    NOT NULL DEFAULT 'user',
    cwd_hint           TEXT,
    env_json           TEXT    NOT NULL DEFAULT '{}',
    claude_config_dir  TEXT,
    default_model      TEXT,
    default_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
, provider_id INTEGER REFERENCES providers(id));
CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
CREATE INDEX IF NOT EXISTS idx_profiles_cwd_hint ON profiles(cwd_hint);
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
    title,
    description,
    content='tasks',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5(
    name,
    description,
    content='projects',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS projects_fts_ai AFTER INSERT ON projects BEGIN
    INSERT INTO projects_fts(rowid, name, description)
    VALUES (new.id, new.name, COALESCE(new.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS projects_fts_ad AFTER DELETE ON projects BEGIN
    INSERT INTO projects_fts(projects_fts, rowid, name, description)
    VALUES ('delete', old.id, old.name, COALESCE(old.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS projects_fts_au AFTER UPDATE ON projects BEGIN
    INSERT INTO projects_fts(projects_fts, rowid, name, description)
    VALUES ('delete', old.id, old.name, COALESCE(old.description, ''));
    INSERT INTO projects_fts(rowid, name, description)
    VALUES (new.id, new.name, COALESCE(new.description, ''));
END;
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    title,
    summary,
    file_path,
    content='documents',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS documents_fts_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, summary, file_path)
    VALUES (new.id, new.title, COALESCE(new.summary, ''), new.file_path);
END;
CREATE TRIGGER IF NOT EXISTS documents_fts_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, summary, file_path)
    VALUES ('delete', old.id, old.title, COALESCE(old.summary, ''), old.file_path);
END;
CREATE TRIGGER IF NOT EXISTS documents_fts_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, summary, file_path)
    VALUES ('delete', old.id, old.title, COALESCE(old.summary, ''), old.file_path);
    INSERT INTO documents_fts(rowid, title, summary, file_path)
    VALUES (new.id, new.title, COALESCE(new.summary, ''), new.file_path);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS inbox_fts USING fts5(
    title,
    description,
    content='workflow_items',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS agent_events_fts USING fts5(
    event_type,
    summary,
    content='agent_events',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS agent_events_fts_ai AFTER INSERT ON agent_events
WHEN new.event_type IS NOT NULL BEGIN
    INSERT INTO agent_events_fts(rowid, event_type, summary)
    VALUES (new.id, new.event_type, COALESCE(new.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS agent_events_fts_ad AFTER DELETE ON agent_events BEGIN
    INSERT INTO agent_events_fts(agent_events_fts, rowid, event_type, summary)
    VALUES ('delete', old.id, old.event_type, COALESCE(old.summary, ''));
END;
CREATE TRIGGER IF NOT EXISTS agent_events_fts_au AFTER UPDATE ON agent_events BEGIN
    INSERT INTO agent_events_fts(agent_events_fts, rowid, event_type, summary)
    VALUES ('delete', old.id, old.event_type, COALESCE(old.summary, ''));
    INSERT INTO agent_events_fts(rowid, event_type, summary)
    VALUES (new.id, new.event_type, COALESCE(new.summary, ''));
END;
CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT,
    payload_json TEXT,
    target       TEXT,
    priority     TEXT NOT NULL DEFAULT 'normal',
    read_at      TIMESTAMP,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
    ON notifications(read_at, created_at DESC);
CREATE TABLE IF NOT EXISTS providers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL UNIQUE,
    display_name     TEXT    NOT NULL,
    command_template TEXT    NOT NULL,
    default_args     TEXT    NOT NULL DEFAULT '',
    is_enabled       INTEGER NOT NULL DEFAULT 1,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, color TEXT, default_env_json TEXT NOT NULL DEFAULT '{}', models_json TEXT NOT NULL DEFAULT '["default"]', default_model TEXT, api_key TEXT, base_url TEXT);
CREATE TABLE IF NOT EXISTS launch_presets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    rows       INTEGER NOT NULL CHECK (rows BETWEEN 1 AND 4),
    cols       INTEGER NOT NULL CHECK (cols BETWEEN 1 AND 4),
    extra_args TEXT    NOT NULL DEFAULT '',
    target     TEXT    NOT NULL CHECK (target IN ('embedded', 'popout')),
    profile_id INTEGER NULL REFERENCES profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, cells_json TEXT);
CREATE INDEX IF NOT EXISTS idx_launch_presets_project ON launch_presets(project_id);
CREATE TABLE IF NOT EXISTS provider_models (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id  INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    model_name   TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    is_default   INTEGER NOT NULL DEFAULT 0,
    is_enabled   INTEGER NOT NULL DEFAULT 1,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_provider_models_provider ON provider_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_provider ON agent_sessions(provider_id);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);
CREATE TABLE IF NOT EXISTS launch_source_overrides (
    source_kind     TEXT    NOT NULL CHECK (source_kind IN ('task', 'inbox')),
    source_id       INTEGER NOT NULL,
    project_id      INTEGER,
    provider_id     INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    model           TEXT,
    rows            INTEGER,
    cols            INTEGER,
    target          TEXT    CHECK (target IS NULL OR target IN ('embedded', 'popout')),
    profile_id      INTEGER,
    extra_args      TEXT,
    prompt_fanout   TEXT    CHECK (prompt_fanout IS NULL OR prompt_fanout IN ('primary', 'every', 'none')),
    prompt_override TEXT,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source_kind, source_id)
);
CREATE TABLE IF NOT EXISTS taxonomies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(kind, slug)
);
CREATE INDEX IF NOT EXISTS idx_taxonomies_kind ON taxonomies(kind, sort_order);
CREATE TABLE IF NOT EXISTS "tasks" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    effort TEXT CHECK(effort IN ('small', 'medium', 'large')),
    assignee_id INTEGER REFERENCES members(id),
    source_item_id INTEGER REFERENCES workflow_items(id),
    project_id INTEGER NOT NULL REFERENCES projects(id),
    started_date TEXT,
    completed_date TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status_project ON tasks(status, project_id);
CREATE TABLE IF NOT EXISTS "workflow_items" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'inbox'
        CHECK(status IN ('inbox','review','ready','done','rejected')),
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('high','medium','low')),
    category TEXT NOT NULL DEFAULT 'idea'
        CHECK(category IN ('task','bug','idea','blocker','other')),
    -- Service-era columns (inbox_service / launch_seed_service).
    type TEXT NOT NULL DEFAULT 'action',
    action_text TEXT,
    source TEXT,
    project_id INTEGER REFERENCES projects(id),
    assignee_id INTEGER REFERENCES members(id),
    task_id INTEGER,
    due_date TEXT,
    submitted_date TEXT,
    reviewed_date TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workflow_items_status ON workflow_items(status);
CREATE INDEX IF NOT EXISTS idx_workflow_items_project ON workflow_items(project_id);
CREATE INDEX IF NOT EXISTS idx_workflow_items_created_at ON workflow_items(created_at);
CREATE TRIGGER IF NOT EXISTS tasks_fts_ai AFTER INSERT ON tasks BEGIN
    INSERT INTO tasks_fts(rowid, title, description)
    VALUES (new.id, new.title, COALESCE(new.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS tasks_fts_ad AFTER DELETE ON tasks BEGIN
    INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
    VALUES ('delete', old.id, old.title, COALESCE(old.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks BEGIN
    INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
    VALUES ('delete', old.id, old.title, COALESCE(old.description, ''));
    INSERT INTO tasks_fts(rowid, title, description)
    VALUES (new.id, new.title, COALESCE(new.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS inbox_fts_ai AFTER INSERT ON workflow_items BEGIN
    INSERT INTO inbox_fts(rowid, title, description)
    VALUES (new.id, new.title, COALESCE(new.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS inbox_fts_ad AFTER DELETE ON workflow_items BEGIN
    INSERT INTO inbox_fts(inbox_fts, rowid, title, description)
    VALUES ('delete', old.id, old.title, COALESCE(old.description, ''));
END;
CREATE TRIGGER IF NOT EXISTS inbox_fts_au AFTER UPDATE ON workflow_items BEGIN
    INSERT INTO inbox_fts(inbox_fts, rowid, title, description)
    VALUES ('delete', old.id, old.title, COALESCE(old.description, ''));
    INSERT INTO inbox_fts(rowid, title, description)
    VALUES (new.id, new.title, COALESCE(new.description, ''));
END;
CREATE TABLE IF NOT EXISTS marketplace_installs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    version     TEXT    NOT NULL,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(slug, project_id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_installs_project
    ON marketplace_installs(project_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_installs_slug
    ON marketplace_installs(slug);
CREATE TABLE IF NOT EXISTS parallel_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL REFERENCES providers(id),
    model       TEXT,
    prompt      TEXT    NOT NULL,
    rows        INTEGER NOT NULL DEFAULT 1,
    cols        INTEGER NOT NULL DEFAULT 2,
    status      TEXT    NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','done','failed')),
    started_at  TIMESTAMP,
    ended_at    TIMESTAMP,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_parallel_runs_project
    ON parallel_runs(project_id);
CREATE TABLE IF NOT EXISTS parallel_run_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      INTEGER NOT NULL REFERENCES parallel_runs(id) ON DELETE CASCADE,
    pane_index  INTEGER NOT NULL,
    session_id  TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','running','done','failed')),
    output      TEXT,
    started_at  TIMESTAMP,
    ended_at    TIMESTAMP,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_parallel_run_attempts_run
    ON parallel_run_attempts(run_id);
CREATE TABLE IF NOT EXISTS mcp_servers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    command     TEXT,
    args_json   TEXT    NOT NULL DEFAULT '[]',
    env_json    TEXT    NOT NULL DEFAULT '{}',
    enabled     INTEGER NOT NULL DEFAULT 1,
    source      TEXT    NOT NULL DEFAULT 'custom',
    notes       TEXT,
    scope_mode  TEXT    NOT NULL DEFAULT 'all'
                CHECK(scope_mode IN ('all','allowlist','off')),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_slug ON mcp_servers(slug);
CREATE TABLE IF NOT EXISTS agent_launch_overrides (
    profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    key         TEXT    NOT NULL,
    value_json  TEXT    NOT NULL,
    PRIMARY KEY (profile_id, key)
);
CREATE TABLE IF NOT EXISTS schedules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    kind             TEXT    NOT NULL DEFAULT 'cron'
                     CHECK(kind IN ('cron','event','interval')),
    enabled          INTEGER NOT NULL DEFAULT 1,
    cron_expr        TEXT,
    event_name       TEXT,
    -- Interval schedules ("every N from now"): next_fire = anchor/last + interval.
    interval_seconds INTEGER,
    anchor_at        TIMESTAMP,
    agent_name       TEXT    NOT NULL DEFAULT '',
    prompt           TEXT    NOT NULL DEFAULT '',
    project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    provider_id      INTEGER REFERENCES providers(id) ON DELETE SET NULL,
    model            TEXT,
    run_mode         TEXT    NOT NULL DEFAULT 'background'
                     CHECK(run_mode IN ('background','windowed')),
    result_kind      TEXT    NOT NULL DEFAULT 'transcript'
                     CHECK(result_kind IN ('transcript','artifact','summary','notification')),
    -- Output directory for artifact-kind runs. NULL = default
    -- <workspace>/schedule-artifacts/<name>/.
    artifact_dir     TEXT,
    permission_mode  TEXT    NOT NULL DEFAULT 'dontAsk',
    allowed_tools    TEXT,
    max_budget_usd   REAL,
    max_runtime_sec  INTEGER,
    notify_policy    TEXT    NOT NULL DEFAULT 'on_failure'
                     CHECK(notify_policy IN ('on_failure','every_run','never')),
    next_fire_at     TIMESTAMP,
    last_fired_at    TIMESTAMP,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_schedules_next_fire
    ON schedules(next_fire_at) WHERE enabled = 1 AND kind = 'cron';
CREATE INDEX IF NOT EXISTS idx_schedules_event
    ON schedules(event_name) WHERE enabled = 1 AND kind = 'event';
CREATE INDEX IF NOT EXISTS idx_schedules_next_fire_v2
    ON schedules(next_fire_at) WHERE enabled = 1 AND kind = 'cron';
CREATE INDEX IF NOT EXISTS idx_schedules_event_v2
    ON schedules(event_name) WHERE enabled = 1 AND kind = 'event';
CREATE INDEX IF NOT EXISTS idx_schedules_next_fire_interval
    ON schedules(next_fire_at) WHERE enabled = 1 AND kind = 'interval';
CREATE TABLE IF NOT EXISTS schedule_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id    INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    trigger_kind   TEXT    NOT NULL CHECK (trigger_kind IN ('cron', 'event', 'manual')),
    -- Lifecycle: queued → running → succeeded | failed | timed_out | cancelled
    --            queued → skipped (overlap guard)
    --            (missed fire slot) → missed
    status         TEXT    NOT NULL DEFAULT 'queued'
                   CHECK(status IN ('queued','running','succeeded','failed',
                                    'skipped','missed','timed_out','cancelled')),
    session_id     TEXT,
    trigger        TEXT    NOT NULL DEFAULT 'scheduled'
                   CHECK(trigger IN ('scheduled','manual','catchup','event')),
    detail         TEXT,
    fired_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at     TIMESTAMP,
    finished_at    TIMESTAMP,
    duration_ms    INTEGER,
    exit_code      INTEGER,
    transcript_path TEXT,
    artifact_path  TEXT,
    summary_text   TEXT,
    tokens_in      INTEGER,
    tokens_out     INTEGER,
    cost_usd       REAL
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule
    ON schedule_runs(schedule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_status
    ON schedule_runs(status) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_schedule_runs_session
    ON schedule_runs(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_v2
    ON schedule_runs(schedule_id, fired_at DESC);
CREATE TABLE IF NOT EXISTS preview_visits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL,
    title       TEXT,
    visited_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_preview_visits_visited
    ON preview_visits(visited_at DESC);
CREATE TABLE IF NOT EXISTS attachments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filename        TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    size_bytes      INTEGER NOT NULL,
    content_b64     TEXT NOT NULL,
    extracted_text  TEXT,
    inbox_item_id   INTEGER REFERENCES workflow_items(id) ON DELETE SET NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_inbox ON attachments(inbox_item_id);
CREATE TABLE IF NOT EXISTS library_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    tags_json   TEXT NOT NULL DEFAULT '[]',
    source      TEXT NOT NULL DEFAULT 'manual',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_library_items_updated ON library_items(updated_at DESC);
CREATE TABLE IF NOT EXISTS budgets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    scope_type    TEXT NOT NULL CHECK(scope_type IN ('workspace','project','agent')),
    scope_id      INTEGER,
    scope_key     TEXT,
    period        TEXT NOT NULL CHECK(period IN ('daily','weekly','monthly')),
    limit_usd     REAL NOT NULL CHECK(limit_usd > 0),
    hard_stop     INTEGER NOT NULL DEFAULT 0 CHECK(hard_stop IN (0,1)),
    enabled       INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_budgets_scope
    ON budgets(scope_type, scope_id, scope_key) WHERE enabled = 1;
CREATE TABLE IF NOT EXISTS budget_threshold_alerts (
    budget_id     INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    period_start  TEXT NOT NULL,
    threshold     INTEGER NOT NULL CHECK(threshold IN (50,80,100)),
    fired_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (budget_id, period_start, threshold)
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at
    ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_project
    ON activity_log(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS insight_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_key    TEXT NOT NULL,
    day_key     TEXT NOT NULL,
    inbox_id    INTEGER REFERENCES workflow_items(id) ON DELETE SET NULL,
    payload_json TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rule_key, day_key)
);
CREATE INDEX IF NOT EXISTS idx_insight_runs_created
    ON insight_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_at
    ON agent_sessions(started_at);
CREATE TABLE IF NOT EXISTS plugins (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    slug              TEXT NOT NULL UNIQUE,
    name              TEXT NOT NULL,
    version           TEXT NOT NULL DEFAULT '0.0.0',
    dir_path          TEXT NOT NULL,
    manifest_json     TEXT NOT NULL DEFAULT '{}',
    manifest_sha256   TEXT NOT NULL,
    signature_status  TEXT NOT NULL DEFAULT 'untrusted'
        CHECK(signature_status IN ('trusted','untrusted')),
    enabled           INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    load_status       TEXT NOT NULL DEFAULT 'loaded'
        CHECK(load_status IN ('loaded','skipped','error')),
    load_error        TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plugins_status
    ON plugins(load_status, enabled);
CREATE TABLE IF NOT EXISTS sync_targets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'local'
        CHECK(kind IN ('local','icloud','dropbox','syncthing','s3')),
    dir_path    TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(label)
);
CREATE TABLE IF NOT EXISTS sync_snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id       INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
    file_name       TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    bytes           INTEGER NOT NULL DEFAULT 0,
    archive_sha256  TEXT NOT NULL,
    sources_json    TEXT NOT NULL DEFAULT '[]',
    action          TEXT NOT NULL DEFAULT 'create'
        CHECK(action IN ('create','restore')),
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sync_snapshots_target_created
    ON sync_snapshots(target_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mcp_server_project_scopes (
    mcp_server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
    project_id    INTEGER NOT NULL REFERENCES projects(id)    ON DELETE CASCADE,
    PRIMARY KEY (mcp_server_id, project_id)
);
CREATE TABLE IF NOT EXISTS integration_catalog (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    icon         TEXT NOT NULL DEFAULT 'integration',
    pane_url     TEXT NOT NULL DEFAULT '',
    mcp_command  TEXT NOT NULL,
    mcp_args     TEXT NOT NULL DEFAULT '[]',
    env_template TEXT NOT NULL DEFAULT '[]',
    is_custom    INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS agent_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
    provider_id   INTEGER REFERENCES providers(id),
    project_id    INTEGER REFERENCES projects(id),
    pane_id       TEXT,
    model         TEXT,
    prompt_preview TEXT,
    status        TEXT NOT NULL DEFAULT 'running',
    source_kind   TEXT,
    source_id     INTEGER,
    started_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at      TIMESTAMP
, profile TEXT, target TEXT);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_pane    ON agent_runs(pane_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status  ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_profile ON agent_runs(profile);
CREATE INDEX IF NOT EXISTS idx_agent_runs_target ON agent_runs(target);
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_root_path
    ON projects(root_path) WHERE root_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_is_workspace_singleton
    ON projects(is_workspace) WHERE is_workspace = 1;
CREATE INDEX IF NOT EXISTS idx_projects_profile ON projects(profile_id);
CREATE TABLE IF NOT EXISTS project_agents (
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
                           CHECK(link_type IN ('symlink','hardlink','junction')),
    enabled                INTEGER NOT NULL DEFAULT 1,
    has_name_mismatch      INTEGER NOT NULL DEFAULT 0,
    verify_status          TEXT    NOT NULL DEFAULT 'ok'
                           CHECK(verify_status IN ('ok','dangling','mismatch','missing_target')),
    last_scanned_at        TIMESTAMP,
    last_verified_at       TIMESTAMP,
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_agents_link_path ON project_agents(link_path);
CREATE INDEX IF NOT EXISTS idx_project_agents_project ON project_agents(project_id);
CREATE INDEX IF NOT EXISTS idx_project_agents_enabled ON project_agents(enabled);
CREATE INDEX IF NOT EXISTS idx_project_agents_verify  ON project_agents(verify_status);
CREATE TABLE IF NOT EXISTS project_skills (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name             TEXT    NOT NULL,
    canonical_path   TEXT    NOT NULL,
    link_path        TEXT    NOT NULL,
    link_type        TEXT    NOT NULL DEFAULT 'symlink'
                     CHECK(link_type IN ('symlink','hardlink','junction')),
    enabled          INTEGER NOT NULL DEFAULT 1,
    verify_status    TEXT    NOT NULL DEFAULT 'ok'
                     CHECK(verify_status IN ('ok','dangling','missing_target')),
    last_scanned_at  TIMESTAMP,
    last_verified_at TIMESTAMP,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_skills_link_path ON project_skills(link_path);
CREATE INDEX IF NOT EXISTS idx_project_skills_project ON project_skills(project_id);
CREATE TABLE IF NOT EXISTS project_commands (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name             TEXT    NOT NULL,
    canonical_path   TEXT    NOT NULL,
    link_path        TEXT    NOT NULL,
    link_type        TEXT    NOT NULL DEFAULT 'symlink'
                     CHECK(link_type IN ('symlink','hardlink','junction')),
    enabled          INTEGER NOT NULL DEFAULT 1,
    verify_status    TEXT    NOT NULL DEFAULT 'ok'
                     CHECK(verify_status IN ('ok','dangling','missing_target')),
    last_scanned_at  TIMESTAMP,
    last_verified_at TIMESTAMP,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, name)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_commands_link_path ON project_commands(link_path);
CREATE INDEX IF NOT EXISTS idx_project_commands_project ON project_commands(project_id);
CREATE TABLE IF NOT EXISTS org_agents (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL UNIQUE,
    display_name     TEXT    NOT NULL,
    description      TEXT,
    model            TEXT,
    version          TEXT    NOT NULL,
    bundle_path      TEXT    NOT NULL,
    install_path     TEXT    NOT NULL,
    link_path        TEXT    NOT NULL,
    link_type        TEXT    NOT NULL DEFAULT 'symlink'
                     CHECK(link_type IN ('symlink','hardlink','junction')),
    enabled          INTEGER NOT NULL DEFAULT 1,
    verify_status    TEXT    NOT NULL DEFAULT 'ok'
                     CHECK(verify_status IN ('ok','dangling','missing_target')),
    sha256           TEXT,
    installed_at     TIMESTAMP,
    last_verified_at TIMESTAMP,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
, source TEXT NOT NULL DEFAULT 'bundled');
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_agents_link_path ON org_agents(link_path);
CREATE INDEX IF NOT EXISTS idx_org_agents_enabled ON org_agents(enabled);
CREATE TABLE IF NOT EXISTS workspace_state (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS workspaces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    slug       TEXT NOT NULL UNIQUE,
    label      TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
CREATE TABLE IF NOT EXISTS session_project_costs (
    session_id TEXT    NOT NULL,
    project_id INTEGER NOT NULL,
    tokens_in  INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    cost_usd   REAL    NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_spc_project ON session_project_costs(project_id);

-- ── functional reference data ──
INSERT OR IGNORE INTO "app_settings" VALUES('task_statuses','["backlog","todo","in-progress","blocked","done"]','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('task_status_colors','{"backlog":"var(--fg-4)","todo":"#60a5fa","in-progress":"#f59e0b","blocked":"#ef4444","done":"#22c55e"}','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('document_categories','["report","strategy","agent","decision","retro","process","other"]','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('document_category_colors','{"report":"#3b82f6","strategy":"#a855f7","agent":"#22c55e","decision":"#f59e0b","retro":"#ec4899","process":"#06b6d4","other":"var(--fg-3)"}','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('cost_threshold_usd','10.0','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('notification_prefs_json','{"task_assigned":{"toast":true,"native":false},"blocker_resolved":{"toast":true,"native":false},"session_completed":{"toast":true,"native":false},"session_failed":{"toast":true,"native":true},"session_info":{"toast":true,"native":false},"cost_threshold":{"toast":true,"native":true},"budget_threshold":{"toast":true,"native":true}}','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('terminal.font_family','"ui-monospace, SFMono-Regular, ''SF Mono'', monospace"','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('terminal.font_size','13','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('terminal.scrollback','5000','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('terminal.shell','""','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('terminal.copy_on_select','1','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('terminal.paste_confirm_multiline','1','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('terminal.cwd_follow','1','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('wizard.completed','"false"','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('plugin_trust_mode','"permissive"','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('plugin_trust_hashes','[]','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "app_settings" VALUES('enabled_features','{"work":true,"notifications":true,"parallel":true,"preview":true,"budgets":true,"schedules":true,"snippets":false,"gallery":false,"feed":false,"mcp":false,"integrations":false,"plugins":false,"sync":false}','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(1,'gmail','Gmail','Read, search, and draft Gmail messages from agents.','integration','https://mail.google.com','npx','["-y","@modelcontextprotocol/server-gmail"]','["GMAIL_CREDENTIALS_PATH"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(2,'google_calendar','Google Calendar','Browse and create calendar events.','integration','https://calendar.google.com','npx','["-y","@modelcontextprotocol/server-gcal"]','["GCAL_CREDENTIALS_PATH"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(3,'google_drive','Google Drive','Search and read files from Drive.','integration','https://drive.google.com','npx','["-y","@modelcontextprotocol/server-gdrive"]','["GDRIVE_CREDENTIALS_PATH"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(4,'notion','Notion','Query and edit Notion pages and databases.','integration','https://www.notion.so','npx','["-y","@modelcontextprotocol/server-notion"]','["NOTION_API_TOKEN"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(5,'atlassian','Atlassian (Jira + Confluence)','Search Jira issues and Confluence pages.','integration','https://id.atlassian.com','npx','["-y","@modelcontextprotocol/server-atlassian"]','["ATLASSIAN_EMAIL","ATLASSIAN_API_TOKEN","ATLASSIAN_SITE"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(6,'slack','Slack','Read channels, post messages, react to threads.','integration','https://app.slack.com/client','npx','["-y","@modelcontextprotocol/server-slack"]','["SLACK_BOT_TOKEN","SLACK_TEAM_ID"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(7,'figma','Figma','Inspect Figma frames and design tokens.','integration','https://www.figma.com/files','npx','["-y","@modelcontextprotocol/server-figma"]','["FIGMA_API_KEY"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(8,'sentry','Sentry','Triage Sentry issues from agent prompts.','integration','https://sentry.io','npx','["-y","@modelcontextprotocol/server-sentry"]','["SENTRY_AUTH_TOKEN","SENTRY_ORG"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(9,'github','GitHub','Browse repos, PRs, and issues; draft comments.','integration','https://github.com','npx','["-y","@modelcontextprotocol/server-github"]','["GITHUB_PERSONAL_ACCESS_TOKEN"]',0,'2026-06-01 11:26:29');
INSERT OR IGNORE INTO "integration_catalog" VALUES(10,'linear','Linear','Search Linear issues and projects.','integration','https://linear.app','npx','["-y","@modelcontextprotocol/server-linear"]','["LINEAR_API_KEY"]',0,'2026-06-01 11:26:29');
-- Profiles: no seeded rows — users create their own via Settings → Profiles.
INSERT OR IGNORE INTO "projects" (id, name, description, tech_stack, status, path, created_at, root_path, git_remote, is_active, is_workspace, imported_at, last_scanned_at, workspace_id, default_provider_id) VALUES(1,'Unassigned','Catch-all project for tasks without an explicit project','','active',NULL,'2026-06-01 11:26:29',NULL,NULL,1,0,NULL,NULL,1,NULL);
INSERT OR IGNORE INTO "taxonomies" VALUES(1,'task_status','backlog','Idea',10,'#6b7280',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(2,'task_status','todo','To do',20,'#60a5fa',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(3,'task_status','in-progress','In progress',30,'#f59e0b',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(4,'task_status','blocked','Blocked',40,'#ef4444',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(5,'task_status','done','Done',50,'#22c55e',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(6,'task_priority','high','High',10,'#ef4444',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(7,'task_priority','medium','Medium',20,'#f59e0b',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(8,'task_priority','low','Low',30,'#6b7280',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(9,'workflow_status','inbox','Inbox',10,'#60a5fa',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(10,'workflow_status','review','Review',20,'#f59e0b',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(11,'workflow_status','ready','Ready',30,'#22c55e',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(12,'workflow_status','done','Done',40,'#22c55e',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "taxonomies" VALUES(13,'workflow_status','rejected','Rejected',50,'#6b7280',1,1,'2026-06-01 11:26:29','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "workspace_state" VALUES('schema_version','1','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "workspace_state" VALUES('org_agents_version','','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "workspace_state" VALUES('last_bootstrap_at','','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "workspace_state" VALUES('workspace_root','','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "workspace_state" VALUES('app_data_dir','','2026-06-01 11:26:29');
INSERT OR IGNORE INTO "workspaces" VALUES(1,'default','Command Center','2026-06-01 11:26:29','2026-06-01 11:26:29');

PRAGMA foreign_keys=ON;
