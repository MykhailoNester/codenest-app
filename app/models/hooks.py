"""Pydantic response shapes for Claude Code hook verification + self-test.

Kept free of database imports so both the service and router layers can use
them. ``app/services/hooks_service.py`` returns plain dicts; the router wraps
them into these shapes on the way out — the pattern already used at
``app/routers/workspace.py`` for ``Workspace``.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class HookEventVerdict(BaseModel):
    """Per-event verdict from diffing settings.json against build_hook_settings()."""

    event: str
    status: str  # "ok" | "missing" | "mismatch" | "malformed"
    detail: str | None = None


class HookSettingsVerify(BaseModel):
    """Diff result for one requested config home's settings.json."""

    config_home: str
    settings_path: str
    # "ok" | "partial" | "absent" | "missing_file" | "invalid_json" | "unreadable"
    file_status: str
    detail: str | None = None
    events: list[HookEventVerdict]
    found_elsewhere: list[str] = []


class HookVerifyReport(BaseModel):
    """Response for ``POST /api/v1/workspace/hooks/verify``."""

    base_url: str
    expected_events: list[str]
    overall: str  # "ok" | "partial" | "absent" | "error"
    results: list[HookSettingsVerify]


class HookSelfTestMint(BaseModel):
    """Response for ``POST /api/v1/workspace/hooks/self-test`` (mint a token)."""

    token: str
    url: str
    max_time_seconds: int
    expires_in_seconds: int
    command: str


class HookSelfTestIngest(BaseModel):
    """Response for ``POST /api/v1/workspace/hooks/self-test/{token}``, the curl
    target. ``continue`` is a Python keyword, hence the alias."""

    model_config = ConfigDict(populate_by_name=True)

    continue_: bool = Field(alias="continue")
    recorded: bool


class HookSelfTestReceipt(BaseModel):
    """Response for ``GET /api/v1/workspace/hooks/self-test/{token}``, the receipt."""

    known: bool
    received: bool
    elapsed_ms: int | None = None
