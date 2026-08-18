"""Command Center orchestration: bootstrap, link regeneration, health checks."""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

import aiosqlite

from app.config import settings
from app.services import (
    agent_alias_service,
    org_agent_service,
    symlink_service,
    workspace_context_service,
)
from app.services import workspace_state_service as ws_state
from app.services._sql import slugify as _slugify_base

logger = logging.getLogger(__name__)

# Serialize regenerate calls within a single sidecar process.
_regen_lock = asyncio.Lock()


# ---------- helpers ----------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _ensure_workspace_project(db: aiosqlite.Connection) -> int:
    """Upsert the synthetic Command Center project row (is_workspace=1)."""
    cur = await db.execute("SELECT id FROM projects WHERE is_workspace = 1")
    row = await cur.fetchone()
    now = _now_iso()
    ws_path = str(settings.WORKSPACE_ROOT)
    if row:
        await db.execute(
            "UPDATE projects SET root_path = ?, last_scanned_at = ? WHERE id = ?",
            (ws_path, now, row[0]),
        )
        await db.commit()
        return row[0]
    cur2 = await db.execute(
        """INSERT INTO projects
               (name, description, status, path, root_path, is_workspace, is_active, imported_at)
               VALUES (?, ?, 'active', ?, ?, 1, 1, ?)""",
        (
            "Command Center",
            "Workspace aggregating org + imported project agents.",
            ws_path,
            ws_path,
            now,
        ),
    )
    await db.commit()
    new_id = cur2.lastrowid
    if new_id is None:
        raise RuntimeError("failed to insert Command Center workspace project row")
    return new_id


def _ensure_workspace_dirs() -> None:
    settings.WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    settings.ORG_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    (settings.WORKSPACE_ROOT / ".claude" / "agents").mkdir(parents=True, exist_ok=True)
    (settings.WORKSPACE_ROOT / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
    (settings.WORKSPACE_ROOT / ".claude" / "commands").mkdir(
        parents=True, exist_ok=True
    )


# The three project-scoped asset tables, keyed by the workspace ``.claude/``
# bucket they link into. Interpolated into SQL below, so this mapping is the
# only place a table name may come from — never a caller-supplied string.
_PROJECT_ASSET_TABLES = {
    "agents": "project_agents",
    "skills": "project_skills",
    "commands": "project_commands",
}


async def _fetch_org_agent_rows(
    db: aiosqlite.Connection, *, enabled_only: bool = True
) -> list[dict]:
    """``org_agents`` rows, oldest first.

    Ordered by ``id`` because that order decides who wins a name race in
    :func:`_collect_desired_links` — org agents claim their names before any
    project agent gets a look.
    """
    where = "WHERE enabled = 1" if enabled_only else ""
    cur = await db.execute(f"SELECT * FROM org_agents {where} ORDER BY id")
    return [dict(r) for r in await cur.fetchall()]


async def _fetch_project_asset_rows(
    db: aiosqlite.Connection,
    bucket: str,
    *,
    project_id: int | None = None,
    enabled_only: bool = True,
    order: str = "id",
) -> list[dict]:
    """Rows from one project-asset table with the owning project joined in.

    One query serving every reader of these tables — the link builder, the
    Agents page, and the invocables catalog — so "which rows count" is decided
    once. Always scoped to active, non-workspace projects: an archived project's
    agents are not invocable, and the synthetic workspace project owns none.

    Args:
        bucket: ``"agents"``, ``"skills"`` or ``"commands"``.
        project_id: restrict to one project; ``None`` for every project.
        enabled_only: keep only rows shared into the workspace (``enabled = 1``).
        order: ``"id"`` (insert order — what decides a name race) or ``"name"``
            (alphabetical, for display).

    Returns:
        Row dicts carrying every table column plus ``project_name``.
    """
    table = _PROJECT_ASSET_TABLES[bucket]
    if order not in ("id", "name"):
        raise ValueError(f"unsupported order: {order}")
    clauses = ["p.is_active = 1", "p.is_workspace = 0"]
    params: list[object] = []
    if enabled_only:
        clauses.append("t.enabled = 1")
    if project_id is not None:
        clauses.append("t.project_id = ?")
        params.append(project_id)
    cur = await db.execute(
        f"""SELECT t.*, COALESCE(NULLIF(p.name, ''), 'project') AS project_name
              FROM {table} t
              JOIN projects p ON p.id = t.project_id
             WHERE {" AND ".join(clauses)}
             ORDER BY p.id, t.{order}""",
        params,
    )
    return [dict(r) for r in await cur.fetchall()]


async def _collect_desired_links(
    db: aiosqlite.Connection,
) -> tuple[list[dict], list[dict]]:
    """Return ``(desired_links, agent_name_conflicts)`` from the DB.

    Each desired item: {table, row_id, bucket, filename, alias, materialize,
    canonical_path}. ``alias`` is the name the entry is invocable by;
    ``materialize`` asks the linker for a generated copy rather than a link.
    Org agents claim their names first and are never aliased.

    **Agents are named by their frontmatter, not their filename.** Claude Code
    resolves an agent by the ``name:`` inside the file, so a slug-prefixed
    *filename* does nothing to separate two projects that both ship a
    ``code-reviewer`` — both files still declare that one name, and a symlink
    cannot change that because the link and its target are the same bytes. So a
    contested name is handed out differently: every claimant is aliased to
    ``<project-slug>--<name>`` and the entry is materialized (a copy with its
    frontmatter rewritten — ``agent_alias_service``) instead of linked.

    Nobody keeps the bare form of a contested name, deliberately: if the first
    project to be imported kept it, importing a second would leave prompts
    pointing at whichever project happened to win a race. A name only one project
    claims stays bare and stays a symlink, so the common case keeps edit-through
    and short tokens.

    The one row that still cannot be given a name is a file that declares no
    frontmatter ``name:`` (``frontmatter_name_raw IS NULL``) and whose bare name
    is already taken: there is nothing in it to rewrite, so it is reported as a
    conflict rather than linked under a name it does not answer to. An
    un-aliasable claimant is given the bare name in preference to an aliasable
    one for exactly that reason.

    Skills and commands need none of this: they resolve by path segment
    (``skills/<name>/SKILL.md``, ``commands/<name>.md``), so prefixing their
    workspace entry genuinely does disambiguate them.

    Names are compared exactly. A case-only difference is left as two distinct
    agents deliberately: hiding one that the CLI might well treat as separate is
    worse than reporting one conflict too few.
    """
    desired: list[dict] = []
    seen_filenames: set[str] = set()
    # invocable name -> what claimed it, for conflict reporting.
    claimed_names: dict[str, dict] = {}
    conflicts: list[dict] = []

    # Org agents (always live in .claude/agents/<name>.md)
    for row in await _fetch_org_agent_rows(db):
        row_id, name, install_path = row["id"], row["name"], row["install_path"]
        safe_name = _safe_agent_name(name)
        filename = f"{safe_name}.md"
        seen_filenames.add(filename)
        claimed_names[name] = {"kind": "org_agent", "owner": "shared", "name": name}
        desired.append(
            {
                "table": "org_agents",
                "row_id": row_id,
                "bucket": "agents",
                "filename": filename,
                "alias": name,
                "materialize": False,
                "canonical_path": install_path,
                "count_key": "org_agents_linked",
            }
        )

    # Project agents (enabled AND project is_active)
    #
    # Two passes: count who claims each name, then hand the names out. Counting
    # first is what makes the outcome independent of import order — a contested
    # name is aliased for every claimant, including the one that would have won
    # a first-come race.
    project_agent_rows = await _fetch_project_asset_rows(db, "agents")
    claimant_count: dict[str, int] = {}
    for row in project_agent_rows:
        claimant_count[row["name"]] = claimant_count.get(row["name"], 0) + 1

    for row in project_agent_rows:
        row_id, name = row["id"], row["name"]
        canonical_path, pname = row["canonical_path"], row["project_name"]
        safe_name = _safe_agent_name(name)
        slug = _slugify(pname)
        # Aliasing rewrites the frontmatter `name:` line, so a file that declares
        # none cannot be aliased at all. The scanner records exactly that as
        # `frontmatter_name_raw IS NULL`, so the decision stays a DB read.
        aliasable = row["frontmatter_name_raw"] is not None
        contested = claimant_count[name] > 1 or name in claimed_names

        if contested and aliasable:
            # NB: the alias is *not* run through _safe_agent_name — that collapses
            # runs of dashes, which would eat the `--` seam. Both halves are
            # already sanitised individually.
            alias = agent_alias_service.alias_name(slug, safe_name)
            attempts = [
                (alias, f"{alias}.md"),
                (f"{alias}-{row_id}", f"{alias}-{row_id}.md"),
            ]
        else:
            # Bare name, symlinked, as before — including the filename-only
            # escapes for two distinct names that sanitise to the same file.
            attempts = [
                (name, f"{safe_name}.md"),
                (name, f"{slug}--{safe_name}.md"),
                (name, f"{slug}--{safe_name}-{row_id}.md"),
            ]

        chosen: tuple[str, str] | None = next(
            (
                (invocable, filename)
                for invocable, filename in attempts
                if invocable not in claimed_names and filename not in seen_filenames
            ),
            None,
        )
        if chosen is None:
            # Nothing left to call it: something already answers to this name and
            # the file cannot be rewritten to answer to another.
            owner = claimed_names.get(name, {"kind": "project_agent", "owner": pname})
            conflicts.append(
                {
                    "name": name,
                    "kind": "project_agent",
                    "project": pname,
                    "canonical_path": canonical_path,
                    "shadowed_by_kind": owner["kind"],
                    "shadowed_by": owner["owner"],
                    "row_id": row_id,
                }
            )
            continue

        invocable, filename = chosen
        claimed_names[invocable] = {
            "kind": "project_agent",
            "owner": pname,
            "name": invocable,
        }
        seen_filenames.add(filename)
        desired.append(
            {
                "table": "project_agents",
                "row_id": row_id,
                "bucket": "agents",
                "filename": filename,
                "alias": invocable,
                # An aliased entry has to be generated: a link would carry the
                # project's own `name:` and collide all over again.
                "materialize": invocable != name,
                "canonical_path": canonical_path,
                "count_key": "project_agents_linked",
            }
        )

    # Project skills (enabled AND project is_active)
    #
    # Reserve the built-in projects skill name so a project skill named
    # "projects" is disambiguated (slug-prefixed) and can never symlink over it.
    skill_seen: set[str] = {workspace_context_service.PROJECTS_SKILL_NAME}
    for row in await _fetch_project_asset_rows(db, "skills"):
        row_id, name = row["id"], row["name"]
        canonical_path, pname = row["canonical_path"], row["project_name"]
        safe_name = _safe_agent_name(name)
        slug = _slugify(pname)
        filename = safe_name if safe_name not in skill_seen else f"{slug}--{safe_name}"
        if filename in skill_seen:
            filename = f"{slug}--{safe_name}-{row_id}"
        skill_seen.add(filename)
        desired.append(
            {
                "table": "project_skills",
                "row_id": row_id,
                "bucket": "skills",
                "filename": filename,  # NB: a directory name, not .md
                # A skill resolves by that directory name, so it is also the alias.
                "alias": filename,
                "materialize": False,
                "canonical_path": canonical_path,
                "count_key": "skills_linked",
            }
        )

    # Project commands (enabled AND project is_active)
    cmd_seen: set[str] = set()
    for row in await _fetch_project_asset_rows(db, "commands"):
        row_id, name = row["id"], row["name"]
        canonical_path, pname = row["canonical_path"], row["project_name"]
        safe_name = _safe_agent_name(name)
        slug = _slugify(pname)
        base = f"{safe_name}.md"
        filename = base if base not in cmd_seen else f"{slug}--{safe_name}.md"
        if filename in cmd_seen:
            filename = f"{slug}--{safe_name}-{row_id}.md"
        cmd_seen.add(filename)
        desired.append(
            {
                "table": "project_commands",
                "row_id": row_id,
                "bucket": "commands",
                "filename": filename,
                # A command resolves by its file stem.
                "alias": Path(filename).stem,
                "materialize": False,
                "canonical_path": canonical_path,
                "count_key": "commands_linked",
            }
        )

    return desired, conflicts


def _slugify(s: str) -> str:
    return _slugify_base(s, fallback="project")


def _safe_agent_name(name: str) -> str:
    """Sanitize an agent/skill/command name for use as a filename component.

    Rejects any name that contains path separators or traversal sequences by
    stripping them and replacing with a dash.  An empty result falls back to
    ``'unknown'``.  This prevents a hostile frontmatter ``name:`` field from
    escaping the workspace staging directory via a crafted symlink path.
    """
    # Replace any path separator or traversal character with a dash.
    sanitized = re.sub(r"[/\\.]", "-", name)
    # Collapse multiple dashes and strip leading/trailing dashes.
    sanitized = re.sub(r"-+", "-", sanitized).strip("-")
    return sanitized or "unknown"


# ---------- public API ----------

# Seeded reference-data tables that ``factory_reset`` wipes. These hold the
# functional defaults the app ships with (app settings, taxonomies, workspace
# templates, the Unassigned sentinel project, etc.) — NOT user data — and must
# be restored after a wipe so the DB returns to true first-run state.
#
# Listed in FK-safe insert order (parents before children).
# Intentionally excludes: providers, provider_models, profiles — those must be
# zero after a reset so onboarding starts completely clean.
_REFERENCE_SEED_TABLES = (
    "workspaces",
    "projects",
    "app_settings",
    "taxonomies",
    "integration_catalog",
    "workspace_state",
)


async def reseed_reference_data(db: aiosqlite.Connection) -> int:
    """Restore seeded reference-data rows that ``factory_reset`` deletes.

    The canonical seed lives in ``migrations/000_baseline_schema.sql``; we replay
    its ``INSERT`` statements for :data:`_REFERENCE_SEED_TABLES` so the re-seed
    never drifts from the migration source of truth. Intended to run on an
    already-wiped DB (the explicit primary keys in the seed would collide
    otherwise). Returns the number of statements applied.
    """
    migration = (
        Path(__file__).resolve().parents[2] / "migrations" / "000_baseline_schema.sql"
    )
    try:
        text = migration.read_text()
    except OSError as exc:
        logger.warning(
            "reference-data reseed skipped — cannot read %s: %s", migration, exc
        )
        return 0

    # Bucket matching INSERT lines per table (each seed INSERT is a single line
    # terminated with ';'). The baseline uses both ``INSERT INTO`` and
    # ``INSERT OR IGNORE INTO``, quoted or unquoted — match all forms, but only
    # keep exact reference-table names (so e.g. ``projects_fts`` is ignored).
    insert_re = re.compile(
        r'^INSERT(?:\s+OR\s+(?:IGNORE|REPLACE))?\s+INTO\s+"?(\w+)"?',
        re.IGNORECASE,
    )
    buckets: dict[str, list[str]] = {t: [] for t in _REFERENCE_SEED_TABLES}
    for line in text.splitlines():
        stripped = line.strip()
        m = insert_re.match(stripped)
        if m and m.group(1) in buckets:
            buckets[m.group(1)].append(stripped)

    statements = [stmt for table in _REFERENCE_SEED_TABLES for stmt in buckets[table]]
    if not statements:
        logger.warning("reference-data reseed: no seed rows found in %s", migration)
        return 0

    await db.executescript("\n".join(statements))
    await db.commit()
    logger.info("reseeded %d reference-data rows after wipe", len(statements))
    return len(statements)


_DEFAULT_PROFILE_NAME = "Home Base"
_DEFAULT_PROFILE_COLOR = "#6366f1"
_DEFAULT_PROFILE_ICON = "home"


async def _ensure_default_profile(db: aiosqlite.Connection) -> int:
    """Ensure the 'Home Base' default grouping profile exists.

    Idempotent: if a profile named 'Home Base' already exists, returns its id.
    Also stores the id in app_settings under 'default_profile_id' so other
    services can look up the default without re-querying the profiles table.

    Session attribution is NOT affected: _derive_profile matches
    transcript_path to profiles.claude_config_dir; 'Home Base' only has
    claude_config_dir set if a provider binds itself to it (see
    _reconcile_provider_profiles). Even if Home Base remains a pure grouping
    profile with no claude_config_dir, _derive_profile will simply skip it
    and match against provider-bound profiles as before.
    """
    cur = await db.execute(
        "SELECT id FROM profiles WHERE name = ?", (_DEFAULT_PROFILE_NAME,)
    )
    row = await cur.fetchone()
    if row:
        profile_id: int = int(row[0])
    else:
        ins = await db.execute(
            """INSERT INTO profiles (name, color, icon, env_json)
               VALUES (?, ?, ?, '{}')""",
            (_DEFAULT_PROFILE_NAME, _DEFAULT_PROFILE_COLOR, _DEFAULT_PROFILE_ICON),
        )
        await db.commit()
        profile_id = int(ins.lastrowid)  # type: ignore[arg-type]
        logger.info(
            "created default profile '%s' (id=%d)", _DEFAULT_PROFILE_NAME, profile_id
        )
        from app.services import agent_service

        agent_service.invalidate_profile_cache()

    # Persist (or refresh) the id in app_settings so callers can resolve it
    # cheaply without querying profiles.
    await db.execute(
        """INSERT INTO app_settings (key, value_json, updated_at)
           VALUES ('default_profile_id', ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                          updated_at = CURRENT_TIMESTAMP""",
        (str(profile_id),),
    )
    await db.commit()
    return profile_id


async def _reconcile_provider_profiles(db: aiosqlite.Connection) -> int:
    """Self-heal: create a profile row for any enabled Anthropic provider that has none.

    For each enabled provider whose ``default_env_json`` contains a
    ``CLAUDE_CONFIG_DIR`` and that has no matching profile row (matched by
    ``provider_id`` or by ``name``), we insert a profile row so that:
    - ``agent_service._derive_profile`` can match new hook sessions by their
      ``transcript_path`` substring.
    - ``provider_service.resolve_profile_to_provider`` returns the right
      ``provider_id`` at session-start time instead of NULL.

    Also backfills ``agent_sessions.provider_id`` for active/idle rows whose
    ``provider_id`` is NULL but whose ``transcript_path`` now matches a known
    profile's ``claude_config_dir``.  Best-effort — never raises on failure.

    Returns the count of newly-created profile rows.
    """
    import json as _json

    created = 0
    try:
        # Fetch all enabled providers with a non-empty default_env_json.
        cur = await db.execute(
            "SELECT id, name, default_env_json, default_model FROM providers WHERE is_enabled = 1"
        )
        providers = await cur.fetchall()

        for prov in providers:
            raw_env = prov["default_env_json"] or "{}"
            try:
                env_map = _json.loads(raw_env)
            except Exception:  # noqa: BLE001
                env_map = {}
            config_dir: str | None = env_map.get("CLAUDE_CONFIG_DIR")

            # Only handle providers that carry a CLAUDE_CONFIG_DIR (i.e. Anthropic aliases).
            if not config_dir:
                continue

            provider_id = prov["id"]
            provider_name = prov["name"]

            # Check whether a profile already exists for this provider.
            chk = await db.execute(
                "SELECT id FROM profiles WHERE provider_id = ? OR name = ? LIMIT 1",
                (provider_id, provider_name),
            )
            existing = await chk.fetchone()
            if existing:
                # Ensure provider_id is set on the row even for pre-fix installs.
                await db.execute(
                    "UPDATE profiles SET provider_id = ? WHERE (provider_id IS NULL OR provider_id = ?) AND name = ?",
                    (provider_id, provider_id, provider_name),
                )
                continue

            # Resolve the default model name for this provider (the default-flagged row).
            default_model: str | None = None
            mdl_cur = await db.execute(
                "SELECT model_name FROM provider_models WHERE provider_id = ? AND is_default = 1 LIMIT 1",
                (provider_id,),
            )
            mdl_row = await mdl_cur.fetchone()
            if mdl_row:
                default_model = mdl_row["model_name"]

            await db.execute(
                """INSERT INTO profiles
                   (name, color, icon, claude_config_dir, provider_id, default_model, env_json)
                   VALUES (?, ?, ?, ?, ?, ?, '{}')""",
                (
                    provider_name,
                    "#a855f7",
                    "user",
                    config_dir,
                    provider_id,
                    default_model,
                ),
            )
            created += 1

        if created:
            await db.commit()
            # Invalidate the derive-profile cache so new profiles take effect immediately.
            from app.services import agent_service

            agent_service.invalidate_profile_cache()
            logger.info("provider-profile reconcile: created %d profile(s)", created)

        # Backfill provider_id on active/idle agent_sessions whose transcript_path
        # matches a profile's claude_config_dir but provider_id is still NULL.
        await _backfill_session_provider_ids(db)

    except Exception as exc:  # noqa: BLE001
        logger.warning("provider-profile reconcile error (continuing): %s", exc)

    return created


async def _backfill_session_provider_ids(db: aiosqlite.Connection) -> None:
    """Best-effort backfill: stamp provider_id on sessions that have a matching profile.

    Only touches rows where provider_id IS NULL and status IN ('active','idle').
    """
    try:
        cur = await db.execute(
            """SELECT p.provider_id, p.claude_config_dir
               FROM profiles p
               WHERE p.provider_id IS NOT NULL AND p.claude_config_dir IS NOT NULL
                 AND p.claude_config_dir != ''"""
        )
        profiles = await cur.fetchall()
        for prof in profiles:
            config_dir: str = prof["claude_config_dir"]
            provider_id: int = prof["provider_id"]
            await db.execute(
                """UPDATE agent_sessions
                   SET provider_id = ?
                   WHERE provider_id IS NULL
                     AND status IN ('active', 'idle')
                     AND transcript_path LIKE ?""",
                (provider_id, f"%{config_dir}%"),
            )
        await db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("session provider_id backfill error (continuing): %s", exc)


async def bootstrap(db: aiosqlite.Connection, *, force: bool = False) -> dict:
    """Idempotent first-run + every-run bootstrap.

    1. Ensure workspace and org-agents directories exist.
    2. Record paths in workspace_state.
    3. Upsert the synthetic Command Center project row.
    4. Install / upgrade bundled org agents from BUNDLE_RESOURCES.
    5. Regenerate workspace links from DB.
    6. Reconcile provider-profile rows for self-healing installs.
    """
    start = time.monotonic()
    _ensure_workspace_dirs()

    await ws_state.set(db, "app_data_dir", str(settings.APP_DATA_DIR))
    await ws_state.set(db, "workspace_root", str(settings.WORKSPACE_ROOT))

    await _ensure_workspace_project(db)

    installed = 0
    upgraded = 0
    try:
        await org_agent_service.reconcile_stale(
            db,
            bundle_dir=settings.BUNDLE_RESOURCES,
            target_dir=settings.ORG_AGENTS_DIR,
        )
        installed, upgraded = await org_agent_service.install_or_upgrade(
            db,
            bundle_dir=settings.BUNDLE_RESOURCES,
            target_dir=settings.ORG_AGENTS_DIR,
            force=force,
        )
        # Record installed manifest version for upgrade detection.
        version, _ = org_agent_service.load_manifest(settings.BUNDLE_RESOURCES)
        await ws_state.set(db, "org_agents_version", version)
    except FileNotFoundError as exc:
        logger.warning("org-agent manifest not found: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("org-agent install/upgrade failed: %s", exc)

    regen = await regenerate_workspace_links(db)

    default_profile_id = await _ensure_default_profile(db)
    profiles_created = await _reconcile_provider_profiles(db)

    await ws_state.set(db, "last_bootstrap_at", _now_iso())

    return {
        "app_data_dir": str(settings.APP_DATA_DIR),
        "workspace_root": str(settings.WORKSPACE_ROOT),
        "org_agents_installed": installed,
        "org_agents_upgraded": upgraded,
        "links_regenerated": regen["total"],
        "links_failed": regen["failed"],
        "agent_name_conflicts": regen["conflicts"],
        "default_profile_id": default_profile_id,
        "profiles_reconciled": profiles_created,
        "duration_ms": int((time.monotonic() - start) * 1000),
    }


async def regenerate_workspace_links(db: aiosqlite.Connection) -> dict:
    """Wipe-and-rebuild workspace .claude/ via staging dir + atomic rename.

    Concurrency: serialized by `_regen_lock`.
    Atomicity: writes into <workspace>/.claude.next/, then renames over .claude/.
    Crash safety: leftover .claude.next/ from a previous crash is wiped at start.
    """
    async with _regen_lock:
        _ensure_workspace_dirs()
        claude = settings.WORKSPACE_ROOT / ".claude"
        staging = settings.WORKSPACE_ROOT / ".claude.next"
        prev = settings.WORKSPACE_ROOT / ".claude.prev"

        if staging.exists():
            shutil.rmtree(staging)
        (staging / "agents").mkdir(parents=True)
        (staging / "skills").mkdir(parents=True)
        (staging / "commands").mkdir(parents=True)

        # Stage the built-in projects skill so it survives the atomic swap
        # (its name is reserved in _collect_desired_links to avoid collisions).
        workspace_context_service.write_projects_skill(staging / "skills")

        desired, conflicts = await _collect_desired_links(db)
        counts = {
            "org_agents_linked": 0,
            "project_agents_linked": 0,
            "skills_linked": 0,
            "commands_linked": 0,
        }
        failed: list[dict] = []

        for item in desired:
            src = Path(item["canonical_path"])
            dst = staging / item["bucket"] / item["filename"]
            try:
                if item["materialize"]:
                    # An aliased agent is generated rather than linked: the copy
                    # declares `name: <alias>`, which is the only way the CLI can
                    # tell it apart from the namesake it shares a project-relative
                    # path with.
                    lt = agent_alias_service.materialize(src, dst, alias=item["alias"])
                else:
                    lt = symlink_service.create_link(src, dst)
                counts[item["count_key"]] += 1
                final_link_path = str(claude / item["bucket"] / item["filename"])
                await db.execute(
                    f"UPDATE {item['table']} SET link_type = ?, link_path = ?, "
                    f"verify_status = 'ok', last_verified_at = ? WHERE id = ?",
                    (lt.value, final_link_path, _now_iso(), item["row_id"]),
                )
            except FileNotFoundError:
                await db.execute(
                    f"UPDATE {item['table']} SET verify_status = 'missing_target', "
                    f"last_verified_at = ? WHERE id = ?",
                    (_now_iso(), item["row_id"]),
                )
                failed.append({"link": str(dst), "reason": "missing_target"})
            except agent_alias_service.AliasRewriteError as exc:
                # The file no longer declares the name the last scan recorded, so
                # there is nothing to rewrite. `mismatch` is the row state for
                # precisely that, and only project_agents is ever materialized —
                # the other two tables' CHECK does not allow the value.
                await db.execute(
                    f"UPDATE {item['table']} SET verify_status = 'mismatch', "
                    f"last_verified_at = ? WHERE id = ?",
                    (_now_iso(), item["row_id"]),
                )
                failed.append({"link": str(dst), "reason": f"alias rewrite: {exc}"})
            except OSError as exc:
                failed.append({"link": str(dst), "reason": str(exc)})

        await db.commit()

        # Atomic swap: claude → prev (delete old prev), staging → claude, delete prev.
        if prev.exists():
            shutil.rmtree(prev)
        if claude.exists():
            claude.rename(prev)
        staging.rename(claude)
        if prev.exists():
            shutil.rmtree(prev)

        # Refresh the managed CLAUDE.md project block from the same DB state.
        # Best-effort: a failure here must not fail link regeneration. (The
        # projects skill was already staged into the swap above.)
        try:
            await workspace_context_service.regenerate(db)
        except Exception as exc:  # noqa: BLE001
            logger.warning("workspace context regen failed (continuing): %s", exc)

        total = sum(counts.values())
        return {
            "total": total,
            "counts": counts,
            "failed": failed,
            "conflicts": conflicts,
        }


async def list_configured_agents(db: aiosqlite.Connection) -> dict:
    """Return configured agents and skills grouped for the Agents page.

    Shape::

        {
          "shared": [
              {"id": int, "name": str, "display_name": str|None,
               "description": str|None, "model": str|None,
               "verify_status": str|None, "kind": "org"|"project",
               "is_shared": bool}
              ...
          ],
          "shared_skills": [
              {"id": int, "name": str, "verify_status": str|None,
               "canonical_path": str, "is_shared": bool}
              ...
          ],
          "by_project": [
              {"project_id": int, "project_name": str,
               "agents": [ ... same agent shape ... ],
               "skills": [ ... same skill shape ... ]}
              ...
          ]
        }

    Shared = all org_agents (enabled=1) + project_agents where enabled=1.
    Shared skills = project_skills where enabled=1.
    By-project = ALL project_agents/skills for each active project (regardless of
    enabled), one entry per project.  Items with enabled=1 appear in BOTH the
    shared section and the project section (is_shared=True marks them as shared).
    """
    # Same rows, same predicate, as the link builder — one query per table,
    # shared with _collect_desired_links, so this page can never disagree with
    # what the workspace actually links. `enabled_only=False` because the page
    # lists a project's unshared agents too, ordered by name for display.
    org_rows = await _fetch_org_agent_rows(db)
    project_rows = await _fetch_project_asset_rows(
        db, "agents", enabled_only=False, order="name"
    )
    skill_rows = await _fetch_project_asset_rows(
        db, "skills", enabled_only=False, order="name"
    )

    def _agent_dict(row: dict, kind: str, *, is_shared: bool) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            # org_agents only — a project agent has no display_name column.
            "display_name": row.get("display_name"),
            "description": row["description"],
            "model": row["model"],
            "verify_status": row["verify_status"],
            "kind": kind,
            "is_shared": is_shared,
        }

    def _skill_dict(row: dict, *, is_shared: bool) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "canonical_path": row["canonical_path"],
            "verify_status": row["verify_status"],
            "is_shared": is_shared,
        }

    # Org agents are always shared (and only appear in the shared section).
    shared: list[dict] = [_agent_dict(r, "org", is_shared=True) for r in org_rows]
    shared_skills: list[dict] = []

    by_project_map: dict[int, dict] = {}

    def _ensure_project(pid: int, pname: str) -> None:
        if pid not in by_project_map:
            by_project_map[pid] = {
                "project_id": pid,
                "project_name": pname,
                "agents": [],
                "skills": [],
            }

    for row in project_rows:
        enabled = int(row["enabled"])
        is_shared = enabled == 1
        pid = int(row["project_id"])
        pname = str(row["project_name"])
        # Shared agents go in the shared section.
        if is_shared:
            shared.append(_agent_dict(row, "project", is_shared=True))
        # ALL project agents appear in the per-project section (enabled or not).
        _ensure_project(pid, pname)
        by_project_map[pid]["agents"].append(
            _agent_dict(row, "project", is_shared=is_shared)
        )

    for row in skill_rows:
        enabled = int(row["enabled"])
        is_shared = enabled == 1
        pid = int(row["project_id"])
        pname = str(row["project_name"])
        # Shared skills go in the shared_skills section.
        if is_shared:
            shared_skills.append(_skill_dict(row, is_shared=True))
        # ALL project skills appear in the per-project section (enabled or not).
        _ensure_project(pid, pname)
        by_project_map[pid]["skills"].append(_skill_dict(row, is_shared=is_shared))

    by_project = list(by_project_map.values())

    return {"shared": shared, "shared_skills": shared_skills, "by_project": by_project}


# ---------------------------------------------------------------------------
# Invocables catalog
#
# One answer to "what can a session started in *this* directory invoke, and with
# exactly what token". Claude Code resolves the three kinds differently, and the
# tokens below encode that asymmetry once so no caller has to rediscover it:
#
#   agents   — by frontmatter ``name:``, wherever the file sits, so the token is
#              ``@agent-<name>`` and the filename the workspace links it under is
#              irrelevant. (Which is also why two projects shipping a
#              ``code-reviewer`` cannot both be linked — see
#              :func:`_collect_desired_links`.)
#   skills   — by the directory segment holding ``SKILL.md``, so a slug-prefixed
#              workspace entry genuinely is a distinct skill: ``/<dirname>``.
#   commands — by the file stem, likewise: ``/<stem>``.
#
# All three carry a ``description`` read from the file's frontmatter at scan time
# (migration 007), and a command carries its ``argument-hint`` too — a picker row
# that can only say a name is barely worth offering.
#
# Scope comes first, because a token no session could resolve is worse than no
# row at all: a pane rooted in the workspace resolves the workspace ``.claude/``,
# a pane rooted in an imported project resolves that project's own ``.claude/``,
# and a pane anywhere else resolves nothing Codenest manages. User-level assets
# (``$CLAUDE_CONFIG_DIR/agents`` and friends, which every session also sees) are
# outside the DB and deliberately not reported here.
# ---------------------------------------------------------------------------


def _agent_token(name: str) -> str:
    """``@agent-<frontmatter name>`` — what the CLI matches an agent mention on."""
    return f"@agent-{name}"


def _slash_token(name: str) -> str:
    """``/<path segment>`` — what the CLI matches a skill or command on."""
    return f"/{name}"


def _display_alias(declared_name: str, project_name: str | None) -> str:
    """Picker label: ``project:name``, or the bare name for an app-owned agent.

    Cosmetic only — ``invoke_token`` is what gets sent. Deliberately built from
    the name the file *declares* rather than the possibly slug-prefixed workspace
    entry, so the row reads the way the author of the project would recognise it.
    """
    return f"{project_name}:{declared_name}" if project_name else declared_name


def _resolved(raw: str) -> Path:
    """``raw`` expanded and symlink-resolved, for comparing two roots.

    Non-strict: a cwd that no longer exists still resolves to a comparable path
    rather than raising, and simply matches no root.
    """
    return Path(raw).expanduser().resolve()


async def _resolve_invocable_scope(db: aiosqlite.Connection, cwd: str | None) -> dict:
    """Which ``.claude/`` tree a session in *cwd* reads.

    Returns ``{"scope", "cwd", "project_id", "project_name"}`` where scope is
    ``"workspace"``, ``"project"`` or ``"unknown"``.

    An absent *cwd* means the workspace: that is where a new agent pane starts
    (``resolveWorkspaceCwd``, ``frontend/src/stores/terminal-store.ts``), so
    treating "unspecified" as "nowhere" would empty the picker on the app's own
    default. The deepest matching project root wins, so a project checked out
    inside another project resolves to itself.
    """
    unscoped: dict = {
        "scope": "unknown",
        "cwd": None,
        "project_id": None,
        "project_name": None,
    }

    if cwd is None or not cwd.strip():
        return {**unscoped, "scope": "workspace"}

    here = _resolved(cwd)
    workspace_root = _resolved(str(settings.WORKSPACE_ROOT))
    if here == workspace_root or here.is_relative_to(workspace_root):
        return {**unscoped, "scope": "workspace", "cwd": str(here)}

    cur = await db.execute(
        """SELECT id, COALESCE(NULLIF(name, ''), 'project') AS name,
                  COALESCE(NULLIF(root_path, ''), path) AS root
             FROM projects
            WHERE is_active = 1 AND is_workspace = 0"""
    )
    best: tuple[int, str, int] | None = None  # (id, name, depth)
    for row in await cur.fetchall():
        root = row["root"]
        if not root:
            continue
        project_root = _resolved(str(root))
        if here != project_root and not here.is_relative_to(project_root):
            continue
        depth = len(project_root.parts)
        if best is None or depth > best[2]:
            best = (int(row["id"]), str(row["name"]), depth)

    if best is None:
        return {**unscoped, "cwd": str(here)}
    return {
        "scope": "project",
        "cwd": str(here),
        "project_id": best[0],
        "project_name": best[1],
    }


def _builtin_projects_skill(claude_dir: Path) -> dict:
    """The workspace's own ``projects`` skill, which has no DB row.

    ``regenerate_workspace_links`` writes it into every workspace ``.claude/``
    (``workspace_context_service.write_projects_skill``) and reserves its name,
    so a workspace session really can invoke ``/projects``. Omitting it would
    make the catalog incomplete in exactly the way that hides a working skill.
    """
    skill_dir = claude_dir / "skills" / workspace_context_service.PROJECTS_SKILL_NAME
    name = workspace_context_service.PROJECTS_SKILL_NAME
    return {
        "kind": "builtin",
        "name": name,
        "alias": name,
        "invoke_token": _slash_token(name),
        "description": workspace_context_service.PROJECTS_SKILL_DESCRIPTION,
        "project_id": None,
        "project_name": None,
        "canonical_path": str(skill_dir),
        "link_path": str(skill_dir),
        # The only row with no DB-backed verify state, so it is stat-ed: claiming
        # "ok" for a file a wiped workspace no longer has would be a lie.
        "verify_status": "ok" if skill_dir.is_dir() else "missing_target",
        "shared": True,
    }


async def _workspace_invocables(db: aiosqlite.Connection) -> dict:
    """Everything linked into the workspace ``.claude/``, keyed by kind.

    Built from :func:`_collect_desired_links` rather than from the tables
    directly: that collector *is* the definition of what the workspace links, so
    a row here cannot claim an agent the linker dropped. Shadowed agents are
    reported separately, never as invocable.
    """
    desired, conflicts = await _collect_desired_links(db)
    claude_dir = settings.WORKSPACE_ROOT / ".claude"

    org_rows = {row["id"]: row for row in await _fetch_org_agent_rows(db)}
    project_rows = {
        bucket: {row["id"]: row for row in await _fetch_project_asset_rows(db, bucket)}
        for bucket in _PROJECT_ASSET_TABLES
    }

    agents: list[dict] = []
    skills: list[dict] = [_builtin_projects_skill(claude_dir)]
    commands: list[dict] = []

    for item in desired:
        bucket = item["bucket"]
        link_path = str(claude_dir / bucket / item["filename"])
        # The link path is derived the way the linker derives it, not read from
        # the row: `link_path` holds a placeholder until a regeneration has run,
        # and a picker must not wait for one to answer correctly.

        if item["table"] == "org_agents":
            row = org_rows.get(item["row_id"])
            if row is None:
                continue
            name = str(item["alias"])  # org agents are never aliased
            agents.append(
                {
                    "kind": "org",
                    "name": name,
                    "alias": _display_alias(name, None),
                    "invoke_token": _agent_token(name),
                    "display_name": row["display_name"],
                    "description": row["description"],
                    "model": row["model"],
                    "project_id": None,
                    "project_name": None,
                    "canonical_path": item["canonical_path"],
                    "link_path": link_path,
                    "verify_status": row["verify_status"],
                    "shared": True,
                    "materialized": False,
                }
            )
            continue

        row = project_rows[bucket].get(item["row_id"])
        if row is None:
            continue
        declared = str(row["name"])
        project_name = str(row["project_name"])
        common = {
            "kind": "project",
            "alias": _display_alias(declared, project_name),
            "project_id": int(row["project_id"]),
            "project_name": project_name,
            "canonical_path": item["canonical_path"],
            "link_path": link_path,
            "verify_status": row["verify_status"],
            "shared": True,
        }

        # Whatever the collector allocated is what the CLI will resolve: the
        # frontmatter name for an agent (rewritten to `<slug>--<name>` when the
        # entry is a materialized alias), the directory segment for a skill, the
        # file stem for a command.
        linked = str(item["alias"])
        if bucket == "agents":
            agents.append(
                {
                    **common,
                    "name": linked,
                    "invoke_token": _agent_token(linked),
                    "display_name": None,
                    "description": row["description"],
                    "model": row["model"],
                    # True when the workspace entry is a generated copy rather
                    # than a link — edits to it do not reach the project.
                    "materialized": bool(item["materialize"]),
                }
            )
        elif bucket == "skills":
            skills.append(
                {
                    **common,
                    "name": linked,
                    "invoke_token": _slash_token(linked),
                    "description": row["description"],
                }
            )
        else:
            commands.append(
                {
                    **common,
                    "name": linked,
                    "invoke_token": _slash_token(linked),
                    "description": row["description"],
                    # Commands only: the CLI's own `argument-hint` frontmatter
                    # key, so a `/` menu row can say what follows the name.
                    "argument_hint": row["argument_hint"],
                }
            )

    return {
        "agents": agents,
        "skills": skills,
        "commands": commands,
        "shadowed": conflicts,
    }


async def _project_invocables(
    db: aiosqlite.Connection, project_id: int, project_name: str
) -> dict:
    """Everything a session rooted in one project resolves from its own ``.claude/``.

    Not filtered by ``enabled``: that column controls whether an asset is *shared
    into the workspace*, and a session already sitting in the project reads the
    project's own files either way. For the same reason nothing here is shadowed
    — a name collision only exists in the shared workspace, so an agent dropped
    from it is still perfectly invocable at home.
    """
    agents: list[dict] = []
    skills: list[dict] = []
    commands: list[dict] = []

    for bucket, sink in (
        ("agents", agents),
        ("skills", skills),
        ("commands", commands),
    ):
        rows = await _fetch_project_asset_rows(
            db, bucket, project_id=project_id, enabled_only=False, order="name"
        )
        for row in rows:
            declared = str(row["name"])
            canonical = Path(str(row["canonical_path"]))
            shared = int(row["enabled"]) == 1
            if bucket == "agents":
                name = declared
            elif bucket == "skills":
                name = canonical.name
            else:
                name = canonical.stem
            entry = {
                "kind": "project",
                "name": name,
                "alias": _display_alias(declared, project_name),
                "invoke_token": (
                    _agent_token(name) if bucket == "agents" else _slash_token(name)
                ),
                "description": row["description"],
                "project_id": project_id,
                "project_name": project_name,
                "canonical_path": str(canonical),
                # Only a shared asset has a workspace link; reporting the column
                # for an unshared one would name a path that is not there.
                "link_path": str(row["link_path"]) if shared else None,
                "verify_status": row["verify_status"],
                "shared": shared,
            }
            if bucket == "agents":
                entry["display_name"] = None
                entry["model"] = row["model"]
                # A project reads its own file directly; nothing is generated.
                entry["materialized"] = False
            elif bucket == "commands":
                entry["argument_hint"] = row["argument_hint"]
            sink.append(entry)

    return {"agents": agents, "skills": skills, "commands": commands, "shadowed": []}


async def list_invocables(db: aiosqlite.Connection, *, cwd: str | None = None) -> dict:
    """Agents, skills and commands a session in *cwd* can invoke.

    Shape::

        {
          "scope": "workspace" | "project" | "unknown",
          "cwd": str|None,
          "project_id": int|None,
          "project_name": str|None,
          "agents":   [{kind, name, alias, invoke_token, display_name, description,
                        model, project_id, project_name, canonical_path, link_path,
                        verify_status, shared}, ...],
          "skills":   [{kind, name, alias, invoke_token, description, project_id,
                        project_name, canonical_path, link_path, verify_status,
                        shared}, ...],
          "commands": [ ... same shape as skills, plus argument_hint ... ],
          "shadowed": [{name, kind, project, canonical_path, shadowed_by,
                        shadowed_by_kind, row_id}, ...]
        }

    ``invoke_token`` is the whole point: it is the literal text a composer
    inserts, computed here from what the CLI actually resolves, so no caller has
    to reconstruct it from a display name.

    ``shadowed`` carries the agents left out of the workspace because another
    agent already answers to their name (workspace scope only). They are absent
    from ``agents`` by construction — a row in that list is always invocable.
    """
    scope = await _resolve_invocable_scope(db, cwd)
    if scope["scope"] == "workspace":
        found = await _workspace_invocables(db)
    elif scope["scope"] == "project":
        found = await _project_invocables(
            db, int(scope["project_id"]), str(scope["project_name"])
        )
    else:
        found = {"agents": [], "skills": [], "commands": [], "shadowed": []}
    return {**scope, **found}


async def promote_agent_to_org(
    db: aiosqlite.Connection, project_id: int, agent_id: int
) -> dict:
    """Promote a project_agent into the org shared set.

    Copies the agent's canonical file into ORG_AGENTS_DIR via symlink_service,
    inserts an org_agents row with source='promoted', then regenerates workspace
    links so the promoted agent is immediately available in all sessions.

    Idempotent: if the same agent has already been promoted (same name in
    org_agents with source='promoted') the call returns the existing row without
    duplicating.

    Skills: the org layer is agents-only.  Skills are project-scoped; enabling
    them at the project level (enabled=1) is the equivalent for workspace-wide
    availability.  Promote is therefore scoped to agents only.

    Returns the new (or existing) org_agents row dict plus a regen summary.

    Raises:
        ValueError: project_id/agent_id not found, or name collides with a
                    different (bundled) org agent.
    """
    # -- 1. Load the source project_agent row --------------------------------
    cur = await db.execute(
        """SELECT pa.name, pa.description, pa.model, pa.canonical_path
             FROM project_agents pa
             JOIN projects p ON p.id = pa.project_id
            WHERE pa.id = ? AND pa.project_id = ? AND p.is_workspace = 0""",
        (agent_id, project_id),
    )
    row = await cur.fetchone()
    if not row:
        raise ValueError(f"project_agent {agent_id} not found in project {project_id}")
    agent_name: str = row[0]
    agent_description: str | None = row[1]
    agent_model: str | None = row[2]
    canonical_path: str = row[3]

    # -- 2. Check for existing org_agents row by name ------------------------
    existing_cur = await db.execute(
        "SELECT id, source FROM org_agents WHERE name = ?", (agent_name,)
    )
    existing = await existing_cur.fetchone()
    if existing:
        existing_source = existing[1] if len(existing) > 1 else "bundled"
        if existing_source == "bundled":
            raise ValueError(
                f"an org agent named '{agent_name}' already exists as a bundled "
                "agent; cannot promote over a bundled agent"
            )
        # Already promoted — idempotent return
        detail_cur = await db.execute(
            "SELECT id, name, display_name, description, model, install_path, "
            "link_path, source, enabled, verify_status FROM org_agents WHERE id = ?",
            (existing[0],),
        )
        detail_row = await detail_cur.fetchone()
        detail: dict = dict(detail_row) if detail_row else {}
        # Keep the workspace de-duplicated: ensure the source project_agent stays
        # disabled (a rescan may have re-enabled it) so only the org copy links.
        await db.execute(
            "UPDATE project_agents SET enabled = 0 WHERE id = ?", (agent_id,)
        )
        await db.commit()
        regen = await regenerate_workspace_links(db)
        return {"org_agent": detail, "already_existed": True, "regen": regen}

    # -- 3. Copy/symlink the file into ORG_AGENTS_DIR ------------------------
    src = Path(canonical_path)
    if not src.exists():
        raise ValueError(
            f"canonical file for agent '{agent_name}' not found: {canonical_path}"
        )
    install_path = settings.ORG_AGENTS_DIR / src.name
    # Use create_link so we get the same cross-platform handling as the rest of
    # the symlink layer.  Destination is in ORG_AGENTS_DIR (not the workspace
    # .claude/agents/ dir — regenerate_workspace_links handles the workspace
    # link on the next pass).
    link_type = symlink_service.create_link(src, install_path)

    # -- 4. Insert org_agents row --------------------------------------------
    now_iso = _now_iso()
    workspace_link_path = str(settings.WORKSPACE_ROOT / ".claude" / "agents" / src.name)
    ins_cur = await db.execute(
        """INSERT INTO org_agents
               (name, display_name, description, model, version,
                bundle_path, install_path, link_path, link_type,
                source, enabled, verify_status, sha256, installed_at)
           VALUES (?, ?, ?, ?, 'promoted',
                   '', ?, ?, ?,
                   'promoted', 1, 'ok', NULL, ?)""",
        (
            agent_name,
            agent_name,
            agent_description,
            agent_model,
            str(install_path),
            workspace_link_path,
            link_type.value,
            now_iso,
        ),
    )
    new_id = ins_cur.lastrowid
    # Disable the source project_agent so the promoted agent links into the
    # workspace once (as the shared org agent) instead of twice.
    await db.execute("UPDATE project_agents SET enabled = 0 WHERE id = ?", (agent_id,))
    await db.commit()

    # -- 5. Regenerate workspace links so the new org agent gets its symlink --
    regen = await regenerate_workspace_links(db)

    detail_cur = await db.execute(
        "SELECT id, name, display_name, description, model, install_path, "
        "link_path, source, enabled, verify_status FROM org_agents WHERE id = ?",
        (new_id,),
    )
    detail_row = await detail_cur.fetchone()
    detail = dict(detail_row) if detail_row else {}
    return {"org_agent": detail, "already_existed": False, "regen": regen}


async def list_agent_name_conflicts(db: aiosqlite.Connection) -> list[dict]:
    """Project agents left out of the workspace because their name is taken.

    Recomputed from the same collector the linker uses, rather than persisted, so
    what is reported here is exactly what was acted on — there is no second
    implementation to drift, and the answer follows an enable/disable or a rename
    without needing a regeneration first.
    """
    _desired, conflicts = await _collect_desired_links(db)
    return conflicts


async def get_workspace_health(db: aiosqlite.Connection) -> list[dict]:
    """List entries where verify_status != 'ok', for the dashboard health view."""
    rows: list[dict] = []
    # Org agents
    cur = await db.execute(
        "SELECT name, link_path, install_path, verify_status FROM org_agents "
        "WHERE verify_status != 'ok'"
    )
    for r in await cur.fetchall():
        rows.append(
            {
                "kind": "org_agent",
                "name": r[0],
                "link_path": r[1],
                "canonical_path": r[2],
                "verify_status": r[3],
                "detail": None,
            }
        )
    # Project agents
    cur = await db.execute(
        "SELECT pa.name, pa.link_path, pa.canonical_path, pa.verify_status, p.name "
        "FROM project_agents pa JOIN projects p ON p.id = pa.project_id "
        "WHERE pa.verify_status != 'ok'"
    )
    for r in await cur.fetchall():
        rows.append(
            {
                "kind": "project_agent",
                "name": r[0],
                "link_path": r[1],
                "canonical_path": r[2],
                "verify_status": r[3],
                "detail": f"project: {r[4]}",
            }
        )
    return rows
