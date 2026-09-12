"""Settings service.

Key/value store backed by the `app_settings` table. Each row holds a JSON
blob; callers pass the raw JSON string and we validate it parses on the
way in so we do not have to reparse defensively on every read.

The `get_lookups` aggregator returns the lists (statuses,
document_categories), their color maps, and the full profiles list in a
single payload — the frontend boots with one fetch.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime

import aiosqlite
from fastapi import HTTPException
from pydantic import BaseModel

from . import preauth_service, profile_service, taxonomy_service


class SettingPut(BaseModel):
    value_json: str


# ---------------------------------------------------------------------------
# Feature-toggle validation
# ---------------------------------------------------------------------------

# The canonical set of toggleable feature slugs.  Core features default ON;
# the rest default OFF so a fresh install starts with a minimal left nav and
# users opt in to extras (see the baseline `enabled_features` seed, which must
# stay in sync with ``_FEATURES_DEFAULT`` below).
KNOWN_FEATURES: frozenset[str] = frozenset(
    {
        "attention",  # Needs You — the attention queue (slug: attention)
        "work",  # Work board — tasks kanban with triage (slug: tasks)
        "notifications",  # Notifications page — existing event feed (slug: notifications)
        "schedules",  # Agent schedules (slug: schedules)
        "parallel",  # Parallel agent runs (slug: parallel)
        "preview",  # Dev-server preview pane (slug: preview)
        "feed",  # Activity feed (slug: feed)
        "budgets",  # Cost budgets (slug: budgets)
        "sync",  # Sync targets (slug: sync)
        "snippets",  # Snippet library (slug: library)
        "gallery",  # Template/agent gallery (slug: marketplace)
        "mcp",  # MCP servers (slug: mcp)
        "integrations",  # External integrations (slug: integrations)
        "plugins",  # Plugins (slug: plugins)
    }
)

# Slugs that used to be toggleable and are now unconditional parts of the
# Terminal page: ``composer`` (the native agent pane + composer, which is the
# default session surface) and ``explorer`` (the workspace navigator beside
# it). Accepted on write so an existing install — whose stored
# ``enabled_features`` still carries them, seeded by
# ``000_baseline_schema.sql`` — can PUT its map back without a 422, but never
# echoed by the reader below, which merges only ``KNOWN_FEATURES``. A genuine
# typo is still rejected.
_RETIRED_FEATURES: frozenset[str] = frozenset({"composer", "explorer"})

# Default payload used when the ``enabled_features`` setting is absent. Core
# modules (plus Schedules) are ON; the remaining extras are OFF (hidden from
# the left nav) until the user enables them in Settings → Features. Keep in
# sync with the baseline seed.
_FEATURES_DEFAULT: dict[str, bool] = {
    # ON by default: after the #153 pivot the attention queue is the point of
    # the app, and a landing surface nobody can find because it ships off is
    # not shipped.
    "attention": True,
    "work": True,
    "notifications": True,
    "parallel": True,
    "preview": True,
    "budgets": True,
    "schedules": True,
    "snippets": False,
    "gallery": False,
    "feed": False,
    "mcp": False,
    "integrations": False,
    "plugins": False,
    "sync": False,
}


def _validate_features_setting(value_json: str) -> None:
    """Raise HTTP 422 if ``enabled_features`` is not a valid slug→bool map."""
    try:
        value = json.loads(value_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"invalid JSON: {exc.msg}") from exc

    if not isinstance(value, dict):
        raise HTTPException(
            status_code=422,
            detail="enabled_features must be an object mapping feature slugs to booleans",
        )

    unknown = set(value.keys()) - KNOWN_FEATURES - _RETIRED_FEATURES
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"unknown feature slug(s): {', '.join(sorted(unknown))}",
        )

    for k, v in value.items():
        if not isinstance(v, bool):
            raise HTTPException(
                status_code=422,
                detail=f"enabled_features.{k} must be a boolean",
            )


# ---------------------------------------------------------------------------
# Terminal setting validation
# ---------------------------------------------------------------------------

# Boolean terminal keys: stored as JSON 0 or 1.
_TERMINAL_BOOL_KEYS = frozenset(
    {
        "terminal.copy_on_select",
        "terminal.paste_confirm_multiline",
        "terminal.cwd_follow",
    }
)


def _validate_terminal_setting(key: str, value_json: str) -> None:
    """Raise HTTP 422 if a ``terminal.*`` key fails domain validation."""
    try:
        value = json.loads(value_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"invalid JSON: {exc.msg}") from exc

    if key == "terminal.font_size":
        try:
            size = int(value)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=422,
                detail="terminal.font_size must be an integer",
            )
        if size < 9 or size > 24:
            raise HTTPException(
                status_code=422,
                detail="terminal.font_size must be between 9 and 24",
            )

    elif key == "terminal.scrollback":
        try:
            lines = int(value)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=422,
                detail="terminal.scrollback must be an integer",
            )
        if lines < 1000 or lines > 100_000:
            raise HTTPException(
                status_code=422,
                detail="terminal.scrollback must be between 1000 and 100000",
            )

    elif key == "terminal.shell":
        if not isinstance(value, str):
            raise HTTPException(
                status_code=422,
                detail="terminal.shell must be a string (path or empty string)",
            )
        # Empty string means "use $SHELL" — always allowed.
        if value and not os.path.isfile(value):
            raise HTTPException(
                status_code=422,
                detail=f"terminal.shell path does not exist: {value}",
            )

    elif key in _TERMINAL_BOOL_KEYS:
        if value not in (0, 1):
            raise HTTPException(
                status_code=422,
                detail=f"{key} must be 0 or 1",
            )
    # terminal.font_family — free-form string; no additional constraints.


# ---------------------------------------------------------------------------
# CRUD helpers
# ---------------------------------------------------------------------------


def _row_to_dict(row: aiosqlite.Row) -> dict:
    return {
        "key": row["key"],
        "value_json": row["value_json"],
        "updated_at": row["updated_at"],
    }


async def list_settings(db: aiosqlite.Connection) -> list[dict]:
    rows = await db.execute("SELECT * FROM app_settings ORDER BY key")
    return [_row_to_dict(r) for r in await rows.fetchall()]


async def get_setting(db: aiosqlite.Connection, key: str) -> dict:
    row = await db.execute("SELECT * FROM app_settings WHERE key = ?", (key,))
    r = await row.fetchone()
    if not r:
        raise HTTPException(status_code=404, detail=f"setting '{key}' not found")
    return _row_to_dict(r)


async def upsert_setting(db: aiosqlite.Connection, key: str, value_json: str) -> dict:
    try:
        json.loads(value_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"invalid JSON: {exc.msg}") from exc
    if key.startswith("terminal."):
        _validate_terminal_setting(key, value_json)
    if key == "enabled_features":
        _validate_features_setting(value_json)
    if key == preauth_service.SETTING_KEY:
        # The pre-authorisation rule set is reachable through this generic
        # writer as well as its own endpoint, and it is the one setting whose
        # contents are executed as a decision on a hook's critical path. It
        # gets the same validation either way, and the hook path's in-process
        # cache is invalidated below whichever door the write came through.
        preauth_service.validate_rules_json(value_json)
    now = datetime.now(UTC).replace(tzinfo=None).isoformat(timespec="seconds")
    await db.execute(
        """INSERT INTO app_settings (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at""",
        (key, value_json, now),
    )
    await db.commit()
    if key == preauth_service.SETTING_KEY:
        preauth_service.invalidate_cache()
    return await get_setting(db, key)


async def _read_json_setting(
    db: aiosqlite.Connection, key: str, default: object
) -> object:
    row = await db.execute("SELECT value_json FROM app_settings WHERE key = ?", (key,))
    r = await row.fetchone()
    if not r:
        return default
    try:
        return json.loads(r["value_json"])
    except json.JSONDecodeError:
        return default


async def get_lookups(db: aiosqlite.Connection) -> dict:
    # Workflow vocabulary (task statuses/priorities + inbox statuses) is sourced
    # from the `taxonomies` table — the single source of truth edited under
    # Settings → Workflow Labels. The legacy `statuses`/`status_colors` keys are
    # derived from it (instead of the retired app_settings.task_statuses) so the
    # board, list view, dropdowns, and badges all agree on labels/colours/order.
    task_status_rows = await taxonomy_service.list_by_kind(db, "task_status")
    task_priority_rows = await taxonomy_service.list_by_kind(db, "task_priority")
    inbox_status_rows = await taxonomy_service.list_by_kind(db, "workflow_status")

    def _to_vocab(rows: list[dict]) -> list[dict]:
        return [
            {
                "slug": r["slug"],
                "label": r["display_name"],
                "color": r["color"],
                "sort_order": r["sort_order"],
            }
            for r in rows
        ]

    workflow_task_statuses = _to_vocab(task_status_rows)
    workflow_task_priorities = _to_vocab(task_priority_rows)
    workflow_inbox_statuses = _to_vocab(inbox_status_rows)

    # Legacy shape kept for the list-view status filter + New Task form, now
    # derived from the taxonomy rather than read from app_settings.
    statuses = [r["slug"] for r in task_status_rows]
    status_colors = {r["slug"]: r["color"] for r in task_status_rows if r["color"]}
    document_categories = await _read_json_setting(db, "document_categories", [])
    document_category_colors = await _read_json_setting(
        db, "document_category_colors", {}
    )
    # WIP limits: task-status slug -> positive card-count cap; a missing key
    # means "no limit". Stored as a hand-editable JSON app_setting, so the
    # coercion below drops anything that isn't a non-bool positive int —
    # a hand-edited `0`, a negative number, a string, or `true` can't crash
    # the board that reads this map.
    raw_wip = await _read_json_setting(db, "board_wip_limits", {})
    board_wip_limits: dict[str, int] = {}
    if isinstance(raw_wip, dict):
        for wip_key, wip_value in raw_wip.items():
            if (
                isinstance(wip_key, str)
                and isinstance(wip_value, int)
                and not isinstance(wip_value, bool)
                and wip_value >= 1
            ):
                board_wip_limits[wip_key] = wip_value
    profiles = await profile_service.list_profiles(db)
    # `wizard.completed` is stored as a JSON string ("true"/"false"). Surfacing
    # the boolean here keeps the first-run gate as a free read on the existing
    # bootstrap call instead of a separate round-trip.
    wizard_completed = await _read_json_setting(db, "wizard.completed", "false")
    # `enabled_features` — global hard gate for feature modules.  When absent
    # the default is all-on so existing installs behave identically to before
    # migration 046.
    raw_features = await _read_json_setting(db, "enabled_features", _FEATURES_DEFAULT)
    # Coerce to a full dict: merge stored values on top of all-true defaults so
    # newly added features are implicitly enabled on existing installs.
    enabled_features: dict[str, bool] = {**_FEATURES_DEFAULT}
    if isinstance(raw_features, dict):
        for k, v in raw_features.items():
            if k in KNOWN_FEATURES and isinstance(v, bool):
                enabled_features[k] = v
    # User identity — editable display name and role shown in the sidebar
    # footer.  Defaults keep the app usable before the user configures them.
    user_display_name = await _read_json_setting(db, "user_display_name", "Operator")
    user_role = await _read_json_setting(db, "user_role", "Owner")
    return {
        "statuses": statuses,
        "status_colors": status_colors,
        "workflow_task_statuses": workflow_task_statuses,
        "workflow_task_priorities": workflow_task_priorities,
        "workflow_inbox_statuses": workflow_inbox_statuses,
        "document_categories": document_categories,
        "document_category_colors": document_category_colors,
        "board_wip_limits": board_wip_limits,
        "profiles": profiles,
        "wizard_completed": wizard_completed == "true",
        "enabled_features": enabled_features,
        "user_display_name": user_display_name
        if isinstance(user_display_name, str)
        else "Operator",
        "user_role": user_role if isinstance(user_role, str) else "Owner",
    }
