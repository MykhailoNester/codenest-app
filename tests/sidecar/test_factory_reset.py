"""Tests for the factory_reset wipe + reseed path.

Seeds a temp DB with demo projects, workflow_items, members, providers, and
profiles, then calls the reset logic directly and asserts the expected
post-reset state:

  - providers = 0, provider_models = 0, profiles = 0
  - projects has exactly Unassigned (id=1) + Command Center (is_workspace=1)
  - org_agents = the 3 bundled agents (atlas-recruiter, orion-ops, vega-research)
  - workflow_items = 0, tasks = 0, members = 0, agent_sessions = 0
  - workspace_state has no onboarding_completed key (so onboarding re-shows)
"""

from __future__ import annotations

import pathlib

import pytest

BUNDLE_DIR = (
    pathlib.Path(__file__).parents[2] / "src-tauri" / "resources" / "org-agents"
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _count(db, table: str) -> int:
    cur = await db.execute(f"SELECT COUNT(*) FROM {table}")  # noqa: S608
    row = await cur.fetchone()
    assert row is not None
    return int(row[0])


async def _seed_demo_data(db) -> None:
    """Insert realistic demo rows that should all vanish after factory reset."""
    # A provider and a model
    await db.execute(
        """INSERT INTO providers (name, display_name, command_template)
           VALUES ('anthropic', 'Anthropic', 'claude')"""
    )
    await db.execute(
        """INSERT INTO provider_models (provider_id, model_name, display_name)
           VALUES (1, 'claude-sonnet-4-6', 'Claude Sonnet 4.6')"""
    )
    # A profile
    await db.execute(
        """INSERT INTO profiles (name, color, icon, env_json)
           VALUES ('demo-profile', '#aabbcc', 'user', '{}')"""
    )
    # A member
    await db.execute(
        """INSERT INTO members (name, role, type) VALUES ('Alice', 'Dev', 'human')"""
    )
    # Two demo projects (simulating onboarded portfolio projects)
    await db.execute(
        """INSERT INTO projects (name, description, status)
           VALUES ('Acme Storefront', 'Demo e-commerce', 'active')"""
    )
    await db.execute(
        """INSERT INTO projects (name, description, status)
           VALUES ('Nimbus Analytics', 'Demo analytics', 'active')"""
    )
    # workflow_items referencing the demo projects
    await db.execute(
        """INSERT INTO workflow_items (title, status, project_id)
           VALUES ('fix login bug', 'inbox', 2)"""
    )
    await db.execute(
        """INSERT INTO workflow_items (title, status, project_id)
           VALUES ('add dashboard chart', 'review', 3)"""
    )
    # A task referencing a demo project
    await db.execute(
        """INSERT INTO tasks (title, status, project_id)
           VALUES ('Ship v1', 'todo', 2)"""
    )
    await db.commit()


# ---------------------------------------------------------------------------
# test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_factory_reset_wipes_user_data_and_restores_seed(
    migrated_db, tmp_path: pathlib.Path
) -> None:
    """factory_reset leaves the DB in first-run state:

    - providers / provider_models / profiles = 0
    - projects = {Unassigned, Command Center}
    - org_agents = 3 bundled agents
    - workflow_items / tasks / members / agent_sessions = 0
    - workspace_state has no onboarding_completed key
    """
    # Point settings at the tmp workspace so bootstrap doesn't touch real dirs.
    ws_root = tmp_path / "workspace"
    org_dir = tmp_path / "org-agents"
    ws_root.mkdir()
    org_dir.mkdir()

    # Patch settings for this test so bootstrap resolves paths into tmp_path.
    from app import config as app_config

    orig_ws = app_config.settings.WORKSPACE_ROOT
    orig_org = app_config.settings.ORG_AGENTS_DIR
    orig_app_data = app_config.settings.APP_DATA_DIR
    orig_bundle = app_config.settings.BUNDLE_RESOURCES

    app_config.settings.WORKSPACE_ROOT = ws_root
    app_config.settings.ORG_AGENTS_DIR = org_dir
    app_config.settings.APP_DATA_DIR = tmp_path
    app_config.settings.BUNDLE_RESOURCES = BUNDLE_DIR

    try:
        await _seed_demo_data(migrated_db)

        # Pre-reset sanity checks
        assert await _count(migrated_db, "providers") >= 1
        assert await _count(migrated_db, "profiles") >= 1
        assert await _count(migrated_db, "workflow_items") == 2
        assert await _count(migrated_db, "tasks") == 1
        assert await _count(migrated_db, "members") == 1
        # projects: Unassigned (from migration) + 2 demo projects
        assert await _count(migrated_db, "projects") == 3

        # --- run the reset logic ---
        from app.services import command_center_service

        # Wipe all tables (same list as the router)
        tables = [
            "session_project_costs",
            "agent_events",
            "agent_runs",
            "agent_sessions",
            "project_agents",
            "project_skills",
            "project_commands",
            "org_agents",
            "mcp_server_project_scopes",
            "mcp_servers",
            "agent_launch_overrides",
            "notifications",
            "schedule_runs",
            "schedules",
            "review_comments",
            "parallel_run_attempts",
            "parallel_runs",
            "marketplace_installs",
            "launch_presets",
            "launch_source_overrides",
            "provider_models",
            "providers",
            "budget_threshold_alerts",
            "budgets",
            "activity_log",
            "task_blockers",
            "attachments",
            "insight_runs",
            "tasks",
            "workflow_items",
            "documents",
            "members",
            "preview_visits",
            "library_items",
            "sync_snapshots",
            "sync_targets",
            "plugins",
            "workspaces",
            "taxonomies",
            "integration_catalog",
            "profiles",
            "projects",
            "app_settings",
            "workspace_state",
        ]
        import logging

        logger = logging.getLogger("test_factory_reset")
        for table in tables:
            try:
                await migrated_db.execute(
                    f"DELETE FROM {table}"  # noqa: S608
                )
            except Exception as exc:
                logger.warning("factory_reset: DELETE FROM %s failed: %s", table, exc)
        await migrated_db.commit()

        # Reseed reference data
        seeded = await command_center_service.reseed_reference_data(migrated_db)
        assert seeded > 0, "reseed_reference_data must replay at least one statement"

        # Bootstrap recreates the Command Center workspace project + org agents
        await command_center_service.bootstrap(migrated_db, force=True)

        # ------------------------------------------------------------------
        # Assertions: expected end-state
        # ------------------------------------------------------------------

        # providers / provider_models / profiles must be zero
        assert await _count(migrated_db, "providers") == 0, (
            "providers must be 0 after reset"
        )
        assert await _count(migrated_db, "provider_models") == 0, (
            "provider_models must be 0 after reset"
        )
        # bootstrap() recreates the default 'Home Base' grouping profile
        # (see test_profiles_grouping); a reset therefore leaves exactly that one.
        assert await _count(migrated_db, "profiles") == 1, (
            "only the default Home Base profile should exist after reset"
        )
        prof_cur = await migrated_db.execute("SELECT name FROM profiles")
        assert {r[0] for r in await prof_cur.fetchall()} == {"Home Base"}

        # workflow_items / tasks / members / agent_sessions must be zero
        assert await _count(migrated_db, "workflow_items") == 0
        assert await _count(migrated_db, "tasks") == 0
        assert await _count(migrated_db, "members") == 0
        assert await _count(migrated_db, "agent_sessions") == 0

        # projects: exactly Unassigned + Command Center
        cur = await migrated_db.execute(
            "SELECT id, name, is_workspace FROM projects ORDER BY id"
        )
        projects = [(r[0], r[1], r[2]) for r in await cur.fetchall()]
        project_names = {p[1] for p in projects}
        assert "Unassigned" in project_names, (
            f"Unassigned missing from projects: {projects}"
        )
        assert "Command Center" in project_names, f"Command Center missing: {projects}"
        assert len(projects) == 2, f"Expected exactly 2 projects, got: {projects}"

        # Unassigned must have id=1
        unassigned = next(p for p in projects if p[1] == "Unassigned")
        assert unassigned[0] == 1, f"Unassigned must have id=1, got id={unassigned[0]}"

        # Command Center must be is_workspace=1
        command_center = next(p for p in projects if p[1] == "Command Center")
        assert command_center[2] == 1, "Command Center must have is_workspace=1"

        # org_agents: exactly the 3 bundled agents
        cur = await migrated_db.execute("SELECT name FROM org_agents ORDER BY name")
        agent_names = {r[0] for r in await cur.fetchall()}
        assert agent_names == {
            "atlas-recruiter",
            "orion-ops",
            "vega-research",
        }, f"Unexpected org_agents: {agent_names}"

        # onboarding_completed must be absent from workspace_state
        cur = await migrated_db.execute(
            "SELECT value FROM workspace_state WHERE key = 'onboarding_completed'"
        )
        row = await cur.fetchone()
        assert row is None, (
            f"onboarding_completed must be absent after reset, got value={row[0] if row else None!r}"
        )

    finally:
        # Restore settings so other tests are not affected
        app_config.settings.WORKSPACE_ROOT = orig_ws
        app_config.settings.ORG_AGENTS_DIR = orig_org
        app_config.settings.APP_DATA_DIR = orig_app_data
        app_config.settings.BUNDLE_RESOURCES = orig_bundle
