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


class HookInstallEventPlan(BaseModel):
    """What the installer did, or would do, to one event's hook array.

    Reported for all 22 events whether or not anything changed, so a dry run
    reads as a complete account of the file rather than a diff the reader has
    to invert. The three ``left_*`` counts are the preservation receipt: they
    say how many hooks the installer looked at and then deliberately did not
    touch, and they are counts rather than contents because a third-party hook
    command is an arbitrary shell string that may carry a credential — the same
    rule ``app/models/effective_hooks.py`` states at length.
    """

    event: str
    action: str  # "ok" | "add" | "repair" | "conflict"
    repaired: int = 0  # ours-but-stale hooks rewritten in place
    left_narrow: int = 0  # ours, under a matcher we never mint; untouched
    left_foreign: int = 0  # somebody else's; untouched
    left_malformed: int = 0  # ours, but not wrapped in {matcher, hooks[]}
    detail: str | None = None


class HookInstallResult(BaseModel):
    """Outcome for one requested config home.

    ``status`` is ``applied`` (written), ``planned`` (a dry run that found
    work), ``unchanged`` (nothing to do — what every second run reports) or
    ``refused``. A refusal is never an HTTP error: an invalid, oversized,
    unwritable or unexpectedly shaped settings.json is a situation the UI has
    to explain, exactly as on the verify route.

    ``backup_path`` names the copy of the previous content taken immediately
    before the write. It is ``None`` when nothing was written and when the file
    did not exist to begin with.
    """

    config_home: str
    settings_path: str
    status: str  # "applied" | "planned" | "unchanged" | "refused"
    refusal: str | None = None
    changed: bool = False
    created_file: bool = False
    backup_path: str | None = None
    events: list[HookInstallEventPlan] = []


class HookInstallReport(BaseModel):
    """Response for the install and install-plan routes."""

    base_url: str
    dry_run: bool
    overall: str  # "applied" | "planned" | "unchanged" | "refused"
    results: list[HookInstallResult]


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
