"""Provider service.

Read access to the `providers` registry, the `provider_models` lookup, and
aggregate statistics joined with `agent_sessions`. Providers are seeded by
migration 018; admin mutators below let the Settings UI add or toggle rows
without code changes.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any, Literal

import aiosqlite
from fastapi import HTTPException

from app.models.launch import (
    Provider,
    ProviderCreate,
    ProviderModel,
    ProviderStats,
    ProviderUpdate,
)

logger = logging.getLogger(__name__)


def _row_to_provider(row: aiosqlite.Row) -> Provider:
    keys = row.keys()
    default_env: dict[str, str] = {}
    if "default_env_json" in keys:
        try:
            parsed = json.loads(row["default_env_json"] or "{}")
            if isinstance(parsed, dict):
                default_env = {str(k): str(v) for k, v in parsed.items()}
        except (json.JSONDecodeError, TypeError):
            default_env = {}

    # Decode models_json — fall back defensively when the column is absent or
    # the JSON is malformed (e.g. corrupt DB row after manual edit).
    models: list[str] = ["default"]
    if "models_json" in keys:
        raw_models = row["models_json"]
        if raw_models:
            try:
                parsed_models = json.loads(raw_models)
                if isinstance(parsed_models, list) and all(
                    isinstance(m, str) for m in parsed_models
                ):
                    models = parsed_models
                else:
                    logger.warning(
                        "Provider id=%s has malformed models_json (not a list[str]); "
                        'falling back to ["default"]',
                        row["id"],
                    )
            except (json.JSONDecodeError, TypeError):
                logger.warning(
                    "Provider id=%s has unparseable models_json=%r; "
                    'falling back to ["default"]',
                    row["id"],
                    raw_models,
                )

    default_model: str | None = None
    if "default_model" in keys:
        default_model = row["default_model"]

    raw_api_key = row["api_key"] if "api_key" in keys else None
    return Provider(
        id=row["id"],
        name=row["name"],
        display_name=row["display_name"],
        command_template=row["command_template"],
        default_args=row["default_args"],
        is_enabled=bool(row["is_enabled"]),
        color=row["color"] if "color" in keys else None,
        default_env=default_env,
        models=models,
        default_model=default_model,
        # Surface only a boolean — the cleartext secret never leaves the
        # sidecar. Writes go through PATCH with the new value.
        has_api_key=bool(raw_api_key),
        base_url=row["base_url"] if "base_url" in keys else None,
    )


def _row_to_model(row: aiosqlite.Row) -> ProviderModel:
    return ProviderModel(
        id=row["id"],
        provider_id=row["provider_id"],
        model_name=row["model_name"],
        display_name=row["display_name"],
        is_default=bool(row["is_default"]),
        is_enabled=bool(row["is_enabled"]),
    )


async def list_providers(
    db: aiosqlite.Connection,
    *,
    only_enabled: bool = True,
) -> list[Provider]:
    if only_enabled:
        cur = await db.execute(
            "SELECT * FROM providers WHERE is_enabled = 1 ORDER BY id ASC"
        )
    else:
        cur = await db.execute("SELECT * FROM providers ORDER BY id ASC")
    rows = await cur.fetchall()
    return [_row_to_provider(r) for r in rows]


async def get_provider(db: aiosqlite.Connection, provider_id: int) -> Provider:
    cur = await db.execute("SELECT * FROM providers WHERE id = ?", (provider_id,))
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="provider not found")
    return _row_to_provider(row)


async def get_provider_launch_config(
    db: aiosqlite.Connection, provider_id: int
) -> dict[str, Any]:
    """Return the UNMASKED launch config for a provider.

    Used by the Rust shell's scheduler to spawn ``claude`` for a scheduled run.
    Unlike the public ``Provider`` model (which exposes only ``has_api_key``),
    this includes the cleartext ``api_key`` so the shell can set
    ``ANTHROPIC_API_KEY``. It is served only over the localhost sidecar to the
    trusted shell process and is never sent to the WebView/frontend.
    """
    cur = await db.execute(
        "SELECT command_template, default_args, default_env_json, default_model, "
        "api_key, base_url FROM providers WHERE id = ?",
        (provider_id,),
    )
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="provider not found")
    default_env: dict[str, str] = {}
    try:
        parsed = json.loads(row["default_env_json"] or "{}")
        if isinstance(parsed, dict):
            default_env = {str(k): str(v) for k, v in parsed.items()}
    except (json.JSONDecodeError, TypeError):
        default_env = {}
    return {
        "command_template": row["command_template"],
        "default_args": row["default_args"],
        "default_env": default_env,
        "default_model": row["default_model"],
        "api_key": row["api_key"] or None,
        "base_url": row["base_url"] or None,
    }


async def list_models(
    db: aiosqlite.Connection,
    provider_id: int | None = None,
    *,
    only_enabled: bool = True,
) -> list[ProviderModel]:
    sql = "SELECT * FROM provider_models WHERE 1 = 1"
    params: list = []
    if provider_id is not None:
        sql += " AND provider_id = ?"
        params.append(provider_id)
    if only_enabled:
        sql += " AND is_enabled = 1"
    sql += " ORDER BY is_default DESC, id ASC"
    cur = await db.execute(sql, params)
    rows = await cur.fetchall()
    return [_row_to_model(r) for r in rows]


async def resolve_model_to_provider(db: aiosqlite.Connection, model: str) -> int | None:
    """Strict typed lookup: exact-match `model_name` → `provider_id`.

    Returns `None` when the model is not registered. Callers should leave
    `agent_sessions.provider_id` NULL in that case so the row falls into the
    synthetic "Unknown" bucket.
    """
    cur = await db.execute(
        "SELECT provider_id FROM provider_models WHERE model_name = ? LIMIT 1",
        (model,),
    )
    row = await cur.fetchone()
    return row["provider_id"] if row else None


# Legacy hardcoded fallback map (work/personal → known provider names).
# Only consulted when no profiles row carries the provider_id directly.
_PROFILE_TO_PROVIDER_NAME: dict[str, str] = {
    "work": "claude-work",
    "personal": "claude-personal",
}


async def resolve_profile_to_provider(
    db: aiosqlite.Connection, profile: str | None
) -> int | None:
    """Resolve a Claude Code profile name to a provider id.

    Resolution order (first match wins):
    1. Look up ``profiles.provider_id`` by name — authoritative for any
       alias the user entered during onboarding (e.g. "claude-work").
    2. Fall back to the hardcoded ``_PROFILE_TO_PROVIDER_NAME`` map for
       the legacy "work" / "personal" shorthands.

    This ensures that arbitrary aliases created during onboarding resolve
    to the correct provider at SESSION START, not just after the Stop hook.

    Returns ``None`` for unrecognised or ``None`` profiles so the caller can
    fall through to model-name resolution.
    """
    if not profile:
        return None
    # Primary: authoritative lookup via profiles.provider_id
    try:
        cur = await db.execute(
            "SELECT provider_id FROM profiles WHERE name = ? AND provider_id IS NOT NULL LIMIT 1",
            (profile,),
        )
        row = await cur.fetchone()
        if row and row["provider_id"] is not None:
            return int(row["provider_id"])
    except Exception:  # noqa: BLE001, S110
        # DB unavailable mid-migration — never block hook ingest.
        pass
    # Fallback: legacy hardcoded name map
    provider_name = _PROFILE_TO_PROVIDER_NAME.get(profile)
    if not provider_name:
        return None
    cur = await db.execute(
        "SELECT id FROM providers WHERE name = ? LIMIT 1",
        (provider_name,),
    )
    row = await cur.fetchone()
    return int(row["id"]) if row else None


_Window = Literal["today", "7d", "30d", "all"]


def _window_clause(since: _Window) -> str:
    """Return a SQL fragment usable in WHERE — datetime comparison vs now."""
    if since == "today":
        return "AND s.last_event_at >= datetime('now', 'start of day')"
    if since == "7d":
        return "AND s.last_event_at >= datetime('now', '-7 days')"
    if since == "30d":
        return "AND s.last_event_at >= datetime('now', '-30 days')"
    return ""


async def list_providers_with_stats(
    db: aiosqlite.Connection,
    since: _Window = "today",
) -> list[ProviderStats]:
    """Return per-provider session aggregates over the given window.

    Includes a synthetic "Unknown" entry (provider_id=None) when there are
    sessions with a non-NULL model that don't match any registered
    `provider_models.model_name`.
    """
    window = _window_clause(since)

    # Aggregate sessions per provider_id, with Unknown bucket when model is
    # set but not in the registry.
    sql = f"""
        SELECT
            s.provider_id AS provider_id,
            COUNT(*) AS sessions,
            SUM(CASE WHEN s.last_event_at >= datetime('now', 'start of day') THEN 1 ELSE 0 END) AS sessions_today,
            COALESCE(SUM(s.cost_usd), 0.0) AS cost_usd,
            COALESCE(SUM(s.tokens_in), 0) AS tokens_in,
            COALESCE(SUM(s.tokens_out), 0) AS tokens_out,
            COUNT(DISTINCT s.project_id) AS linked_projects,
            COUNT(DISTINCT s.task_id) AS linked_tasks
        FROM agent_sessions s
        WHERE 1 = 1 {window}
        GROUP BY s.provider_id
    """
    cur = await db.execute(sql)
    aggregates = {row["provider_id"]: dict(row) for row in await cur.fetchall()}

    # All providers (including disabled) so the sidebar can show them with
    # 0 counts; the UI hides disabled rows by default.
    providers = await list_providers(db, only_enabled=False)

    # Per-provider default model (display) for the sidebar subtitle.
    default_model_cur = await db.execute(
        "SELECT provider_id, display_name FROM provider_models WHERE is_default = 1"
    )
    defaults = {
        row["provider_id"]: row["display_name"]
        for row in await default_model_cur.fetchall()
    }

    out: list[ProviderStats] = []
    for p in providers:
        agg = aggregates.get(p.id, {})
        out.append(
            ProviderStats(
                provider_id=p.id,
                name=p.name,
                display_name=p.display_name,
                color=p.color,
                default_model=defaults.get(p.id),
                sessions=int(agg.get("sessions", 0)),
                sessions_today=int(agg.get("sessions_today", 0)),
                cost_usd=float(agg.get("cost_usd", 0.0)),
                tokens_in=int(agg.get("tokens_in", 0)),
                tokens_out=int(agg.get("tokens_out", 0)),
                linked_projects=int(agg.get("linked_projects", 0)),
                linked_tasks=int(agg.get("linked_tasks", 0)),
            )
        )

    # Synthetic Unknown bucket when sessions exist with no provider_id.
    if None in aggregates:
        agg = aggregates[None]
        out.append(
            ProviderStats(
                provider_id=None,
                name="unknown",
                display_name="Unknown",
                color="#7a8290",
                default_model=None,
                sessions=int(agg["sessions"]),
                sessions_today=int(agg["sessions_today"]),
                cost_usd=float(agg["cost_usd"]),
                tokens_in=int(agg["tokens_in"]),
                tokens_out=int(agg["tokens_out"]),
                linked_projects=int(agg["linked_projects"]),
                linked_tasks=int(agg["linked_tasks"]),
            )
        )

    return out


# ── Admin mutators ──────────────────────────────────────────────────────────


async def set_provider_enabled(
    db: aiosqlite.Connection, provider_id: int, is_enabled: bool
) -> Provider:
    await db.execute(
        "UPDATE providers SET is_enabled = ? WHERE id = ?",
        (1 if is_enabled else 0, provider_id),
    )
    await db.commit()
    return await get_provider(db, provider_id)


async def add_provider_model(
    db: aiosqlite.Connection,
    *,
    provider_id: int,
    model_name: str,
    display_name: str,
    is_default: bool = False,
) -> ProviderModel:
    if is_default:
        # Only one default per provider.
        await db.execute(
            "UPDATE provider_models SET is_default = 0 WHERE provider_id = ?",
            (provider_id,),
        )
    cur = await db.execute(
        """
        INSERT INTO provider_models (provider_id, model_name, display_name, is_default, is_enabled)
        VALUES (?, ?, ?, ?, 1)
        """,
        (provider_id, model_name, display_name, 1 if is_default else 0),
    )
    await db.commit()
    new_id = cur.lastrowid
    cur = await db.execute("SELECT * FROM provider_models WHERE id = ?", (new_id,))
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="failed to insert provider_model")
    return _row_to_model(row)


async def delete_provider_model(db: aiosqlite.Connection, model_id: int) -> None:
    await db.execute("DELETE FROM provider_models WHERE id = ?", (model_id,))
    await db.commit()


async def set_provider_models(
    db: aiosqlite.Connection,
    provider_id: int,
    models: list[dict],
) -> list[ProviderModel]:
    """Replace a provider's model set with ``models`` (idempotent).

    Each item is ``{model_name, display_name?, is_default?}``. Used by the
    onboarding provider step to set the three Claude tiers (Opus/Sonnet/Haiku)
    in one call: replacing rather than appending keeps a re-run from
    duplicating, and the whole set is rewritten so exactly one default is
    guaranteed. ``display_name`` falls back to ``model_name``; the default
    falls back to the first entry when none (or several) are flagged.

    Nothing references ``provider_models.id`` by FK (sessions key on
    ``provider_id``; lookups key on ``model_name``), so the delete-and-reinsert
    is safe. ``model_name`` is globally UNIQUE, so the replace is wrapped in a
    transaction and rolled back on any failure — a name already owned by another
    provider raises 409 without truncating this provider's existing set.
    """
    await get_provider(db, provider_id)  # 404 if the provider is missing

    cleaned: list[dict] = []
    for m in models:
        name = str(m.get("model_name") or "").strip()
        if not name:
            raise HTTPException(
                status_code=400, detail="model_name is required for every model"
            )
        cleaned.append(
            {
                "model_name": name,
                "display_name": str(m.get("display_name") or "").strip() or name,
                "is_default": bool(m.get("is_default")),
            }
        )
    if not cleaned:
        raise HTTPException(status_code=400, detail="at least one model is required")

    names = [m["model_name"] for m in cleaned]
    if len(names) != len(set(names)):
        raise HTTPException(
            status_code=400, detail="duplicate model_name in the provided set"
        )

    flagged = [i for i, m in enumerate(cleaned) if m["is_default"]]
    if len(flagged) > 1:
        raise HTTPException(status_code=400, detail="only one model may be the default")
    default_idx = flagged[0] if flagged else 0

    # provider_models.model_name is globally UNIQUE and the sidecar shares one
    # connection, so a mid-loop UNIQUE failure must not leave a half-written set
    # that a later unrelated commit would persist. Replace atomically.
    try:
        await db.execute(
            "DELETE FROM provider_models WHERE provider_id = ?", (provider_id,)
        )
        for i, m in enumerate(cleaned):
            await db.execute(
                "INSERT INTO provider_models "
                "(provider_id, model_name, display_name, is_default, is_enabled) "
                "VALUES (?, ?, ?, ?, 1)",
                (
                    provider_id,
                    m["model_name"],
                    m["display_name"],
                    1 if i == default_idx else 0,
                ),
            )
        await db.commit()
    except sqlite3.IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="a model_name is already registered to another provider",
        ) from exc
    except Exception:
        await db.rollback()
        raise
    return await list_models(db, provider_id, only_enabled=False)


# ── Full provider CRUD ──────────────────────────────────────────────────────


async def create_provider(db: aiosqlite.Connection, data: ProviderCreate) -> Provider:
    """Insert a new provider row; raises 409 on UNIQUE name conflict."""
    try:
        cur = await db.execute(
            """
            INSERT INTO providers (name, display_name, command_template, default_args,
                                   default_env_json, color, is_enabled, api_key, base_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.name,
                data.display_name,
                data.command_template,
                data.default_args,
                json.dumps(data.default_env),
                data.color,
                1 if data.is_enabled else 0,
                data.api_key,
                data.base_url,
            ),
        )
        await db.commit()
    except Exception as exc:
        if "UNIQUE" in str(exc).upper():
            raise HTTPException(
                status_code=409, detail=f"provider name '{data.name}' already exists"
            ) from exc
        raise
    new_id = cur.lastrowid
    return await get_provider(db, new_id)  # type: ignore[arg-type]


async def update_provider(
    db: aiosqlite.Connection, provider_id: int, data: ProviderUpdate
) -> Provider:
    """Partial update of a provider row (only non-None fields are changed)."""
    # Verify the row exists first.
    await get_provider(db, provider_id)

    updates: list[str] = []
    params: list = []

    if data.display_name is not None:
        updates.append("display_name = ?")
        params.append(data.display_name)
    if data.command_template is not None:
        updates.append("command_template = ?")
        params.append(data.command_template)
    if data.default_args is not None:
        updates.append("default_args = ?")
        params.append(data.default_args)
    if data.default_env is not None:
        updates.append("default_env_json = ?")
        params.append(json.dumps(data.default_env))
    if data.color is not None:
        updates.append("color = ?")
        params.append(data.color)
    if data.is_enabled is not None:
        updates.append("is_enabled = ?")
        params.append(1 if data.is_enabled else 0)
    if data.api_key is not None:
        # Convention: explicit "" clears the secret; anything truthy sets it;
        # `None` (the field absent) means "leave alone".
        updates.append("api_key = ?")
        params.append(data.api_key if data.api_key else None)
    if data.base_url is not None:
        updates.append("base_url = ?")
        params.append(data.base_url if data.base_url else None)

    if updates:
        params.append(provider_id)
        await db.execute(
            f"UPDATE providers SET {', '.join(updates)} WHERE id = ?",
            params,
        )
        await db.commit()

    return await get_provider(db, provider_id)


async def delete_provider(db: aiosqlite.Connection, provider_id: int) -> None:
    """Delete a provider row.

    Two tables carry the FK without any ``ON DELETE`` clause and would block the
    deletion: ``agent_sessions.provider_id`` (historical telemetry) and
    ``profiles.provider_id`` (default-provider hint).  We NULL those out so the
    rows survive — the provider is gone, but the sessions / profiles remain
    and simply fall back to the "Unknown" bucket / no default.

    Saved launch presets are not touched.  They used to be cascade-deleted
    through ``launch_presets.provider_id``, but migration
    ``008_launch_presets_drop_grid`` removed that column: a preset now names its
    providers inside ``panes_json``, and ``launch_preset_service`` reports each
    such pane as ``unresolved`` at read time rather than the preset vanishing.
    """
    await get_provider(db, provider_id)
    await db.execute(
        "UPDATE agent_sessions SET provider_id = NULL WHERE provider_id = ?",
        (provider_id,),
    )
    await db.execute(
        "UPDATE profiles SET provider_id = NULL WHERE provider_id = ?",
        (provider_id,),
    )
    await db.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
    await db.commit()
